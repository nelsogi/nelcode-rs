//! Claude Agent : un type de conversation qui lance l'outil en ligne de commande `claude` d'Anthropic, installé sur le
//! PC, dans le dossier de travail (`-p --output-format stream-json --verbose --include-partial-messages`, puis
//! `--resume <session_id>`), et affiche son flux dans l'interface habituelle de Nel Code : texte au fil de l'eau,
//! chaque outil comme une étape, coût et durée à la fin.
//!
//! - Authentification par clé API seulement : ANTHROPIC_API_KEY, lue dans le Gestionnaire d'identification, est
//!   passée au processus ; les autres variables qui contiennent KEY, TOKEN ou SECRET ne le sont pas.
//! - Le message part sur l'entrée standard (jamais en argument : rien à échapper, même pour un claude.cmd).
//! - Mode de permission « default » (rien d'automatique : en -p, tout ce qui demande un accord est refusé) ou
//!   « acceptEdits », et `--allowedTools` (réglages).
//! - Stop : Ctrl+C sur la console du processus (SIGINT pour lui), puis attente de sa fin propre ; au-delà de 15 s,
//!   le processus et ses enfants sont tués (Job Object).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::agent::diff;
use crate::command::{Job, hidden_var, resume};
use crate::remote::creds;
use crate::store::{self, Result};

/// La clé API d'Anthropic de Claude Agent, dans le Gestionnaire d'identification.
pub const KEY_ID: &str = "claude-agent";
/// Où installer l'outil `claude` s'il manque.
pub const INSTALL_URL: &str = "https://code.claude.com/docs/en/setup";
/// L'argument caché qui fait de Nel Code l'envoyeur d'un Ctrl+C (voir `ctrl_c_helper`).
pub const CTRL_C_ARG: &str = "--nelcode-ctrl-c";
const STOP_GRACE: Duration = Duration::from_secs(15);
const MAX_DETAIL: usize = 20_000;
pub const PERMISSION_MODES: [&str; 2] = ["default", "acceptEdits"];

/// L'outil `claude` : claude.exe puis claude.cmd dans le PATH, sinon %USERPROFILE%\.local\bin\claude.exe (installeur
/// natif). En debug, NELCODE_CLAUDE_PATH le remplace (vide : introuvable ; tests).
pub fn find_cli() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("NELCODE_CLAUDE_PATH") {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        for name in ["claude.exe", "claude.cmd"] {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let local = PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join(".local").join("bin").join("claude.exe");
    local.is_file().then_some(local)
}

/// Un nom de modèle pour `--model` : alias (« opus », « sonnet ») ou id complet (« claude-opus-5-5[1m] »).
pub fn valid_model(m: &str) -> bool {
    !m.is_empty() && m.len() <= 100 && m.chars().all(|c| c.is_ascii_alphanumeric() || "-._[]".contains(c))
}

/// Mode de permission, outils autorisés, modèle (vide : celui de l'outil).
fn settings() -> (String, Vec<String>, String) {
    let s = store::load_settings();
    let mode = s["claudePermissionMode"].as_str().unwrap_or("default").to_string();
    let tools = s["claudeAllowedTools"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let model = s["claudeModel"].as_str().unwrap_or_default().to_string();
    (mode, tools, model)
}

/// Pour les réglages et le démarrage d'une conversation : l'outil trouvé, la clé, les réglages.
pub fn status() -> Value {
    let (mode, tools, model) = settings();
    json!({
        "cli": find_cli().map(|p| p.to_string_lossy().into_owned()),
        "installUrl": INSTALL_URL,
        "hasKey": creds::read(KEY_ID).is_some(),
        "permissionMode": mode,
        "allowedTools": tools,
        "model": model,
    })
}

pub fn save_key(key: &str) -> Result<()> {
    match key.trim() {
        "" => {
            creds::delete(KEY_ID);
            Ok(())
        }
        k => creds::write(KEY_ID, k),
    }
}

/// Les arguments de `claude` (le message part sur l'entrée standard).
pub fn args(session: Option<&str>, mode: &str, allowed: &[String], model: &str) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode"].iter().map(|s| s.to_string()).collect();
    a.push(if PERMISSION_MODES.contains(&mode) { mode.to_string() } else { "default".into() });
    let allowed: Vec<&str> = allowed.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
    if !allowed.is_empty() {
        a.push("--allowedTools".into());
        a.push(allowed.join(","));
    }
    if valid_model(model) {
        a.push("--model".into());
        a.push(model.to_string());
    }
    if let Some(s) = session.filter(|s| !s.is_empty()) {
        a.push("--resume".into());
        a.push(s.to_string());
    }
    a
}

/// Les variables d'environnement transmises à `claude` : ni secret (KEY, TOKEN, SECRET : CLAUDE_CODE_OAUTH_TOKEN,
/// ANTHROPIC_AUTH_TOKEN…), ni ANTHROPIC_* (ANTHROPIC_BASE_URL enverrait la clé ailleurs), ni CLAUDE_CODE_USE_*
/// (Bedrock, Vertex… : une autre authentification que la clé API).
fn passed_var(name: &str) -> bool {
    let n = name.to_uppercase();
    !hidden_var(&n) && !n.starts_with("ANTHROPIC_") && !n.starts_with("CLAUDE_CODE_USE_")
}

// ---------------------------------------------------------------------------------------------------------
// Stop : Ctrl+C

/// Exécuté par un Nel Code lancé avec `--nelcode-ctrl-c <pid>` : s'attache à la console du processus et y envoie
/// Ctrl+C (que Node, comme tout programme console, reçoit comme SIGINT). À part, pour ne jamais toucher à la console
/// du Nel Code principal.
pub fn ctrl_c_helper(pid: u32) -> i32 {
    use windows_sys::Win32::System::Console::{AttachConsole, CTRL_C_EVENT, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler};
    unsafe {
        FreeConsole();
        if AttachConsole(pid) == 0 {
            return 2;
        }
        SetConsoleCtrlHandler(None, 1); // ce processus ignore lui-même le Ctrl+C
        let ok = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) != 0;
        std::thread::sleep(Duration::from_millis(200));
        FreeConsole();
        if ok { 0 } else { 1 }
    }
}

fn send_ctrl_c(pid: u32) -> bool {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(exe) = std::env::current_exe() else { return false };
    Command::new(exe).args([CTRL_C_ARG, &pid.to_string()]).creation_flags(CREATE_NO_WINDOW).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

// ---------------------------------------------------------------------------------------------------------
// Le flux stream-json → les étapes de Nel Code

fn clip(s: &str) -> String {
    if s.len() <= MAX_DETAIL {
        return s.to_string();
    }
    let mut end = MAX_DETAIL;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… ({} octets de plus)", &s[..end], s.len() - end)
}

fn short(s: &str, n: usize) -> String {
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n { one } else { one.chars().take(n).collect::<String>() + "…" }
}

/// Le texte d'un résultat d'outil : une chaîne, ou des blocs { type: "text", text }.
fn content_text(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn diff_json(lines: Vec<(char, String)>) -> (Value, usize, usize) {
    let (a, r) = (lines.iter().filter(|l| l.0 == '+').count(), lines.iter().filter(|l| l.0 == '-').count());
    (lines.iter().map(|(c, l)| json!([c.to_string(), l])).collect(), a, r)
}

/// Traduit le flux de `claude` pour l'interface (mêmes événements que le mode Agent).
pub struct Translator<'a> {
    app: Option<&'a AppHandle>,
    root: PathBuf,
    pub request: String,
    pub steps: Vec<Value>,
    by_tool: HashMap<String, String>,
    /// L'étape Task/Agent du sous-agent qui a écrit la ligne en cours (champ « parent » des étapes créées).
    parent: Option<String>,
    /// Le texte du tour en cours (depuis la dernière étape).
    pub text: String,
    saw_delta: bool,
    pub reasoning: String,
    think: (Option<Instant>, Option<Instant>),
    pub plan: Value,
    pub session_id: Option<String>,
    pub result: Option<Value>,
}

impl<'a> Translator<'a> {
    pub fn new(app: Option<&'a AppHandle>, root: &Path, request: String) -> Self {
        Self { app, root: root.to_path_buf(), request, steps: Vec::new(), by_tool: HashMap::new(), parent: None, text: String::new(), saw_delta: false, reasoning: String::new(), think: (None, None), plan: Value::Null, session_id: None, result: None }
    }

    fn emit(&self, event: &str, payload: Value) {
        if let Some(app) = self.app {
            let _ = app.emit(event, payload);
        }
    }

    /// Un chemin du flux, relatif au dossier de travail s'il y est.
    fn rel(&self, p: &str) -> String {
        let path = Path::new(p);
        let root = self.root.to_string_lossy().trim_start_matches(r"\\?\").to_lowercase().replace('\\', "/");
        let full = path.to_string_lossy().replace('\\', "/");
        // Le dossier lui-même ou un chemin dedans, pas un voisin au nom plus long (C:/projet-bis pour C:/projet).
        match full.get(root.len()..) {
            Some(rest) if path.is_absolute() && full.to_lowercase().starts_with(&root) && (root.ends_with('/') || rest.is_empty() || rest.starts_with('/')) => rest.trim_start_matches('/').to_string(),
            _ => full,
        }
    }

    fn step(&mut self, mut s: Value) -> String {
        let id = format!("s{}", self.steps.len() + 1);
        s["id"] = id.clone().into();
        s["request"] = self.request.clone().into();
        if let Some(p) = &self.parent {
            s["parent"] = p.clone().into();
        }
        self.emit("agent-step", s.clone());
        self.steps.push(s);
        id
    }

    fn update(&mut self, id: &str, changes: Value) {
        if let Some(s) = self.steps.iter_mut().find(|s| s["id"] == id) {
            for (k, v) in changes.as_object().into_iter().flatten() {
                s[k] = v.clone();
            }
            let s = s.clone();
            self.emit("agent-step", s);
        }
    }

    fn add_text(&mut self, t: &str) {
        if self.think.0.is_some() && self.think.1.is_none() {
            self.think.1 = Some(Instant::now());
        }
        self.text.push_str(t);
        self.emit("gen-token", json!({ "text": t, "side": "" }));
    }

    /// Un outil demandé par Claude : une étape (sauf TodoWrite, qui devient le plan).
    fn tool_use(&mut self, b: &Value, sub: bool) {
        // Le texte d'avant l'outil devient une étape ; la réponse finale repart de zéro (pas pour un outil de
        // sous-agent : le texte en cours est celui de l'agent principal).
        if !sub {
            if !self.text.trim().is_empty() {
                let t = std::mem::take(&mut self.text);
                self.step(json!({ "kind": "note", "title": short(&t, 90), "detail": t.trim(), "status": "done" }));
                self.emit("agent-clear", Value::Null);
            }
            self.text.clear();
        }
        let (name, input, id) = (b["name"].as_str().unwrap_or("?"), &b["input"], b["id"].as_str().unwrap_or_default().to_string());
        let path = input["file_path"].as_str().or(input["notebook_path"].as_str()).or(input["path"].as_str()).map(|p| self.rel(p));
        let p = path.clone().unwrap_or_default();
        let step = match name {
            "Read" => json!({ "kind": "read", "title": format!("Lecture de {p}"), "path": p }),
            "Write" => {
                let (d, a, _) = diff_json(diff("", input["content"].as_str().unwrap_or_default()));
                json!({ "kind": "write", "title": format!("Écriture de {p} (+{a})"), "path": p, "diff": d })
            }
            "Edit" | "MultiEdit" => {
                let edits: Vec<(&str, &str)> = match input["edits"].as_array() {
                    Some(list) => list.iter().map(|e| (e["old_string"].as_str().unwrap_or_default(), e["new_string"].as_str().unwrap_or_default())).collect(),
                    None => vec![(input["old_string"].as_str().unwrap_or_default(), input["new_string"].as_str().unwrap_or_default())],
                };
                let mut lines = Vec::new();
                for (k, (old, new)) in edits.iter().enumerate() {
                    if k > 0 {
                        lines.push(('…', "modification suivante".to_string()));
                    }
                    lines.extend(diff(old, new));
                }
                let (d, a, r) = diff_json(lines);
                json!({ "kind": "edit", "title": format!("Modification de {p} (+{a} −{r})"), "path": p, "diff": d })
            }
            "NotebookEdit" => json!({ "kind": "edit", "title": format!("Modification du notebook {p}"), "path": p }),
            "Bash" | "PowerShell" => json!({ "kind": "command", "title": format!("Commande : {}", short(input["command"].as_str().unwrap_or_default(), 140)),
                "command": input["command"], "detail": input["description"].as_str().unwrap_or_default() }),
            "Glob" => json!({ "kind": "search", "title": format!("Recherche de fichiers {}", input["pattern"].as_str().unwrap_or_default()) }),
            "Grep" => json!({ "kind": "search", "title": format!("Recherche de \"{}\"", short(input["pattern"].as_str().unwrap_or_default(), 60)) }),
            "LS" => json!({ "kind": "list", "title": format!("Liste de {}", if p.is_empty() { "dossier de travail".into() } else { p.clone() }) }),
            "WebFetch" => json!({ "kind": "note", "title": format!("Lecture web : {}", input["url"].as_str().unwrap_or_default()) }),
            "WebSearch" => json!({ "kind": "note", "title": format!("Recherche web : {}", input["query"].as_str().unwrap_or_default()) }),
            "Task" | "Agent" => json!({ "kind": "note", "title": format!("Sous-agent : {}", input["description"].as_str().unwrap_or_default()) }),
            // Le plan d'un sous-agent ne remplace pas celui de l'agent principal : il reste une étape (note).
            "TodoWrite" if !sub => {
                // Le plan de Claude : les mêmes états que le plan du mode Agent.
                let tasks: Vec<Value> = input["todos"].as_array().into_iter().flatten().map(|t| {
                    let status = match t["status"].as_str().unwrap_or_default() { "completed" => "done", "in_progress" => "in_progress", _ => "todo" };
                    json!({ "title": t["content"].as_str().or(t["activeForm"].as_str()).unwrap_or_default(), "status": status })
                }).collect();
                self.plan = Value::Array(tasks);
                self.emit("agent-plan", json!({ "request": self.request, "tasks": self.plan }));
                return;
            }
            other => json!({ "kind": "note", "title": format!("Outil : {other}"), "detail": short(&input.to_string(), 400) }),
        };
        let mut step = step;
        step["status"] = "running".into();
        step["tool"] = name.into();
        let sid = self.step(step);
        self.by_tool.insert(id, sid);
    }

    /// Le résultat d'un outil : l'étape est finie, en erreur, ou refusée (permission).
    fn tool_result(&mut self, b: &Value) {
        let Some(sid) = b["tool_use_id"].as_str().and_then(|id| self.by_tool.get(id)).cloned() else { return };
        let text = content_text(&b["content"]);
        let kind = self.steps.iter().find(|s| s["id"] == sid.as_str()).map(|s| s["kind"].as_str().unwrap_or_default().to_string()).unwrap_or_default();
        if b["is_error"] == true {
            let denied = text.to_lowercase().contains("permission");
            let status = if denied { "rejected" } else { "error" };
            let detail = if denied { format!("Non autorisé par le mode de permission ou la liste des outils autorisés (Réglages → Claude Agent).\n{}", text.trim()) } else { text };
            self.update(&sid, json!({ "status": status, "detail": clip(&detail) }));
        } else if kind == "write" || kind == "edit" {
            self.update(&sid, json!({ "status": "done" }));
        } else {
            self.update(&sid, json!({ "status": "done", "detail": clip(&text) }));
        }
    }

    /// Une ligne du flux.
    pub fn line(&mut self, v: &Value) {
        if let Some(s) = v["session_id"].as_str() {
            self.session_id = Some(s.to_string());
        }
        // Les messages d'un sous-agent : ses outils et son texte deviennent des étapes rattachées à l'étape du
        // Task/Agent qui l'a lancé (si on la connaît) ; son texte ne va jamais dans la réponse.
        let sub = !v["parent_tool_use_id"].is_null();
        self.parent = v["parent_tool_use_id"].as_str().and_then(|x| self.by_tool.get(x)).cloned();
        match v["type"].as_str().unwrap_or_default() {
            "stream_event" if !sub => {
                let d = &v["event"]["delta"];
                match (v["event"]["type"].as_str(), d["type"].as_str()) {
                    (Some("content_block_delta"), Some("text_delta")) => {
                        self.saw_delta = true;
                        self.add_text(d["text"].as_str().unwrap_or_default());
                    }
                    (Some("content_block_delta"), Some("thinking_delta")) => {
                        let t = d["thinking"].as_str().unwrap_or_default();
                        if !t.is_empty() {
                            self.think.0.get_or_insert_with(Instant::now);
                            self.reasoning.push_str(t);
                            self.emit("gen-reasoning", json!({ "text": t }));
                        }
                    }
                    _ => {}
                }
            }
            "assistant" => {
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    match b["type"].as_str() {
                        Some("tool_use") => self.tool_use(b, sub),
                        Some("text") if sub => {
                            let t = b["text"].as_str().unwrap_or_default().trim();
                            if !t.is_empty() {
                                self.step(json!({ "kind": "note", "title": "Message du sous-agent", "detail": clip(t), "status": "done" }));
                            }
                        }
                        // Sans --include-partial-messages (ou si le flux n'a pas donné le texte) : le texte entier.
                        Some("text") if !self.saw_delta => self.add_text(b["text"].as_str().unwrap_or_default()),
                        _ => {}
                    }
                }
                // Le message d'un sous-agent ne concerne pas le flux partiel de l'agent principal.
                if !sub {
                    self.saw_delta = false;
                }
            }
            "user" => {
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    if b["type"] == "tool_result" {
                        self.tool_result(b);
                    }
                }
            }
            "result" => {
                // Les outils refusés faute de permission.
                for d in v["permission_denials"].as_array().into_iter().flatten() {
                    if let Some(sid) = d["tool_use_id"].as_str().and_then(|id| self.by_tool.get(id)).cloned() {
                        self.update(&sid, json!({ "status": "rejected" }));
                    }
                }
                self.result = Some(v.clone());
            }
            _ => {}
        }
    }

    pub fn reasoning_seconds(&self) -> Option<f64> {
        self.think.0.map(|s| self.think.1.unwrap_or_else(Instant::now).duration_since(s).as_secs_f64())
    }
}

// ---------------------------------------------------------------------------------------------------------
// La demande

/// Envoie `message` à Claude Agent dans `dir` (reprend `session` si elle est donnée) et rend le résumé pour
/// « gen-done ». Le flux part en direct dans « gen-token », « gen-reasoning », « agent-step », « agent-plan ».
pub async fn run(app: &AppHandle, session: Option<String>, message: String, dir: String, cancel: Arc<Notify>) -> Value {
    let clock = Instant::now();
    let mut b = [0u8; 6];
    getrandom::fill(&mut b).expect("générateur aléatoire du système");
    let request = format!("r{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>());
    let fail = |e: String| {
        crate::log::error(&format!("Claude Agent : {e}"));
        json!({ "error": e })
    };
    let Some(cli) = find_cli() else {
        return fail(format!("l'outil en ligne de commande « claude » d'Anthropic est introuvable dans le PATH. Installe-le ({INSTALL_URL}), puis relance Nel Code."));
    };
    let Some(key) = creds::read(KEY_ID) else {
        return fail("ajoute ta clé API Anthropic dans Réglages → Claude Agent (Claude Agent ne se connecte qu'avec une clé API).".into());
    };
    let root = match std::fs::canonicalize(&dir) {
        Ok(r) if r.is_dir() => r,
        _ => return fail(format!("dossier de travail introuvable : {dir}")),
    };
    let (mode, allowed, model) = settings();
    let resumed = session.is_some();
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    let env: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os().filter(|(k, _)| passed_var(&k.to_string_lossy())).collect();
    let mut cmd = Command::new(&cli);
    cmd.args(args(session.as_deref(), &mode, &allowed, &model))
        .current_dir(&root)
        .env_clear()
        .envs(env)
        .env("ANTHROPIC_API_KEY", &key)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    // Le drapeau « ignorer Ctrl+C » de Windows passe du parent à l'enfant : s'il était levé pour Nel Code (lancé par un
    // programme qui le lève), claude n'entendrait jamais le Ctrl+C de Stop. On le baisse avant de lancer claude.
    unsafe { windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0) };
    let job = match Job::new() {
        Ok(j) => j,
        Err(e) => return fail(e),
    };
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("« {} » ne se lance pas : {e}", cli.display())),
    };
    unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(job.0, child.as_raw_handle() as _) };
    resume(child.id());
    let pid = child.id();
    crate::log::info(&format!("Claude Agent : demande lancée ({}, mode {mode})", if resumed { "reprise de la session" } else { "nouvelle session" }));

    // Le message sur l'entrée standard, puis fermée.
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(message.as_bytes());
        });
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(std::result::Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    let stderr = Arc::new(Mutex::new(String::new()));
    if let Some(mut err) = child.stderr.take() {
        let stderr = stderr.clone();
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            *stderr.lock().unwrap() = s;
        });
    }

    let mut tr = Translator::new(Some(app), &root, request.clone());
    let (mut stopped, mut killed) = (false, false);
    let mut deadline: Option<Instant> = None;
    loop {
        let wait = deadline.map(|d| d.saturating_duration_since(Instant::now())).unwrap_or(Duration::from_secs(3600));
        tokio::select! {
            line = rx.recv() => match line {
                Some(l) => if let Ok(v) = serde_json::from_str::<Value>(l.trim()) { tr.line(&v) },
                None => break,
            },
            _ = cancel.notified(), if !stopped => {
                // Stop : Ctrl+C (SIGINT), puis on attend la fin propre (le résultat) ; au-delà, on tue.
                stopped = true;
                if !send_ctrl_c(pid) {
                    crate::log::error("Claude Agent : Ctrl+C non envoyé, le processus est arrêté");
                    job.kill();
                    killed = true;
                }
                deadline = Some(Instant::now() + STOP_GRACE);
            },
            _ = tokio::time::sleep(wait), if deadline.is_some() => {
                crate::log::error("Claude Agent : pas de fin propre après Ctrl+C, le processus est arrêté");
                job.kill();
                killed = true;
                break;
            }
        }
    }
    let code = tokio::task::spawn_blocking(move || child.wait().ok().and_then(|s| s.code())).await.ok().flatten();
    drop(job);
    let err_text = stderr.lock().unwrap().trim().to_string();

    let result = tr.result.clone().unwrap_or(Value::Null);
    let final_text = result["result"].as_str().filter(|t| !t.trim().is_empty() && !stopped).map(str::to_string).unwrap_or_else(|| tr.text.clone());
    let error = if stopped {
        None
    } else if result.is_null() {
        Some(format!("« claude » s'est arrêté sans réponse (code {}){}", code.map_or("?".into(), |c| c.to_string()), if err_text.is_empty() { String::new() } else { format!(" : {}", short(&err_text, 400)) }))
    } else if result["is_error"] == true {
        Some(format!("Claude Agent : {}", result["result"].as_str().filter(|t| !t.is_empty()).or(result["subtype"].as_str()).unwrap_or("erreur")))
    } else {
        None
    };
    let cost = result["total_cost_usd"].as_f64();
    crate::log::info(&format!("Claude Agent : demande finie{}{}", cost.map(|c| format!(", {c:.4} $")).unwrap_or_default(), if killed { " (processus tué)" } else if stopped { " (arrêtée)" } else { "" }));
    json!({
        "text": final_text, "reasoning": tr.reasoning, "reasoningSeconds": tr.reasoning_seconds(),
        "model": "Claude Agent", "tokens": 0, "seconds": clock.elapsed().as_secs_f64(), "stopped": stopped, "error": error,
        "agent": { "request": request, "steps": tr.steps }, "plan": tr.plan,
        "claude": { "sessionId": tr.session_id, "cost": cost, "durationMs": result["duration_ms"], "turns": result["num_turns"], "killed": killed },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments() {
        assert_eq!(args(None, "default", &[], ""), ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "default"]);
        let a = args(Some("abc-123"), "acceptEdits", &["Read".into(), " Bash(git log *) ".into(), "".into()], "");
        assert_eq!(a[6..], ["acceptEdits", "--allowedTools", "Read,Bash(git log *)", "--resume", "abc-123"]);
        assert_eq!(args(None, "bypassPermissions", &[], "")[6], "default", "seuls default et acceptEdits");
        assert!(!args(Some(""), "default", &[], "").contains(&"--resume".to_string()));
        assert_eq!(args(None, "default", &[], "claude-opus-5-5[1m]")[7..], ["--model", "claude-opus-5-5[1m]"]);
        assert!(!args(None, "default", &[], "opus & calc").contains(&"--model".to_string()), "nom invalide : pas de --model");
        for v in ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "claude_code_use_vertex"] {
            assert!(!passed_var(v), "{v}");
        }
        assert!(passed_var("PATH") && passed_var("USERPROFILE"));
    }

    #[test]
    fn traduction_du_flux() {
        let root = std::env::temp_dir();
        let mut t = Translator::new(None, &root, "r1".into());
        let file = root.join("src").join("A.cs").to_string_lossy().into_owned();
        for line in [
            json!({ "type": "system", "subtype": "init", "session_id": "sess-1" }),
            json!({ "type": "stream_event", "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "Je lis." } }, "parent_tool_use_id": null }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Je lis." }, { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": file } }] }, "parent_tool_use_id": null }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": [{ "type": "text", "text": "class A {}" }] }] } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t2", "name": "Edit", "input": { "file_path": "src/A.cs", "old_string": "class A {}", "new_string": "class B {}" } }] }, "parent_tool_use_id": null }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t2", "is_error": true, "content": "Claude requested permissions to write to src/A.cs, but you haven't granted it yet." }] } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t3", "name": "TodoWrite", "input": { "todos": [{ "content": "Lire", "status": "completed" }, { "content": "Corriger", "status": "in_progress" }] } }] }, "parent_tool_use_id": null }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Fini." }] }, "parent_tool_use_id": null }),
            json!({ "type": "result", "subtype": "success", "is_error": false, "result": "Fini.", "total_cost_usd": 0.0123, "duration_ms": 4567, "num_turns": 3, "session_id": "sess-1" }),
        ] {
            t.line(&line);
        }
        assert_eq!(t.session_id.as_deref(), Some("sess-1"));
        let s: Vec<(String, String)> = t.steps.iter().map(|s| (s["title"].as_str().unwrap().to_string(), s["status"].as_str().unwrap().to_string())).collect();
        assert_eq!(s, [("Je lis.".into(), "done".into()), ("Lecture de src/A.cs".into(), "done".into()), ("Modification de src/A.cs (+1 −1)".into(), "rejected".into())]);
        assert_eq!(t.steps[1]["detail"], "class A {}");
        assert_eq!(t.plan, json!([{ "title": "Lire", "status": "done" }, { "title": "Corriger", "status": "in_progress" }]));
        assert_eq!(t.text, "Fini.", "le texte sans flux partiel est repris du message entier");
        assert_eq!(t.result.as_ref().unwrap()["total_cost_usd"], 0.0123);
    }

    #[test]
    fn sous_agents() {
        let mut t = Translator::new(None, &std::env::temp_dir(), "r1".into());
        for line in [
            json!({ "type": "stream_event", "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "Je délègue." } }, "parent_tool_use_id": null }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Je délègue." }] }, "parent_tool_use_id": null }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "task1", "name": "Task", "input": { "description": "Explorer", "prompt": "…" } }] }, "parent_tool_use_id": null }),
            json!({ "type": "stream_event", "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "ignoré" } }, "parent_tool_use_id": "task1" }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "a1", "name": "Glob", "input": { "pattern": "*.rs" } }] }, "parent_tool_use_id": "task1" }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "a1", "content": "main.rs" }] }, "parent_tool_use_id": "task1" }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "a2", "name": "Read", "input": { "file_path": "main.rs" } }] }, "parent_tool_use_id": "task1" }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "a2", "content": "fn main() {}" }] }, "parent_tool_use_id": "task1" }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "  Un seul fichier.  " }, { "type": "text", "text": " " }] }, "parent_tool_use_id": "task1" }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "task1", "content": [{ "type": "text", "text": "Un seul fichier." }] }] }, "parent_tool_use_id": null }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "x1", "name": "Grep", "input": { "pattern": "x" } }] }, "parent_tool_use_id": "inconnu" }),
            json!({ "type": "stream_event", "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "Fini." } }, "parent_tool_use_id": null }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Fini." }] }, "parent_tool_use_id": null }),
        ] {
            t.line(&line);
        }
        let s: Vec<(&str, &str, &str, Option<&str>)> = t.steps.iter().map(|s| (s["id"].as_str().unwrap(), s["title"].as_str().unwrap(), s["status"].as_str().unwrap(), s["parent"].as_str())).collect();
        assert_eq!(s, [
            ("s1", "Je délègue.", "done", None),
            ("s2", "Sous-agent : Explorer", "done", None),
            ("s3", "Recherche de fichiers *.rs", "done", Some("s2")),
            ("s4", "Lecture de main.rs", "done", Some("s2")),
            ("s5", "Message du sous-agent", "done", Some("s2")),
            ("s6", "Recherche de \"x\"", "running", None),
        ]);
        assert!(t.steps[5].get("parent").is_none(), "parent_tool_use_id inconnu : pas de champ parent");
        assert_eq!(t.steps[4]["detail"], "Un seul fichier.");
        assert_eq!(t.steps[4]["kind"], "note");
        assert_eq!(t.steps[3]["detail"], "fn main() {}");
        assert_eq!(t.text, "Fini.", "ni le texte ni le flux du sous-agent dans la réponse");
    }
}
