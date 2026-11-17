//! Les modèles distants : des fournisseurs compatibles avec l'API OpenAI (llama.cpp, Ollama, LM Studio…), appelés
//! par la partie Rust (jamais par l'interface : la CSP ne change pas), en streaming SSE.
//!
//! settings.json garde `providers: [{ id, name, url, models: [{ id, temperature?, topP?, maxTokens?, contextLength? }] }]`.
//! La clé d'un fournisseur n'y est jamais : elle est dans le Gestionnaire d'identification de Windows.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::store::{self, Result};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Le délai maximal sans rien recevoir du serveur (en-têtes, puis entre deux morceaux). En debug,
/// NELCODE_REMOTE_TIMEOUT_MS le remplace (tests).
fn idle_timeout() -> Duration {
    #[cfg(debug_assertions)]
    if let Some(ms) = std::env::var("NELCODE_REMOTE_TIMEOUT_MS").ok().and_then(|v| v.parse().ok()) {
        return Duration::from_millis(ms);
    }
    Duration::from_secs(120)
}

// ---------------------------------------------------------------------------------------------------------
// Clés : Gestionnaire d'identification de Windows (identifiants génériques « NelCode:provider:<id> »)

mod creds {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Security::Credentials::{CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW, CredWriteW};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }

    fn target(id: &str) -> Vec<u16> {
        wide(&format!("NelCode:provider:{id}"))
    }

    pub fn write(id: &str, key: &str) -> Result<(), String> {
        let (mut target, mut user) = (target(id), wide("NelCode"));
        let blob = key.as_bytes();
        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            Comment: std::ptr::null_mut(),
            LastWritten: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: user.as_mut_ptr(),
        };
        if unsafe { CredWriteW(&cred, 0) } == 0 {
            return Err(format!("Gestionnaire d'identification : clé non enregistrée ({})", std::io::Error::last_os_error()));
        }
        Ok(())
    }

    pub fn read(id: &str) -> Option<String> {
        let target = target(id);
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) } == 0 {
            return None;
        }
        let key = unsafe {
            let c = &*cred;
            let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize);
            String::from_utf8_lossy(bytes).into_owned()
        };
        unsafe { CredFree(cred as *const _) };
        Some(key)
    }

    pub fn delete(id: &str) {
        let target = target(id);
        unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    }
}


// ---------------------------------------------------------------------------------------------------------
// Fournisseurs

fn providers() -> Vec<Value> {
    store::load_settings()["providers"].as_array().cloned().unwrap_or_default()
}

fn save_providers(list: Vec<Value>) -> Result<()> {
    let mut change = Map::new();
    change.insert("providers".into(), list.into());
    store::save_settings(&change).map(|_| ())
}

fn find(id: &str) -> Result<Value> {
    providers().into_iter().find(|p| p["id"] == id).ok_or_else(|| format!("fournisseur inconnu : {id}"))
}

fn new_id() -> String {
    let mut b = [0u8; 6];
    getrandom::fill(&mut b).expect("générateur aléatoire du système");
    format!("p{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

/// L'adresse de base de l'API : `http(s)://hôte[:port]/v1` (sans `/` final ; `/v1` ajouté s'il n'y a pas de chemin,
/// `/chat/completions` ou `/models` retirés s'ils y sont).
pub fn normalize_url(url: &str) -> Result<String> {
    let mut u = url.trim().trim_end_matches('/').to_string();
    for tail in ["/chat/completions", "/models"] {
        if let Some(s) = u.strip_suffix(tail) {
            u = s.to_string();
        }
    }
    let parsed = reqwest::Url::parse(&u).map_err(|e| format!("adresse invalide : {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("l'adresse doit commencer par http:// ou https://".into());
    }
    if parsed.path().is_empty() || parsed.path() == "/" {
        u += "/v1";
    }
    Ok(u)
}

/// Les fournisseurs, avec `hasKey` (une clé est rangée pour lui).
pub fn list() -> Vec<Value> {
    providers()
        .into_iter()
        .map(|mut p| {
            p["hasKey"] = p["id"].as_str().and_then(creds::read).is_some().into();
            p
        })
        .collect()
}

/// Crée ou modifie un fournisseur. `key` : nouvelle clé (vide : retirée ; absente : inchangée).
pub fn save(id: Option<String>, name: &str, url: &str, key: Option<&str>) -> Result<Value> {
    let name = name.trim();
    if name.is_empty() {
        return Err("donne un nom au fournisseur".into());
    }
    let url = normalize_url(url)?;
    let mut list = providers();
    let id = id.filter(|i| list.iter().any(|p| p["id"] == i.as_str())).unwrap_or_else(new_id);
    match list.iter_mut().find(|p| p["id"] == id.as_str()) {
        Some(p) => {
            p["name"] = name.into();
            p["url"] = url.into();
        }
        None => list.push(json!({ "id": id, "name": name, "url": url, "models": [] })),
    }
    match key.map(str::trim) {
        Some("") => creds::delete(&id),
        Some(k) => creds::write(&id, k)?,
        None => {}
    }
    save_providers(list)?;
    crate::log::info(&format!("fournisseur « {name} » enregistré"));
    let mut p = find(&id)?;
    p["hasKey"] = creds::read(&id).is_some().into();
    Ok(p)
}

pub fn delete(id: &str) -> Result<()> {
    let mut list = providers();
    list.retain(|p| p["id"] != id);
    creds::delete(id);
    save_providers(list)
}

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| format!("{h}{}", u.port().map(|p| format!(":{p}")).unwrap_or_default()))).unwrap_or_else(|| url.into())
}

fn client() -> Result<reqwest::Client> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder().user_agent("NelCode").connect_timeout(CONNECT_TIMEOUT).build().map_err(|e| e.to_string())
}

/// Le message d'erreur d'un serveur : `error.message`, `error` (Ollama), ou le début du texte.
fn server_message(body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let m = v["error"]["message"].as_str().or(v["error"].as_str()).or(v["message"].as_str()).map(str::to_string);
    m.unwrap_or_else(|| body.chars().take(200).collect()).trim().to_string()
}

/// Un message clair pour une erreur HTTP.
fn http_error(host: &str, model: Option<&str>, status: u16, body: &str) -> String {
    let msg = server_message(body);
    let msg = if msg.is_empty() { String::new() } else { format!(" : {msg}") };
    match (status, model) {
        (401 | 403, _) => format!("clé refusée par {host} (HTTP {status}{msg})"),
        (404, Some(m)) => format!("le modèle « {m} » n'existe pas ou est arrêté sur {host} (HTTP 404{msg})"),
        (503, Some(m)) => format!("le modèle « {m} » est arrêté ou en cours de chargement sur {host} (HTTP 503{msg})"),
        _ => format!("{host} a refusé la requête (HTTP {status}{msg})"),
    }
}

fn send_error(host: &str, e: &reqwest::Error) -> String {
    if e.is_connect() || e.is_timeout() {
        format!("{host} ne répond pas : vérifie l'adresse, le réseau et que le serveur est lancé")
    } else {
        format!("{host} : {e}")
    }
}

/// « Tester » : GET {url}/models ; la liste des modèles est gardée (les réglages des modèles déjà connus aussi).
pub async fn test(id: &str) -> Result<Vec<String>> {
    let p = find(id)?;
    let url = p["url"].as_str().unwrap_or_default().to_string();
    let host = host_of(&url);
    let mut req = client()?.get(format!("{url}/models")).timeout(idle_timeout().min(Duration::from_secs(30)));
    if let Some(k) = creds::read(id) {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.map_err(|e| send_error(&host, &e))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| send_error(&host, &e))?;
    if status != 200 {
        return Err(http_error(&host, None, status, &body));
    }
    let v: Value = serde_json::from_str(&body).map_err(|_| format!("{host} : la réponse de /models n'est pas du JSON (est-ce bien une API OpenAI ?)"))?;
    // OpenAI, llama.cpp, LM Studio : { data: [{ id }] } ; Ollama (/api/tags par erreur) : { models: [{ name }] }.
    let ids: Vec<String> = v["data"]
        .as_array()
        .or(v["models"].as_array())
        .ok_or_else(|| format!("{host} : pas de liste de modèles dans la réponse de /models"))?
        .iter()
        .filter_map(|m| m["id"].as_str().or(m["name"].as_str()).map(str::to_string))
        .collect();
    let mut list = providers();
    if let Some(p) = list.iter_mut().find(|p| p["id"] == id) {
        let old = p["models"].as_array().cloned().unwrap_or_default();
        p["models"] = ids.iter().map(|m| old.iter().find(|o| o["id"] == m.as_str()).cloned().unwrap_or_else(|| json!({ "id": m }))).collect();
    }
    save_providers(list)?;
    crate::log::info(&format!("fournisseur {host} : {} modèle(s)", ids.len()));
    Ok(ids)
}

// ---------------------------------------------------------------------------------------------------------
// Import depuis Qwen Code (~/.qwen/settings.json, modelProviders.openai)

fn qwen_dir() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(d) = std::env::var_os("NELCODE_QWEN_DIR") {
        return PathBuf::from(d);
    }
    PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join(".qwen")
}

/// `NOM=valeur` d'un fichier .env (guillemets retirés).
fn dotenv(text: &str, name: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let (k, v) = l.trim().trim_start_matches("export ").split_once('=')?;
        (k.trim() == name).then(|| v.trim().trim_matches(['"', '\'']).to_string())
    })
}

/// Crée les fournisseurs (un par adresse) et les réglages de chaque modèle de `modelProviders.openai`. La clé
/// (`envKey`) est cherchée dans `env` de settings.json, dans ~/.qwen/.env, puis dans l'environnement ; elle va
/// dans le Gestionnaire d'identification. Un fournisseur à la même adresse est complété, pas dupliqué.
pub fn import_qwen() -> Result<Value> {
    let path = qwen_dir().join("settings.json");
    let text = std::fs::read_to_string(&path).map_err(|_| format!("{} introuvable : Qwen Code n'est pas configuré sur ce PC", path.display()))?;
    let q: Value = serde_json::from_str(&text).map_err(|e| format!("{} illisible : {e}", path.display()))?;
    let openai = &q["modelProviders"]["openai"];
    // Le format actuel est une liste ; une préversion l'enveloppait dans { models: [...] }.
    let entries = openai.as_array().or(openai["models"].as_array()).cloned().unwrap_or_default();
    if entries.is_empty() {
        return Err("aucun modèle dans modelProviders.openai de Qwen Code".into());
    }
    let env_file = std::fs::read_to_string(qwen_dir().join(".env")).unwrap_or_default();
    let mut list = providers();
    let (mut created, mut models, mut keys) = (0, 0, 0);
    for e in &entries {
        let (Some(model), Some(base)) = (e["id"].as_str(), e["baseUrl"].as_str()) else { continue };
        let Ok(url) = normalize_url(base) else { continue };
        let i = match list.iter().position(|p| p["url"] == url.as_str()) {
            Some(i) => i,
            None => {
                list.push(json!({ "id": new_id(), "name": host_of(&url), "url": url, "models": [] }));
                created += 1;
                list.len() - 1
            }
        };
        let g = &e["generationConfig"];
        let sp = &g["samplingParams"];
        let mut m = json!({ "id": model });
        for (to, v) in [
            ("temperature", &sp["temperature"]),
            ("topP", &sp["top_p"]),
            ("maxTokens", if sp["max_tokens"].is_null() { &sp["max_completion_tokens"] } else { &sp["max_tokens"] }),
            ("contextLength", &g["contextWindowSize"]),
        ] {
            if v.is_number() {
                m[to] = v.clone();
            }
        }
        if let Some(label) = e["name"].as_str() {
            m["label"] = label.into();
        }
        let p = &mut list[i];
        let ms = p["models"].as_array_mut().unwrap();
        ms.retain(|o| o["id"] != model);
        ms.push(m);
        models += 1;
        let env_key = e["envKey"].as_str().unwrap_or("OPENAI_API_KEY");
        let key = q["env"][env_key].as_str().map(str::to_string).or_else(|| dotenv(&env_file, env_key)).or_else(|| std::env::var(env_key).ok());
        if let (Some(key), Some(id)) = (key.filter(|k| !k.is_empty()), p["id"].as_str()) {
            creds::write(id, &key)?;
            keys += 1;
        }
    }
    save_providers(list)?;
    crate::log::info(&format!("import depuis Qwen Code : {created} fournisseur(s), {models} modèle(s)"));
    Ok(json!({ "providers": created, "models": models, "keys": keys, "path": path }))
}

// ---------------------------------------------------------------------------------------------------------
// Réflexion : balises <think>…</think> au début du texte

/// Sépare au fil de l'eau la réflexion `<think>…</think>` (au début de la réponse) du reste. Une balise coupée entre
/// deux morceaux est attendue avant d'être décidée.
#[derive(Default)]
pub struct ThinkSplit {
    state: u8, // 0 : début (pas encore décidé), 1 : dans <think>, 2 : réponse
    buf: String,
}

const OPEN: &str = "<think>";
const CLOSE: &str = "</think>";

impl ThinkSplit {
    /// Rend (réflexion, réponse) à afficher pour ce morceau.
    pub fn feed(&mut self, text: &str) -> (String, String) {
        self.buf.push_str(text);
        let (mut think, mut answer) = (String::new(), String::new());
        loop {
            match self.state {
                0 => {
                    let t = self.buf.trim_start();
                    if let Some(rest) = t.strip_prefix(OPEN) {
                        self.buf = rest.to_string();
                        self.state = 1;
                    } else if OPEN.starts_with(t) {
                        return (think, answer); // peut-être le début de <think> : on attend
                    } else {
                        self.state = 2;
                    }
                }
                1 => {
                    if let Some(i) = self.buf.find(CLOSE) {
                        think.push_str(&self.buf[..i]);
                        self.buf = self.buf[i + CLOSE.len()..].trim_start().to_string();
                        self.state = 2;
                    } else {
                        // Garde la fin qui pourrait être le début de </think>.
                        let keep = (1..CLOSE.len()).rev().find(|&n| self.buf.len() >= n && self.buf.is_char_boundary(self.buf.len() - n) && CLOSE.starts_with(&self.buf[self.buf.len() - n..])).unwrap_or(0);
                        let cut = self.buf.len() - keep;
                        think.push_str(&self.buf[..cut]);
                        self.buf = self.buf[cut..].to_string();
                        return (think, answer);
                    }
                }
                _ => {
                    answer.push_str(&std::mem::take(&mut self.buf));
                    return (think, answer);
                }
            }
        }
    }

    /// La fin du texte : ce qui attendait encore.
    pub fn finish(&mut self) -> (String, String) {
        let rest = std::mem::take(&mut self.buf);
        if self.state == 1 { (rest, String::new()) } else { (String::new(), rest) }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Génération

/// Les tours précédents qui tiennent dans `context` tokens (estimés à 4 caractères par token), les plus récents.
pub fn fit(history: &[(String, String)], message: &str, context: Option<u64>, reserve: u64) -> Vec<Value> {
    let est = |s: &str| s.chars().count() as u64 / 4 + 4;
    let budget = context.map_or(u64::MAX, |c| c.saturating_sub(reserve));
    let mut used = est(message);
    let mut turns = Vec::new();
    for (q, a) in history.iter().rev() {
        let n = est(q) + est(a);
        if used + n > budget {
            break;
        }
        used += n;
        turns.push((q, a));
    }
    let mut msgs: Vec<Value> = turns.into_iter().rev().flat_map(|(q, a)| [json!({ "role": "user", "content": q }), json!({ "role": "assistant", "content": a })]).collect();
    msgs.push(json!({ "role": "user", "content": message }));
    msgs
}

/// Un tour de conversation avec le serveur : le texte, la réflexion, les outils demandés (`tool_calls` au format
/// OpenAI, arguments réassemblés), et si Stop l'a interrompu.
#[derive(Default)]
pub struct Turn {
    pub content: String,
    pub reasoning: String,
    pub reasoning_seconds: Option<f64>,
    pub tool_calls: Vec<Value>,
    pub tokens: usize,
    pub stopped: bool,
}

/// Le fournisseur `provider_id` : (adresse, hôte pour les messages, modèle et ses réglages).
pub fn provider(provider_id: &str, model: &str) -> Result<(String, String, Value)> {
    let p = find(provider_id)?;
    let url = p["url"].as_str().unwrap_or_default().to_string();
    let m = p["models"].as_array().and_then(|ms| ms.iter().find(|x| x["id"] == model).cloned()).unwrap_or_default();
    Ok((host_of(&url), url, m))
}

/// Le corps d'une requête de chat : modèle, messages, streaming, et les réglages du modèle (sinon `sampling`).
pub fn chat_body(model: &str, settings: &Value, messages: Vec<Value>, sampling: (f32, f32)) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "stream_options": { "include_usage": true },
        "temperature": settings["temperature"].as_f64().unwrap_or(sampling.0 as f64),
        "top_p": settings["topP"].as_f64().unwrap_or(sampling.1 as f64),
    });
    if let Some(n) = settings["maxTokens"].as_u64() {
        body["max_tokens"] = n.into();
    }
    body
}

/// Envoie `body` à {url}/chat/completions et lit la réponse en streaming SSE : le texte part dans « gen-token », la
/// réflexion dans « gen-reasoning ». `cancel` (Stop) ferme la connexion tout de suite.
pub async fn stream_chat(app: &AppHandle, provider_id: &str, url: &str, body: &Value, cancel: &Notify) -> Result<Turn> {
    let host = host_of(url);
    let model = body["model"].as_str().unwrap_or_default().to_string();
    let mut req = client()?.post(format!("{url}/chat/completions")).json(body);
    if let Some(k) = creds::read(provider_id) {
        req = req.bearer_auth(k);
    }
    let timeout = idle_timeout();
    let late = || format!("{host} n'a rien envoyé depuis {} s : délai dépassé (le modèle est peut-être arrêté ou surchargé)", timeout.as_secs_f64().round());
    let mut turn = Turn::default();

    let mut resp = tokio::select! {
        r = tokio::time::timeout(timeout, req.send()) => match r {
            Err(_) => return Err(late()),
            Ok(Err(e)) => return Err(send_error(&host, &e)),
            Ok(Ok(r)) => r,
        },
        _ = cancel.notified() => { turn.stopped = true; return Ok(turn); }
    };
    let status = resp.status().as_u16();
    if status != 200 {
        let text = resp.text().await.unwrap_or_default();
        // Un modèle sans outils (Ollama : « does not support tools », llama.cpp sans --jinja…).
        if !body["tools"].is_null() && (400..600).contains(&status) && server_message(&text).to_lowercase().contains("tool") {
            return Err(format!(
                "le modèle « {model} » ne gère pas les outils (tool calling) : le mode Agent demande par exemple llama.cpp lancé avec --jinja, ou Ollama avec Qwen3 ({host}, HTTP {status} : {})",
                server_message(&text)
            ));
        }
        return Err(http_error(&host, Some(&model), status, &text));
    }
    let sse = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|c| c.contains("text/event-stream"));
    let (mut think_start, mut think_end) = (None::<Instant>, None::<Instant>);
    let mut split = ThinkSplit::default();
    let mut emit = |turn: &mut Turn, reasoning: &str, content: &str| {
        let (t, a) = split.feed(content);
        let thought = format!("{reasoning}{t}");
        if !thought.is_empty() {
            think_start.get_or_insert_with(Instant::now);
            turn.reasoning.push_str(&thought);
            let _ = app.emit("gen-reasoning", json!({ "text": thought }));
        }
        if !a.is_empty() {
            if think_start.is_some() {
                think_end.get_or_insert_with(Instant::now);
            }
            turn.content.push_str(&a);
            let _ = app.emit("gen-token", json!({ "text": a, "side": "" }));
        }
    };
    // Les outils demandés arrivent par morceaux : { index, id, function: { name, arguments } }.
    let mut calls: Vec<Value> = Vec::new();
    let mut add_calls = |deltas: &Value| {
        for d in deltas.as_array().into_iter().flatten() {
            let i = d["index"].as_u64().map_or(calls.len(), |i| i as usize);
            while calls.len() <= i {
                calls.push(json!({ "id": "", "type": "function", "function": { "name": "", "arguments": "" } }));
            }
            let c = &mut calls[i];
            if let Some(id) = d["id"].as_str() {
                c["id"] = id.into();
            }
            let f = &d["function"];
            if let Some(n) = f["name"].as_str() {
                c["function"]["name"] = (c["function"]["name"].as_str().unwrap_or_default().to_string() + n).into();
            }
            let args = match &f["arguments"] {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                v => v.to_string(), // certains serveurs envoient un objet
            };
            c["function"]["arguments"] = (c["function"]["arguments"].as_str().unwrap_or_default().to_string() + &args).into();
        }
    };
    let mut buf: Vec<u8> = Vec::new();
    let mut whole = String::new();
    let mut pieces = 0; // les morceaux reçus : le nombre de tokens si le serveur ne donne pas `usage`
    'read: loop {
        let chunk = tokio::select! {
            r = tokio::time::timeout(timeout, resp.chunk()) => match r {
                Err(_) => return Err(late()),
                Ok(Err(_)) => return Err(format!("la connexion avec {host} a été coupée pendant la réponse")),
                Ok(Ok(c)) => c,
            },
            _ = cancel.notified() => { turn.stopped = true; break 'read; }
        };
        let Some(chunk) = chunk else { break };
        if !sse {
            whole.push_str(&String::from_utf8_lossy(&chunk));
            continue;
        }
        buf.extend_from_slice(&chunk);
        while let Some(i) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=i).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" {
                break 'read;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if !v["error"].is_null() {
                return Err(format!("{host} : {}", server_message(data)));
            }
            if let Some(n) = v["usage"]["completion_tokens"].as_u64() {
                turn.tokens = n as usize;
            }
            let d = &v["choices"][0]["delta"];
            add_calls(&d["tool_calls"]);
            let reasoning = d["reasoning_content"].as_str().or(d["reasoning"].as_str()).unwrap_or_default();
            let content = d["content"].as_str().unwrap_or_default();
            if !reasoning.is_empty() || !content.is_empty() {
                pieces += 1;
                emit(&mut turn, reasoning, content);
            }
        }
    }
    // Un serveur qui ignore `stream` : la réponse entière, en JSON.
    if !sse && !turn.stopped {
        let v: Value = serde_json::from_str(&whole).map_err(|_| format!("{host} : réponse illisible ({})", whole.chars().take(120).collect::<String>()))?;
        let msg = &v["choices"][0]["message"];
        let reasoning = msg["reasoning_content"].as_str().or(msg["reasoning"].as_str()).unwrap_or_default().to_string();
        emit(&mut turn, &reasoning, msg["content"].as_str().unwrap_or_default());
        let full: Vec<Value> = msg["tool_calls"].as_array().cloned().unwrap_or_default().into_iter().enumerate().map(|(i, mut c)| { c["index"] = i.into(); c }).collect();
        add_calls(&Value::Array(full));
        turn.tokens = v["usage"]["completion_tokens"].as_u64().unwrap_or(0) as usize;
    }
    let (t, a) = split.finish();
    if !t.is_empty() {
        turn.reasoning.push_str(&t);
        let _ = app.emit("gen-reasoning", json!({ "text": t }));
    }
    if !a.is_empty() {
        turn.content.push_str(&a);
        let _ = app.emit("gen-token", json!({ "text": a, "side": "" }));
    }
    if let Some(s) = think_start {
        turn.reasoning_seconds = Some(think_end.unwrap_or_else(Instant::now).duration_since(s).as_secs_f64());
    }
    if turn.tokens == 0 {
        turn.tokens = pieces;
    }
    turn.tool_calls = calls.into_iter().filter(|c| !c["function"]["name"].as_str().unwrap_or_default().is_empty()).collect();
    Ok(turn)
}

/// Écrit la réponse de `model` chez le fournisseur `provider_id` (une conversation simple, sans outils).
pub async fn generate(app: &AppHandle, provider_id: &str, model: &str, history: &[(String, String)], message: &str, sampling: (f32, f32), cancel: Arc<Notify>) -> Result<Turn> {
    let (_, url, m) = provider(provider_id, model)?;
    let messages = fit(history, message, m["contextLength"].as_u64(), m["maxTokens"].as_u64().unwrap_or(1024));
    stream_chat(app, provider_id, &url, &chat_body(model, &m, messages, sampling), &cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&str]) -> (String, String) {
        let mut s = ThinkSplit::default();
        let (mut t, mut a) = (String::new(), String::new());
        for c in chunks {
            let (x, y) = s.feed(c);
            t += &x;
            a += &y;
        }
        let (x, y) = s.finish();
        (t + &x, a + &y)
    }

    #[test]
    fn balises_think() {
        assert_eq!(run(&["<think>je ré", "fléchis</think>\n\nRéponse"]), ("je réfléchis".into(), "Réponse".into()));
        // Balises coupées entre deux morceaux.
        assert_eq!(run(&["  <th", "ink>a</thi", "nk>b"]), ("a".into(), "b".into()));
        assert_eq!(run(&["<", "think>x<", "/think>y"]), ("x".into(), "y".into()));
        // Pas de réflexion : tout est la réponse, même un « < » au début.
        assert_eq!(run(&["<", "div>"]), ("".into(), "<div>".into()));
        assert_eq!(run(&["Bonjour <think>pas au début</think>"]), ("".into(), "Bonjour <think>pas au début</think>".into()));
        // Réflexion jamais fermée (réponse coupée).
        assert_eq!(run(&["<think>longue réflexion"]), ("longue réflexion".into(), "".into()));
        assert_eq!(run(&["<think>é</th", "ink>ü"]), ("é".into(), "ü".into()));
    }

    #[test]
    fn adresses() {
        assert_eq!(normalize_url("http://10.5.33.228:11434/v1/").unwrap(), "http://10.5.33.228:11434/v1");
        assert_eq!(normalize_url("http://localhost:11434").unwrap(), "http://localhost:11434/v1");
        assert_eq!(normalize_url(" https://h/v1/chat/completions ").unwrap(), "https://h/v1");
        assert_eq!(normalize_url("http://h:1234/api/v1/models").unwrap(), "http://h:1234/api/v1");
        assert!(normalize_url("ftp://h").is_err() && normalize_url("pas une adresse").is_err());
        assert_eq!(host_of("http://10.5.33.228:11434/v1"), "10.5.33.228:11434");
    }

    #[test]
    fn messages_dans_le_contexte() {
        let h: Vec<(String, String)> = (0..10).map(|i| (format!("q{i} {}", "x".repeat(400)), "r".repeat(400))).collect();
        let all = fit(&h, "dernier", None, 0);
        assert_eq!(all.len(), 21);
        let few = fit(&h, "dernier", Some(300), 50); // un tour ≈ 209 tokens estimés
        assert_eq!(few.len(), 3, "un seul tour tient");
        assert_eq!(few[0]["content"].as_str().unwrap()[..2], *"q9");
        assert_eq!(few.last().unwrap()["content"], "dernier");
    }

    #[test]
    fn gestionnaire_d_identification() {
        let id = format!("test-{}", new_id());
        assert_eq!(creds::read(&id), None);
        creds::write(&id, "sk-secret-é").unwrap();
        assert_eq!(creds::read(&id).as_deref(), Some("sk-secret-é"));
        creds::write(&id, "sk-2").unwrap();
        assert_eq!(creds::read(&id).as_deref(), Some("sk-2"));
        creds::delete(&id);
        assert_eq!(creds::read(&id), None);
    }

    #[test]
    fn fichier_env() {
        assert_eq!(dotenv("A=1\nexport OPENAI_API_KEY=\"sk-x\"\n", "OPENAI_API_KEY").as_deref(), Some("sk-x"));
        assert_eq!(dotenv("B=1", "OPENAI_API_KEY"), None);
    }
}
