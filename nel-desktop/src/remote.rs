//! Les modèles distants : des fournisseurs compatibles avec l'API OpenAI (llama.cpp, Ollama, LM Studio…), appelés
//! par la partie Rust (jamais par l'interface : la CSP ne change pas), en streaming SSE.
//!
//! settings.json garde `providers: [{ id, name, url, kind?, omitSampling?, models: [{ id, temperature?, topP?, maxTokens?,
//! contextLength? }] }]`. `kind: "anthropic"` : l'API Claude (couche compatible OpenAI d'Anthropic) ; `omitSampling` :
//! ne jamais envoyer temperature ni top_p (les modèles Claude récents les refusent).
//! La clé d'un fournisseur n'y est jamais : elle est dans le trousseau du système (voir `creds`).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::images::{self, Attached};
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
// Clés : le trousseau du système (crate keyring). Windows : Gestionnaire d'identification, identifiants génériques
// « NelCode:provider:<id> » (les mêmes qu'avant : les clés existantes restent lues) ; macOS : trousseau (service
// « NelCode », compte « provider:<id> ») ; Linux : Secret Service (GNOME Keyring, KWallet…), mêmes noms.

pub(crate) mod creds {
    use std::collections::HashMap;

    use keyring_core::{Entry, Error};

    use crate::os;

    /// Avec NELCODE_HOME (tests), un espace à part par dossier de données, pour que les tests ne touchent jamais aux
    /// vraies clés de l'utilisateur. Fixé au premier appel.
    fn account(id: &str) -> String {
        static NS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        let ns = NS.get_or_init(|| {
            std::env::var("NELCODE_HOME").map_or(String::new(), |h| {
                let hash = h.bytes().fold(0xcbf2_9ce4_8422_2325u64, |x, b| (x ^ b as u64).wrapping_mul(0x0100_0000_01b3));
                format!("test-{hash:016x}:")
            })
        });
        format!("{ns}provider:{id}")
    }

    /// Sous Windows, la cible exacte d'avant (« NelCode:<compte> », persistance locale, utilisateur « NelCode »).
    pub(super) fn windows_target(id: &str) -> String {
        format!("NelCode:{}", account(id))
    }

    fn entry(id: &str) -> Result<Entry, String> {
        let store = os::CURRENT.keystore();
        if let Err(e) = keyring::Entry::store_status() {
            return Err(format!("{store} indisponible : {e}"));
        }
        let r = if cfg!(windows) {
            let target = windows_target(id);
            Entry::new_with_modifiers("NelCode", "NelCode", &HashMap::from([("target", target.as_str()), ("persistence", "Local")]))
        } else {
            Entry::new("NelCode", &account(id))
        };
        r.map_err(|e| format!("{store} : {e}"))
    }

    pub fn write(id: &str, key: &str) -> Result<(), String> {
        // En octets (UTF-8) : sous Windows, les clés rangées avant le sont ainsi.
        entry(id)?.set_secret(key.as_bytes()).map_err(|e| format!("{} : clé non enregistrée ({e})", os::CURRENT.keystore()))
    }

    pub fn read(id: &str) -> Option<String> {
        match entry(id).ok()?.get_secret() {
            Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
            Err(Error::NoEntry) => None,
            Err(e) => {
                crate::log::error(&format!("{} : clé illisible ({e})", os::CURRENT.keystore()));
                None
            }
        }
    }

    pub fn delete(id: &str) {
        if let Ok(e) = entry(id) {
            let _ = e.delete_credential();
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Fournisseurs

fn providers() -> Vec<Value> {
    store::load_settings()["providers"].as_array().cloned().unwrap_or_default()
}

/// Modifie la liste des fournisseurs sous le verrou des réglages (lue, changée et réécrite d'un coup : deux
/// modifications en même temps ne s'écrasent pas).
fn update_providers<T>(change: impl FnOnce(&mut Vec<Value>) -> Result<T>) -> Result<T> {
    store::update_settings(|s| {
        let mut list = s["providers"].as_array().cloned().unwrap_or_default();
        let out = change(&mut list)?;
        s["providers"] = list.into();
        Ok(out)
    })
    .map(|(_, out)| out)
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
/// La version d'API envoyée à l'API native d'Anthropic (liste des modèles).
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// `max_tokens` envoyé à Claude quand le modèle n'en a pas de réglé (réponse en streaming : pas de délai HTTP).
const ANTHROPIC_MAX_TOKENS: u64 = 64_000;

pub fn is_anthropic(p: &Value) -> bool {
    p["kind"] == "anthropic"
}

/// Crée ou modifie un fournisseur. `key` : nouvelle clé (vide : retirée ; absente : inchangée). `kind` et
/// `omit_sampling` : absents, inchangés (à la création : OpenAI, avec temperature/top_p).
pub fn save_with(id: Option<String>, name: &str, url: &str, key: Option<&str>, kind: Option<&str>, omit_sampling: Option<bool>) -> Result<Value> {
    let p = save(id, name, url, key)?;
    let pid = p["id"].as_str().unwrap_or_default().to_string();
    update_providers(|list| {
        if let Some(q) = list.iter_mut().find(|q| q["id"] == pid.as_str()) {
            if let Some(k) = kind {
                q["kind"] = if k == "anthropic" { "anthropic".into() } else { Value::Null };
                if k != "anthropic" {
                    q.as_object_mut().unwrap().remove("kind");
                }
            }
            if let Some(o) = omit_sampling {
                q["omitSampling"] = o.into();
            }
        }
        Ok(())
    })?;
    let mut p = find(&pid)?;
    p["hasKey"] = creds::read(&pid).is_some().into();
    Ok(p)
}

pub fn save(id: Option<String>, name: &str, url: &str, key: Option<&str>) -> Result<Value> {
    let name = name.trim();
    if name.is_empty() {
        return Err("donne un nom au fournisseur".into());
    }
    let url = normalize_url(url)?;
    let id = update_providers(|list| {
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
        Ok(id)
    })?;
    crate::log::info(&format!("fournisseur « {name} » enregistré"));
    let mut p = find(&id)?;
    p["hasKey"] = creds::read(&id).is_some().into();
    Ok(p)
}

pub fn delete(id: &str) -> Result<()> {
    update_providers(|list| {
        list.retain(|p| p["id"] != id);
        Ok(())
    })?;
    creds::delete(id);
    Ok(())
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
    // L'API d'Anthropic : la liste des modèles est sur son API native (x-api-key, anthropic-version, 1000 au plus).
    let anthropic = is_anthropic(&p);
    let models = if anthropic { format!("{url}/models?limit=1000") } else { format!("{url}/models") };
    let mut req = client()?.get(models).timeout(idle_timeout().min(Duration::from_secs(30)));
    if let Some(k) = creds::read(id) {
        if anthropic {
            req = req.header("x-api-key", &k).header("anthropic-version", ANTHROPIC_VERSION);
        }
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
    update_providers(|list| {
        if let Some(p) = list.iter_mut().find(|p| p["id"] == id) {
            let old = p["models"].as_array().cloned().unwrap_or_default();
            // La détection des images est refaite au prochain choix du modèle ; le réglage manuel reste.
            p["models"] = ids
                .iter()
                .map(|m| old.iter().find(|o| o["id"] == m.as_str()).cloned().map(|mut o| { o.as_object_mut().map(|x| x.remove("visionDetected")); o }).unwrap_or_else(|| json!({ "id": m })))
                .collect();
        }
        Ok(())
    })?;
    crate::log::info(&format!("fournisseur {host} : {} modèle(s)", ids.len()));
    Ok(ids)
}

// ---------------------------------------------------------------------------------------------------------
// Modèles qui voient les images (images.rs) : la détection est gardée (`visionDetected`), le réglage manuel (`vision`)
// passe avant.

/// Détecte (si ce n'est pas déjà fait, ou `again`) si `model` voit les images. Rend { vision, detected, manual }.
pub async fn vision(provider_id: &str, model: &str, again: bool) -> Result<Value> {
    let (_, _, mut m, p) = provider(provider_id, model)?;
    let mut detected = m["visionDetected"].as_bool();
    if (again || m.get("visionDetected").is_none()) && p["models"].as_array().is_some_and(|ms| ms.iter().any(|x| x["id"] == model)) {
        detected = images::detect(&p, model, &client()?, creds::read(provider_id)).await;
        update_providers(|list| {
            if let Some(x) = list.iter_mut().find(|q| q["id"] == provider_id).and_then(|q| q["models"].as_array_mut()).and_then(|ms| ms.iter_mut().find(|x| x["id"] == model)) {
                x["visionDetected"] = detected.into();
            }
            Ok(())
        })?;
        m["visionDetected"] = detected.into();
    }
    Ok(json!({ "vision": images::effective(&m), "detected": detected, "manual": m["vision"].as_bool() }))
}

/// Le réglage manuel d'un modèle : voit les images (true), ne les voit pas (false), ou automatique (None).
pub fn set_vision(provider_id: &str, model: &str, value: Option<bool>) -> Result<()> {
    update_providers(|list| {
        let x = list.iter_mut().find(|q| q["id"] == provider_id).and_then(|q| q["models"].as_array_mut()).and_then(|ms| ms.iter_mut().find(|x| x["id"] == model)).ok_or_else(|| format!("modèle inconnu : {model}"))?;
        match value {
            Some(v) => x["vision"] = v.into(),
            None => {
                x.as_object_mut().map(|o| o.remove("vision"));
            }
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------------------------------------
// Import depuis Qwen Code (~/.qwen/settings.json, modelProviders.openai)

fn qwen_dir() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(d) = std::env::var_os("NELCODE_QWEN_DIR") {
        return PathBuf::from(d);
    }
    crate::os::home().unwrap_or_default().join(".qwen")
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
    let (created, models, keys) = update_providers(|list| {
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
        Ok((created, models, keys))
    })?;
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

/// Les tours précédents qui tiennent dans `context` tokens (estimés à 4 caractères par token, et l'estimation de
/// chaque image), les plus récents. Les messages avec des images ont un `content` en tableau (images.rs).
pub fn fit(history: &[(String, String)], message: &str, images: &Attached, context: Option<u64>, reserve: u64) -> Vec<Value> {
    let est = |s: &str| s.chars().count() as u64 / 4 + 4;
    let pictures = |files: &[String]| files.iter().take(images::MAX_PER_MESSAGE).map(|f| images::file_tokens(&images.session, f)).sum::<u64>();
    let budget = context.map_or(u64::MAX, |c| c.saturating_sub(reserve));
    let mut used = est(message) + pictures(&images.message);
    let mut turns = Vec::new();
    for (i, (q, a)) in history.iter().enumerate().rev() {
        let n = est(q) + est(a) + pictures(images.of_turn(i));
        if used + n > budget {
            break;
        }
        used += n;
        turns.push((i, q, a));
    }
    let mut msgs: Vec<Value> = turns
        .into_iter()
        .rev()
        .flat_map(|(i, q, a)| [json!({ "role": "user", "content": images::user_content(&images.session, q, images.of_turn(i)) }), json!({ "role": "assistant", "content": a })])
        .collect();
    msgs.push(json!({ "role": "user", "content": images::user_content(&images.session, message, &images.message) }));
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
    /// Les tokens d'entrée (`usage.prompt_tokens`, sinon estimés à 4 caractères par token).
    pub prompt_tokens: usize,
    pub stopped: bool,
}

/// Les tokens d'entrée estimés d'un corps de requête (4 caractères par token, et l'estimation de chaque image), quand
/// le serveur ne donne pas `usage`.
pub fn estimate_prompt(body: &Value) -> usize {
    let len = |v: &Value| match v {
        Value::Null => 0,
        Value::String(s) => s.chars().count(),
        v => v.to_string().chars().count(),
    };
    let chars: usize = body["messages"].as_array().into_iter().flatten().map(|m| if m["content"].is_array() { 0 } else { len(&m["content"]) } + len(&m["tool_calls"])).sum::<usize>() + len(&body["tools"]);
    let parts: u64 = body["messages"].as_array().into_iter().flatten().filter(|m| m["content"].is_array()).map(|m| images::content_tokens(&m["content"])).sum();
    chars.div_ceil(4) + parts as usize
}

/// Le fournisseur `provider_id` : (hôte pour les messages, adresse, modèle et ses réglages, le fournisseur).
pub fn provider(provider_id: &str, model: &str) -> Result<(String, String, Value, Value)> {
    let p = find(provider_id)?;
    let url = p["url"].as_str().unwrap_or_default().to_string();
    let m = p["models"].as_array().and_then(|ms| ms.iter().find(|x| x["id"] == model).cloned()).unwrap_or_default();
    Ok((host_of(&url), url, m, p))
}

/// Le corps d'une requête de chat : modèle, messages, streaming, et les réglages du modèle (sinon `sampling`).
/// Avec `omitSampling` (Claude), ni temperature ni top_p. Pour Claude, un `max_tokens` par défaut.
pub fn chat_body(provider: &Value, model: &str, settings: &Value, messages: Vec<Value>, sampling: (f32, f32)) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if provider["omitSampling"] != true {
        body["temperature"] = settings["temperature"].as_f64().unwrap_or(sampling.0 as f64).into();
        body["top_p"] = settings["topP"].as_f64().unwrap_or(sampling.1 as f64).into();
    }
    match settings["maxTokens"].as_u64() {
        Some(n) => body["max_tokens"] = n.into(),
        None if is_anthropic(provider) => body["max_tokens"] = ANTHROPIC_MAX_TOKENS.into(),
        None => {}
    }
    body
}

/// Envoie `body` à {url}/chat/completions et lit la réponse en streaming SSE : le texte part dans « gen-token », la
/// réflexion dans « gen-reasoning ». `cancel` (Stop) ferme la connexion tout de suite.
pub async fn stream_chat(app: &AppHandle, provider_id: &str, url: &str, body: &Value, cancel: &Notify) -> Result<Turn> {
    stream(app, provider_id, url, body, cancel, true).await
}

/// Comme `stream_chat`, sans rien envoyer à l'interface (les explorateurs du mode Agent : leur texte n'est pas la réponse).
pub async fn stream_chat_quiet(app: &AppHandle, provider_id: &str, url: &str, body: &Value, cancel: &Notify) -> Result<Turn> {
    stream(app, provider_id, url, body, cancel, false).await
}

async fn stream(app: &AppHandle, provider_id: &str, url: &str, body: &Value, cancel: &Notify, live: bool) -> Result<Turn> {
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
            if live {
                let _ = app.emit("gen-reasoning", json!({ "text": thought }));
            }
        }
        if !a.is_empty() {
            if think_start.is_some() {
                think_end.get_or_insert_with(Instant::now);
            }
            turn.content.push_str(&a);
            if live {
                let _ = app.emit("gen-token", json!({ "text": a, "side": "" }));
            }
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
            if let Some(n) = v["usage"]["prompt_tokens"].as_u64() {
                turn.prompt_tokens = n as usize;
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
        turn.prompt_tokens = v["usage"]["prompt_tokens"].as_u64().unwrap_or(0) as usize;
    }
    let (t, a) = split.finish();
    if !t.is_empty() {
        turn.reasoning.push_str(&t);
        if live {
            let _ = app.emit("gen-reasoning", json!({ "text": t }));
        }
    }
    if !a.is_empty() {
        turn.content.push_str(&a);
        if live {
            let _ = app.emit("gen-token", json!({ "text": a, "side": "" }));
        }
    }
    if let Some(s) = think_start {
        turn.reasoning_seconds = Some(think_end.unwrap_or_else(Instant::now).duration_since(s).as_secs_f64());
    }
    if turn.tokens == 0 {
        turn.tokens = pieces;
    }
    if turn.prompt_tokens == 0 {
        turn.prompt_tokens = estimate_prompt(body);
    }
    turn.tool_calls = calls.into_iter().filter(|c| !c["function"]["name"].as_str().unwrap_or_default().is_empty()).collect();
    Ok(turn)
}

/// Écrit la réponse de `model` chez le fournisseur `provider_id` (une conversation simple, sans outils).
#[allow(clippy::too_many_arguments)]
pub async fn generate(app: &AppHandle, provider_id: &str, model: &str, history: &[(String, String)], message: &str, images: &Attached, sampling: (f32, f32), cancel: Arc<Notify>) -> Result<Turn> {
    let (_, url, m, p) = provider(provider_id, model)?;
    let messages = fit(history, message, images, m["contextLength"].as_u64(), m["maxTokens"].as_u64().unwrap_or(1024));
    stream_chat(app, provider_id, &url, &chat_body(&p, model, &m, messages, sampling), &cancel).await
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
        let none = Attached::default();
        let all = fit(&h, "dernier", &none, None, 0);
        assert_eq!(all.len(), 21);
        let few = fit(&h, "dernier", &none, Some(300), 50); // un tour ≈ 209 tokens estimés
        assert_eq!(few.len(), 3, "un seul tour tient");
        assert_eq!(few[0]["content"].as_str().unwrap()[..2], *"q9");
        assert_eq!(few.last().unwrap()["content"], "dernier");
    }

    /// Le trousseau du système (Gestionnaire d'identification, trousseau macOS, Secret Service).
    #[test]
    fn trousseau_du_systeme() {
        let id = format!("test-{}", new_id());
        assert_eq!(creds::read(&id), None);
        creds::write(&id, "sk-secret-é").unwrap();
        assert_eq!(creds::read(&id).as_deref(), Some("sk-secret-é"));
        creds::write(&id, "sk-2").unwrap();
        assert_eq!(creds::read(&id).as_deref(), Some("sk-2"));
        creds::delete(&id);
        assert_eq!(creds::read(&id), None);
    }

    /// Windows : une clé rangée par les versions d'avant keyring (CredWriteW, octets UTF-8, cible
    /// « NelCode:provider:<id> ») est lue, remplacée et retirée comme avant.
    #[cfg(windows)]
    #[test]
    fn cles_existantes_sous_windows() {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::Security::Credentials::{CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredReadW, CredFree, CredWriteW};
        let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
        let id = format!("test-{}", new_id());
        let (mut target, mut user) = (wide(&creds::windows_target(&id)), wide("NelCode"));
        let blob = "sk-ancienne-é".as_bytes();
        let cred = CREDENTIALW {
            Flags: 0, Type: CRED_TYPE_GENERIC, TargetName: target.as_mut_ptr(), Comment: std::ptr::null_mut(),
            LastWritten: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 }, CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_ptr() as *mut u8, Persist: CRED_PERSIST_LOCAL_MACHINE, AttributeCount: 0,
            Attributes: std::ptr::null_mut(), TargetAlias: std::ptr::null_mut(), UserName: user.as_mut_ptr(),
        };
        assert_ne!(unsafe { CredWriteW(&cred, 0) }, 0);
        assert_eq!(creds::read(&id).as_deref(), Some("sk-ancienne-é"));
        // Réécrite par keyring : toujours la même cible, en octets UTF-8, persistance locale.
        creds::write(&id, "sk-nouvelle").unwrap();
        let mut p: *mut CREDENTIALW = std::ptr::null_mut();
        assert_ne!(unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut p) }, 0);
        let (bytes, persist) = unsafe { (std::slice::from_raw_parts((*p).CredentialBlob, (*p).CredentialBlobSize as usize).to_vec(), (*p).Persist) };
        unsafe { CredFree(p as *const _) };
        assert_eq!(bytes, b"sk-nouvelle");
        assert_eq!(persist, CRED_PERSIST_LOCAL_MACHINE);
        creds::delete(&id);
        assert_eq!(creds::read(&id), None);
    }

    #[test]
    fn corps_sans_temperature_pour_claude() {
        let msgs = vec![json!({ "role": "user", "content": "a" })];
        let openai = chat_body(&json!({}), "m", &json!({}), msgs.clone(), (0.7, 0.9));
        assert_eq!((openai["temperature"].as_f64(), openai["top_p"].as_f64()), (Some(0.699999988079071), Some(0.8999999761581421)));
        assert!(openai.get("max_tokens").is_none());
        let claude = chat_body(&json!({ "kind": "anthropic", "omitSampling": true }), "claude-opus-5-5", &json!({ "temperature": 0.2 }), msgs.clone(), (0.7, 0.9));
        assert!(claude.get("temperature").is_none() && claude.get("top_p").is_none(), "jamais envoyés, même réglés sur le modèle");
        assert_eq!(claude["max_tokens"], 64_000);
        let reglé = chat_body(&json!({ "kind": "anthropic", "omitSampling": true }), "m", &json!({ "maxTokens": 500 }), msgs, (0.7, 0.9));
        assert_eq!(reglé["max_tokens"], 500);
    }

    #[test]
    fn tokens_d_entree_estimes() {
        let body = json!({ "messages": [{ "role": "user", "content": "x".repeat(40) }, { "role": "assistant", "content": null }] });
        assert_eq!(estimate_prompt(&body), 10);
        assert_eq!(estimate_prompt(&json!({})), 0);
    }

    #[test]
    fn fichier_env() {
        assert_eq!(dotenv("A=1\nexport OPENAI_API_KEY=\"sk-x\"\n", "OPENAI_API_KEY").as_deref(), Some("sk-x"));
        assert_eq!(dotenv("B=1", "OPENAI_API_KEY"), None);
    }
}
