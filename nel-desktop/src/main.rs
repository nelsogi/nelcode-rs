// Pas de console derrière la fenêtre en version publiée.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod store;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use nel_engine::{MAX_ANSWER_TOKENS, NelModel, Rng, Sampling};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use store::Result;

struct Loaded {
    name: String,
    model: Arc<NelModel>,
}

/// L'état de l'application : le modèle chargé (une seule fois, partagé avec le thread de génération par Arc),
/// le modèle en cours de chargement, et les drapeaux de la génération.
#[derive(Default)]
struct AppState {
    model: Mutex<Option<Loaded>>,
    /// Mode comparaison : les modèles A et B quand ce ne sont pas celui chargé, gardés d'un message à l'autre.
    compare: Mutex<Vec<Loaded>>,
    loading: Mutex<Option<String>>,
    importing: AtomicBool,
    generating: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

fn current(state: &AppState) -> Result<(String, Arc<NelModel>)> {
    let guard = state.model.lock().unwrap();
    let loaded = guard.as_ref().ok_or("aucun modèle chargé")?;
    Ok((loaded.name.clone(), loaded.model.clone()))
}

#[tauri::command]
fn app_info() -> Value {
    // Un .nelmodel ouvert depuis l'Explorateur (association de fichier) arrive en argument.
    let startup_file = std::env::args().nth(1).filter(|a| a.to_lowercase().ends_with(".nelmodel"));
    json!({
        "root": store::root(),
        "home": std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(store::root),
        "version": env!("CARGO_PKG_VERSION"),
        "startupFile": startup_file,
    })
}

// --- Modèles -----------------------------------------------------------------------------------------------

#[tauri::command]
fn list_models() -> Vec<store::ModelEntry> {
    store::list_models()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelStatus {
    name: Option<String>,
    loading: Option<String>,
    block_size: Option<usize>,
    parameters: Option<u64>,
}

#[tauri::command]
fn model_status(state: State<AppState>) -> ModelStatus {
    let model = state.model.lock().unwrap();
    ModelStatus {
        name: model.as_ref().map(|m| m.name.clone()),
        loading: state.loading.lock().unwrap().clone(),
        block_size: model.as_ref().map(|m| m.model.model.config.block_size),
        parameters: model.as_ref().and_then(|m| m.model.info["parameters"].as_u64()),
    }
}

/// Charge un modèle installé dans un thread à part. Fin annoncée par « model-loaded » ou « model-error ».
#[tauri::command]
fn load_model(app: AppHandle, state: State<AppState>, name: String) -> Result<()> {
    if !store::valid_name(&name) {
        return Err(format!("nom de modèle invalide : « {name} »"));
    }
    {
        let mut loading = state.loading.lock().unwrap();
        if let Some(other) = loading.as_ref() {
            return Err(format!("« {other} » est déjà en cours de chargement"));
        }
        *loading = Some(name.clone());
    }
    let _ = app.emit("model-loading", &name);
    std::thread::spawn(move || {
        let clock = Instant::now();
        let result = store::load_folder(&store::models_dir().join(&name));
        let state = app.state::<AppState>();
        match result {
            Ok(model) => {
                let block_size = model.model.config.block_size;
                *state.model.lock().unwrap() = Some(Loaded { name: name.clone(), model: Arc::new(model) });
                *state.loading.lock().unwrap() = None;
                let mut last = serde_json::Map::new();
                last.insert("lastModel".into(), name.clone().into());
                let _ = store::save_settings(&last);
                let _ = app.emit("model-loaded", json!({ "name": name, "blockSize": block_size, "seconds": clock.elapsed().as_secs_f64() }));
            }
            Err(error) => {
                *state.loading.lock().unwrap() = None;
                let _ = app.emit("model-error", json!({ "name": name, "error": error }));
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn delete_model(state: State<AppState>, name: String) -> Result<()> {
    let mut model = state.model.lock().unwrap();
    if model.as_ref().is_some_and(|m| m.name == name) {
        if state.generating.load(Ordering::SeqCst) {
            return Err("une réponse est en cours avec ce modèle".into());
        }
        *model = None;
    }
    state.compare.lock().unwrap().retain(|m| m.name != name);
    store::delete_model(&name)
}

/// Les infos d'un .nelmodel avant de l'importer (format vérifié) : nom proposé, et s'il est déjà pris.
#[tauri::command]
fn inspect_package(path: String) -> Result<Value> {
    let path = PathBuf::from(path);
    let info = store::read_package_info(&path)?;
    let name = store::suggested_name(&path, &info);
    let exists = store::valid_name(&name) && store::models_dir().join(&name).exists();
    Ok(json!({ "info": info, "name": name, "exists": exists }))
}

/// Importe dans un thread à part (extraction et chargement d'essai) : « import-done » ou « import-error ».
#[tauri::command]
fn import_model(app: AppHandle, state: State<AppState>, path: String, name: String, replace: bool) -> Result<()> {
    if state.importing.swap(true, Ordering::SeqCst) {
        return Err("un import est déjà en cours".into());
    }
    let _ = app.emit("import-started", &name);
    std::thread::spawn(move || {
        let result = store::import(&PathBuf::from(&path), &name, replace);
        app.state::<AppState>().importing.store(false, Ordering::SeqCst);
        let _ = match result {
            Ok(report) => app.emit("import-done", report),
            Err(error) => app.emit("import-error", json!({ "error": error, "path": path, "name": name })),
        };
    });
    Ok(())
}

#[tauri::command]
async fn pick_nelmodel(app: AppHandle) -> Option<String> {
    let file = app.dialog().file().set_title("Importer un modèle").add_filter("Modèle Nel Code", &["nelmodel"]).blocking_pick_file()?;
    Some(file.into_path().ok()?.to_string_lossy().into_owned())
}

// --- Conversations, dossiers, réglages ---------------------------------------------------------------------

#[tauri::command]
fn list_sessions() -> Vec<Value> {
    store::list_sessions()
}

#[tauri::command]
fn save_session(session: Value) -> Result<()> {
    store::save_session(&session)
}

#[tauri::command]
fn delete_session(id: String) -> Result<()> {
    store::delete_session(&id)
}

/// Demande où enregistrer, puis écrit `content`. Rend le chemin, ou rien si l'utilisateur annule.
#[tauri::command]
async fn export_session(app: AppHandle, file_name: String, content: String, markdown: bool, directory: String) -> Result<Option<String>> {
    let (label, ext) = if markdown { ("Markdown", "md") } else { ("Texte", "txt") };
    let mut dialog = app.dialog().file().set_title("Exporter la conversation").set_file_name(&file_name).add_filter(label, &[ext]);
    if std::path::Path::new(&directory).is_dir() {
        dialog = dialog.set_directory(&directory);
    }
    let Some(file) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| format!("export impossible : {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn pick_folder(app: AppHandle, start: String) -> Option<String> {
    let mut dialog = app.dialog().file().set_title("Dossier de travail");
    if std::path::Path::new(&start).is_dir() {
        dialog = dialog.set_directory(&start);
    }
    Some(dialog.blocking_pick_folder()?.into_path().ok()?.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_folder(path: String) -> Result<()> {
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("dossier introuvable : {path}"));
    }
    std::process::Command::new("explorer").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings() -> Value {
    store::load_settings()
}

#[tauri::command]
fn save_settings(changes: serde_json::Map<String, Value>) -> Result<Value> {
    store::save_settings(&changes)
}

// --- Génération --------------------------------------------------------------------------------------------

/// Ce que le modèle verra au prochain message : tokens du prompt, et combien de tours (les plus récents) y tiennent.
#[tauri::command]
fn context_info(state: State<AppState>, history: Vec<(String, String)>, message: String) -> Result<Value> {
    let (_, m) = current(&state)?;
    let t = &m.tokenizer;
    let block = m.model.config.block_size;
    let budget = block.saturating_sub(MAX_ANSWER_TOKENS);
    let mut used = t.encode("<|doc|>").len() + t.encode(&format!("<|user|>{}<|end|><|assistant|>", message.trim())).len();
    let mut kept = 0;
    for (q, a) in history.iter().rev() {
        let n = t.encode(&format!("<|user|>{}<|end|><|assistant|>{}<|end|>", q.trim(), a.trim())).len();
        if used + n > budget {
            break;
        }
        used += n;
        kept += 1;
    }
    Ok(json!({ "tokens": m.chat_prompt(&history, &message).len(), "blockSize": block, "keptTurns": kept }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenOptions {
    temperature: f32,
    top_k: usize,
    top_p: f32,
    max_reply_tokens: usize,
    /// Mode transparence : les 5 choix les plus probables de chaque token.
    #[serde(default)]
    transparency: bool,
}

impl GenOptions {
    fn sampling(&self) -> Sampling {
        Sampling {
            temperature: if self.temperature.is_finite() { self.temperature.clamp(0.1, 2.0) } else { 0.8 },
            top_k: self.top_k,
            top_p: if self.top_p.is_finite() { self.top_p.clamp(0.05, 1.0) } else { 0.9 },
        }
    }
}

/// Écrit une réponse. Chaque token part dans « gen-token » : { text, side, choices? } (choices : [[texte, p] ×5]
/// en mode transparence). Rend le résumé pour « gen-done ».
fn write_reply(app: &AppHandle, model: &NelModel, name: &str, history: &[(String, String)], message: &str, options: &GenOptions, stop: &AtomicBool, side: &str) -> Value {
    let clock = Instant::now();
    let prompt = model.chat_prompt(history, message);
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos() as u64;
    let t = &model.tokenizer;
    let max = options.max_reply_tokens.clamp(16, 128);
    let result = model.generate_with_choices(&prompt, max, &options.sampling(), &mut Rng(seed), true, options.transparency, |id, choices| {
        let mut token = json!({ "text": t.decode(&[id]), "side": side });
        if options.transparency {
            token["choices"] = choices.iter().map(|&(c, p)| json!([t.decode(&[c]), p])).collect();
        }
        let _ = app.emit("gen-token", token);
        !stop.load(Ordering::SeqCst)
    });
    match result {
        Ok(out) => json!({
            "text": t.decode(&out.iter().map(|(id, _)| *id).collect::<Vec<_>>()),
            "model": name,
            "tokens": out.len(),
            "promptTokens": prompt.len(),
            "seconds": clock.elapsed().as_secs_f64(),
            "stopped": stop.load(Ordering::SeqCst),
        }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

/// Lance la réponse à `message` (après les tours `history`) dans un thread à part : l'interface ne se fige
/// jamais. Les tokens partent dans « gen-token », la fin dans « gen-done » (texte complet, arrêtée ou non, ou erreur).
#[tauri::command]
fn generate(app: AppHandle, state: State<AppState>, history: Vec<(String, String)>, message: String, options: GenOptions) -> Result<()> {
    let (name, model) = current(&state)?;
    if state.generating.swap(true, Ordering::SeqCst) {
        return Err("une réponse est déjà en cours".into());
    }
    state.stop.store(false, Ordering::SeqCst);
    let (generating, stop) = (state.generating.clone(), state.stop.clone());
    std::thread::spawn(move || {
        let done = write_reply(&app, &model, &name, &history, &message, &options, &stop, "");
        generating.store(false, Ordering::SeqCst);
        let _ = app.emit("gen-done", done);
    });
    Ok(())
}

/// Le modèle `name` pour la comparaison : celui chargé s'il a ce nom, sinon un de la réserve, sinon chargé dans la réserve.
fn compare_model(state: &AppState, name: &str) -> Result<Arc<NelModel>> {
    if let Some(l) = state.model.lock().unwrap().as_ref().filter(|l| l.name == name) {
        return Ok(l.model.clone());
    }
    let mut cache = state.compare.lock().unwrap();
    if let Some(l) = cache.iter().find(|l| l.name == name) {
        return Ok(l.model.clone());
    }
    let model = Arc::new(store::load_folder(&store::models_dir().join(name))?);
    cache.push(Loaded { name: name.to_string(), model: model.clone() });
    Ok(model)
}

/// Mode comparaison : `message` part à A puis à B (l'un après l'autre : un seul modèle calcule à la fois, le CPU
/// n'est pas partagé). Tokens dans « gen-token » (side "a" ou "b"), fin dans « gen-done » : { compare, a, b }.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn compare_generate(app: AppHandle, state: State<AppState>, a: String, b: String, history_a: Vec<(String, String)>, history_b: Vec<(String, String)>, message: String, options: GenOptions) -> Result<()> {
    if !store::valid_name(&a) || !store::valid_name(&b) {
        return Err("nom de modèle invalide".into());
    }
    if state.generating.swap(true, Ordering::SeqCst) {
        return Err("une réponse est déjà en cours".into());
    }
    state.stop.store(false, Ordering::SeqCst);
    // ponytail: la réserve ne garde que A et B (au pire 3 modèles en mémoire avec celui chargé) ; décharger si la RAM manque.
    state.compare.lock().unwrap().retain(|m| m.name == a || m.name == b);
    let (generating, stop) = (state.generating.clone(), state.stop.clone());
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let reply = |name: &str, history: &[(String, String)], side: &str| {
            if stop.load(Ordering::SeqCst) {
                return json!({ "text": "", "model": name, "stopped": true });
            }
            let _ = app.emit("gen-side", side);
            match compare_model(&state, name) {
                Ok(model) => write_reply(&app, &model, name, history, &message, &options, &stop, side),
                Err(e) => json!({ "error": format!("{name} : {e}") }),
            }
        };
        let done = json!({ "compare": true, "a": reply(&a, &history_a, "a"), "b": reply(&b, &history_b, "b") });
        generating.store(false, Ordering::SeqCst);
        let _ = app.emit("gen-done", done);
    });
    Ok(())
}

#[tauri::command]
fn arena() -> Value {
    store::load_arena()
}

#[tauri::command]
fn arena_vote(vote: Value) -> Result<Value> {
    store::arena_vote(vote)
}

/// Stop / Échap : le thread de génération s'arrête après le token en cours.
#[tauri::command]
fn stop_generation(state: State<AppState>) {
    state.stop.store(true, Ordering::SeqCst);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .setup(|app| {
            let config = app.config().app.windows[0].clone();
            #[allow(unused_mut)]
            let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
            // En debug, NELCODE_DEBUG_PORT ouvre le port de débogage de WebView2 (tests de l'interface).
            #[cfg(debug_assertions)]
            if let Ok(port) = std::env::var("NELCODE_DEBUG_PORT") {
                window = window.additional_browser_args(&format!("--remote-debugging-port={port}"));
            }
            window.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_models,
            model_status,
            load_model,
            delete_model,
            inspect_package,
            import_model,
            pick_nelmodel,
            list_sessions,
            save_session,
            delete_session,
            export_session,
            pick_folder,
            open_folder,
            get_settings,
            save_settings,
            context_info,
            generate,
            compare_generate,
            arena,
            arena_vote,
            stop_generation,
        ])
        .run(tauri::generate_context!())
        .expect("impossible de lancer Nel Code");
}
