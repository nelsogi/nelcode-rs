//! Le serveur local, compatible avec l'API OpenAI (désactivé par défaut) : GET /v1/models et POST /v1/chat/completions,
//! avec ou sans streaming (SSE). Il n'écoute que sur 127.0.0.1, et chaque requête doit porter la clé d'accès
//! (`Authorization: Bearer <clé>`, rangée dans le trousseau du système). Les erreurs sont en anglais, comme celles de
//! l'API OpenAI (les clients et les outils les attendent ainsi). HTTP/1.1 minimal : une requête par connexion, puis
//! fermeture.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::remote::creds;
use crate::{AppState, GenOptions, compare_model, current, log, store, text_stream};

pub const DEFAULT_PORT: u64 = 8765;
const MAX_BODY: usize = 8 << 20;
const MAX_HEADERS: usize = 64 << 10;

/// Le serveur en marche : son port ; l'arrêter (drop) attend la fin de son thread, le port est alors libre.
pub struct Running {
    pub port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Une nouvelle clé d'accès : « nc- » et 32 octets aléatoires en hexadécimal.
pub fn new_key() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("générateur aléatoire du système");
    format!("nc-{}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// La clé d'accès dans le trousseau du système.
const KEY_ID: &str = "local-server";

/// La clé d'accès (trousseau du système). Celle qu'une version d'avant la 1.0.0 gardait dans settings.json y est
/// d'abord déplacée, puis retirée du fichier.
pub fn key() -> Option<String> {
    if let Some(old) = store::load_settings()["serverKey"].as_str().filter(|k| !k.is_empty()) {
        match creds::write(KEY_ID, old) {
            Ok(()) => {
                let _ = store::update_settings(|s| {
                    if let Some(o) = s.as_object_mut() {
                        o.remove("serverKey");
                    }
                    Ok(())
                });
                log::info("serveur local : clé d'accès déplacée de settings.json vers le trousseau");
            }
            Err(e) => log::error(&format!("serveur local : clé d'accès non déplacée dans le trousseau ({e})")),
        }
    }
    creds::read(KEY_ID).filter(|k| !k.is_empty())
}

/// Range une nouvelle clé d'accès (l'ancienne est refusée dès la requête suivante).
pub fn set_key(key: &str) -> Result<(), String> {
    creds::write(KEY_ID, key)
}

/// Démarre (ou redémarre) le serveur selon les réglages, ou l'arrête s'il est désactivé ; une clé est créée à la
/// première activation. Rend le port actif (« server-changed » prévient l'interface).
pub fn apply(app: &AppHandle) -> Result<Option<u16>, String> {
    let state = app.state::<AppState>();
    let mut server = state.server.lock().unwrap();
    let settings = store::load_settings();
    let port = settings["serverPort"].as_u64().unwrap_or(DEFAULT_PORT) as u16;
    let enabled = settings["serverEnabled"].as_bool().unwrap_or(false);
    if enabled && key().is_none() {
        set_key(&new_key())?;
    }
    if enabled && server.as_ref().map(|s| s.port) == Some(port) {
        return Ok(Some(port));
    }
    if server.take().is_some() {
        log::info("serveur local arrêté");
    }
    let port = if enabled {
        match start(app, port) {
            Ok(r) => {
                let p = r.port;
                *server = Some(r);
                Some(p)
            }
            Err(e) => {
                log::error(&format!("serveur local : {e}"));
                let _ = app.emit("server-changed", json!({ "port": null, "error": e }));
                return Err(e);
            }
        }
    } else {
        None
    };
    let _ = app.emit("server-changed", json!({ "port": port }));
    Ok(port)
}

fn start(app: &AppHandle, port: u16) -> Result<Running, String> {
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("port {port} indisponible ({e})"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let (app, flag) = (app.clone(), stop.clone());
    let thread = std::thread::spawn(move || {
        // ponytail: accept non bloquant scruté toutes les 50 ms, pour s'arrêter sans connexion de réveil.
        while !flag.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((conn, _)) => {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        let _ = conn.set_nonblocking(false);
                        let _ = conn.set_read_timeout(Some(Duration::from_secs(30)));
                        handle(&app, conn);
                    });
                }
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    });
    log::info(&format!("serveur local démarré sur 127.0.0.1:{port}"));
    Ok(Running { port, stop, thread: Some(thread) })
}

struct Request {
    method: String,
    path: String,
    auth: Option<String>,
    body: Vec<u8>,
}

fn read_request(conn: &TcpStream) -> Result<Request, (u16, String)> {
    let bad = |m: &str| (400, m.to_string());
    let mut reader = BufReader::new(conn);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|_| bad("unreadable request"))?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
    let (mut length, mut auth, mut seen) = (0usize, None, line.len());
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).map_err(|_| bad("unreadable headers"))? == 0 {
            break;
        }
        seen += h.len();
        if seen > MAX_HEADERS {
            return Err((431, "request headers too large".into()));
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        let Some((k, v)) = h.split_once(':') else { continue };
        match k.trim().to_ascii_lowercase().as_str() {
            "content-length" => length = v.trim().parse().map_err(|_| bad("invalid Content-Length"))?,
            "authorization" => auth = Some(v.trim().to_string()),
            _ => {}
        }
    }
    if length > MAX_BODY {
        return Err((413, "request body too large".into()));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).map_err(|_| bad("incomplete request body"))?;
    Ok(Request { method, path: path.split('?').next().unwrap_or("").to_string(), auth, body })
}

fn respond(conn: &mut TcpStream, status: u16, body: &Value) {
    let text = body.to_string();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let _ = write!(conn, "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
}

/// Une erreur au format de l'API OpenAI.
fn error(conn: &mut TcpStream, status: u16, message: &str, kind: &str) {
    respond(conn, status, &json!({ "error": { "message": message, "type": kind, "code": null } }));
}

/// Compare deux chaînes en temps constant (la clé ne se devine pas octet par octet).
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn handle(app: &AppHandle, mut conn: TcpStream) {
    let req = match read_request(&conn) {
        Ok(r) => r,
        Err((status, m)) => return error(&mut conn, status, &m, "invalid_request_error"),
    };
    let key = key().unwrap_or_default();
    let given = req.auth.as_deref().and_then(|a| a.strip_prefix("Bearer ")).unwrap_or_default();
    if key.is_empty() || !same(given.trim(), &key) {
        return error(&mut conn, 401, "missing or incorrect access key (Authorization: Bearer <key from the Nel Code settings>)", "invalid_api_key");
    }
    match (req.method.as_str(), req.path.trim_end_matches('/')) {
        ("GET", "/v1/models") => {
            let created = now();
            let data: Vec<Value> = store::list_models().iter().map(|m| json!({ "id": m.name, "object": "model", "created": created, "owned_by": "nelcode" })).collect();
            respond(&mut conn, 200, &json!({ "object": "list", "data": data }));
        }
        ("POST", "/v1/chat/completions") => match serde_json::from_slice::<Value>(&req.body) {
            Ok(body) => chat(app, &mut conn, &body),
            Err(e) => error(&mut conn, 400, &format!("invalid JSON: {e}"), "invalid_request_error"),
        },
        (_, "/v1/models" | "/v1/chat/completions") => error(&mut conn, 405, "method not allowed", "invalid_request_error"),
        _ => error(&mut conn, 404, &format!("unknown path {} (only /v1/models and /v1/chat/completions)", req.path), "invalid_request_error"),
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

/// Le texte d'un message : une chaîne, ou une liste de parties `{ type: "text", text }` (les autres sont ignorées).
fn content_of(m: &Value) -> String {
    match &m["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// Les messages OpenAI en (tours précédents, dernier message). Les messages système sont mis en tête du dernier
/// message (ponytail: les modèles de Nel Code n'ont pas de place pour un message système à part ; à séparer si un
/// format de chat en a besoin). Le dernier message doit venir de l'utilisateur.
pub fn conversation(messages: &[Value]) -> Result<(Vec<(String, String)>, String), String> {
    let system: Vec<String> = messages.iter().filter(|m| m["role"] == "system" || m["role"] == "developer").map(content_of).collect();
    let rest: Vec<&Value> = messages.iter().filter(|m| m["role"] == "user" || m["role"] == "assistant").collect();
    let Some((last, before)) = rest.split_last() else { return Err("messages: no user message".into()) };
    if last["role"] != "user" {
        return Err("messages: the last message must come from the user".into());
    }
    let mut history = Vec::new();
    let mut question: Option<String> = None;
    for m in before {
        match (m["role"].as_str(), question.take()) {
            (Some("user"), Some(q)) => question = Some(q + "\n\n" + &content_of(m)),
            (Some("user"), None) => question = Some(content_of(m)),
            (Some("assistant"), Some(q)) => history.push((q, content_of(m))),
            (Some("assistant"), None) => {}
            _ => {}
        }
    }
    let mut message = content_of(last);
    if let Some(q) = question {
        message = q + "\n\n" + &message;
    }
    if !system.is_empty() {
        message = system.join("\n\n") + "\n\n" + &message;
    }
    Ok((history, message))
}

fn chat(app: &AppHandle, conn: &mut TcpStream, body: &Value) {
    let state = app.state::<AppState>();
    let (history, message) = match body["messages"].as_array().ok_or("messages is missing".to_string()).and_then(|m| conversation(m)) {
        Ok(c) => c,
        Err(e) => return error(conn, 400, &e, "invalid_request_error"),
    };
    // Le modèle demandé s'il est installé (chargé à côté au besoin, comme en comparaison), sinon celui de Nel Code.
    let asked = body["model"].as_str().unwrap_or_default();
    let installed = store::valid_name(asked) && store::list_models().iter().any(|m| m.name == asked);
    let model = if installed { compare_model(&state, asked).map(|m| (asked.to_string(), m)) } else { current(&state) };
    let (name, model) = match model {
        Ok(m) => m,
        Err(e) => return error(conn, 400, &format!("no model available ({e}): load a model in Nel Code, or ask for one listed by GET /v1/models"), "invalid_request_error"),
    };
    // Un seul calcul à la fois, avec l'interface comme avec les autres requêtes.
    if state.generating.swap(true, Ordering::SeqCst) {
        return error(conn, 503, "Nel Code is already writing a reply: try again in a moment", "server_error");
    }
    let settings = store::load_settings();
    let num = |k: &str| body[k].as_f64().or_else(|| settings[k].as_f64());
    let options = GenOptions {
        temperature: num("temperature").unwrap_or(0.8) as f32,
        top_k: settings["topK"].as_u64().unwrap_or(20) as usize,
        top_p: body["top_p"].as_f64().or_else(|| settings["topP"].as_f64()).unwrap_or(0.9) as f32,
        max_reply_tokens: settings["maxReplyTokens"].as_u64().unwrap_or(80) as usize,
        repetition_penalty: settings["repetitionPenalty"].as_f64().unwrap_or(1.15) as f32,
        transparency: false,
    };
    let mut sampling = options.sampling();
    if body["temperature"].as_f64().is_some_and(|t| t <= 0.0) {
        sampling.temperature = 0.0; // 0 : glouton, comme l'API OpenAI
    }
    let limit = body["max_completion_tokens"].as_u64().or_else(|| body["max_tokens"].as_u64()).map_or(usize::MAX, |n| n.max(1) as usize);
    let max = model.max_reply(options.max_reply_tokens).min(limit);
    let (prompt, _) = model.chat(&history, &message);
    let stream = body["stream"].as_bool().unwrap_or(false);
    let (id, created) = (format!("chatcmpl-{:x}", crate::seed()), now());
    let _ = app.emit("server-busy", true);
    let clock = std::time::Instant::now();
    log::info(&format!("serveur local : réponse avec « {name} » ({} tokens de prompt{})", prompt.len(), if stream { ", streaming" } else { "" }));

    let chunk = |delta: Value, finish: Value| {
        json!({ "id": id, "object": "chat.completion.chunk", "created": created, "model": name, "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] })
    };
    let result = if stream {
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
        let mut ok = conn.write_all(head.as_bytes()).is_ok();
        ok = ok && write!(conn, "data: {}\n\n", chunk(json!({ "role": "assistant", "content": "" }), Value::Null)).is_ok();
        // Le client parti (connexion fermée) : la génération s'arrête au token suivant.
        text_stream(&*model, &prompt, max, &sampling, false, |text, _| {
            ok = ok && (text.is_empty() || write!(conn, "data: {}\n\n", chunk(json!({ "content": text }), Value::Null)).is_ok());
            ok
        })
    } else {
        text_stream(&*model, &prompt, max, &sampling, false, |_, _| true)
    };
    state.generating.store(false, Ordering::SeqCst);
    let _ = app.emit("server-busy", false);
    match result {
        Ok(ids) => {
            crate::usage::record(crate::usage::Rec {
                project: "", provider: "local", model: &name, kind: "api", input: prompt.len() as u64, output: ids.len() as u64,
                seconds: clock.elapsed().as_secs_f64(), cost: None, local: true,
            });
            let finish = if ids.len() >= max { "length" } else { "stop" };
            if stream {
                let _ = write!(conn, "data: {}\n\ndata: [DONE]\n\n", chunk(json!({}), finish.into()));
            } else {
                respond(conn, 200, &json!({
                    "id": id, "object": "chat.completion", "created": created, "model": name,
                    "choices": [{ "index": 0, "message": { "role": "assistant", "content": model.decode(&ids) }, "finish_reason": finish }],
                    "usage": { "prompt_tokens": prompt.len(), "completion_tokens": ids.len(), "total_tokens": prompt.len() + ids.len() },
                }));
            }
        }
        Err(e) => {
            log::error(&format!("serveur local, génération : {e}"));
            if stream {
                let _ = write!(conn, "data: {}\n\n", json!({ "error": { "message": format!("generation failed: {e}"), "type": "server_error" } }));
            } else {
                error(conn, 500, &format!("generation failed: {e}"), "server_error");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs(v: Value) -> Vec<Value> {
        v.as_array().unwrap().clone()
    }

    #[test]
    fn messages_openai_en_tours() {
        let (h, m) = conversation(&msgs(json!([
            { "role": "system", "content": "Sois bref." },
            { "role": "user", "content": "Salut" },
            { "role": "assistant", "content": "Bonjour !" },
            { "role": "user", "content": [{ "type": "text", "text": "Et" }, { "type": "image_url" }, { "type": "text", "text": "toi ?" }] },
        ])))
        .unwrap();
        assert_eq!(h, vec![("Salut".to_string(), "Bonjour !".to_string())]);
        assert_eq!(m, "Sois bref.\n\nEt\ntoi ?");
        // Deux messages de l'utilisateur de suite : réunis ; un assistant sans question : ignoré.
        let (h, m) = conversation(&msgs(json!([{ "role": "assistant", "content": "x" }, { "role": "user", "content": "a" }, { "role": "user", "content": "b" }]))).unwrap();
        assert!(h.is_empty());
        assert_eq!(m, "a\n\nb");
        assert!(conversation(&msgs(json!([{ "role": "user", "content": "a" }, { "role": "assistant", "content": "b" }]))).is_err());
        assert!(conversation(&[]).is_err());
    }

    #[test]
    fn cles() {
        let (a, b) = (new_key(), new_key());
        assert!(a.starts_with("nc-") && a.len() == 67 && a != b);
        assert!(same(&a, &a.clone()) && !same(&a, &b) && !same(&a, "nc-"));
    }
}
