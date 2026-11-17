// Pas de console derrière la fenêtre en version publiée.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod catalog;
#[cfg(feature = "cuda")]
mod delayload;
mod gpu;
mod log;
mod remote;
mod server;
mod store;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use nel_engine::{ChatModel, Device, Rng, Sampling};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use store::Result;

struct Loaded {
    name: String,
    model: Arc<dyn ChatModel>,
    /// « CPU » ou « GPU · NVIDIA T400 4GB ».
    device: String,
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
    /// Le GPU, essayé une seule fois (les DLL du pack restent chargées jusqu'à la fin) : (périphérique, libellé) ou l'erreur.
    gpu: OnceLock<std::result::Result<(Device, String), String>>,
    gpu_installing: AtomicBool,
    gpu_cancel: AtomicBool,
    catalog_installing: AtomicBool,
    catalog_cancel: AtomicBool,
    /// Le serveur local (API OpenAI), quand il est activé.
    server: Mutex<Option<server::Running>>,
    /// La réponse d'un modèle distant en cours : Stop la réveille, et la connexion est fermée.
    remote_cancel: Mutex<Option<Arc<tokio::sync::Notify>>>,
    /// Mode Agent : les écritures qui attendent l'accord de l'utilisateur.
    approvals: agent::Approvals,
}

/// Le GPU, initialisé au premier appel depuis le pack (%APPDATA%\NelCode\gpu).
fn gpu_device(state: &AppState) -> std::result::Result<(Device, String), String> {
    state
        .gpu
        .get_or_init(|| {
            let r = nel_engine::gpu::cuda_device(Some(&gpu::dir()))
                .map(|d| (d, format!("GPU · {}", nel_engine::gpu::probe().card.unwrap_or_else(|| "NVIDIA".into()))))
                .map_err(|e| e.to_string());
            match &r {
                Ok((_, label)) => log::info(&format!("{label} prêt")),
                Err(e) => log::error(&format!("GPU indisponible, le CPU est utilisé : {e}")),
            }
            r
        })
        .clone()
}

/// Le périphérique des réglages (« device » : auto, cpu, gpu). Sans pack, sans carte, ou en cas d'erreur : le CPU,
/// sans erreur (la raison est dans le journal et dans les réglages).
fn pick_device(state: &AppState) -> (Device, String) {
    let choice = store::load_settings()["device"].as_str().unwrap_or("auto").to_string();
    if choice != "cpu" && nel_engine::gpu::compiled() && gpu::installed() && let Ok(d) = gpu_device(state) {
        return d;
    }
    (Device::Cpu, "CPU".into())
}

fn current(state: &AppState) -> Result<(String, Arc<dyn ChatModel>)> {
    let guard = state.model.lock().unwrap();
    let loaded = guard.as_ref().ok_or("aucun modèle chargé")?;
    Ok((loaded.name.clone(), loaded.model.clone()))
}

#[tauri::command]
fn app_info() -> Value {
    // Un .nelmodel ou un .gguf ouvert depuis l'Explorateur (association de fichier) arrive en argument.
    let startup_file = std::env::args().nth(1).filter(|a| a.to_lowercase().ends_with(".nelmodel") || a.to_lowercase().ends_with(".gguf"));
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
    device: Option<String>,
}

#[tauri::command]
fn model_status(state: State<AppState>) -> ModelStatus {
    let model = state.model.lock().unwrap();
    ModelStatus {
        name: model.as_ref().map(|m| m.name.clone()),
        loading: state.loading.lock().unwrap().clone(),
        block_size: model.as_ref().map(|m| m.model.context_size()),
        parameters: model.as_ref().and_then(|m| m.model.parameters()),
        device: model.as_ref().map(|m| m.device.clone()),
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
        let state = app.state::<AppState>();
        let (device, label) = pick_device(&state);
        let clock = Instant::now();
        let result = store::load_folder(&store::models_dir().join(&name), &device);
        match result {
            Ok(model) => {
                let block_size = model.context_size();
                log::info(&format!("modèle « {name} » chargé en {:.2} s sur {label} (contexte {block_size})", clock.elapsed().as_secs_f64()));
                *state.model.lock().unwrap() = Some(Loaded { name: name.clone(), model, device: label.clone() });
                // La réserve de la comparaison suit le périphérique choisi : elle est rechargée au besoin.
                state.compare.lock().unwrap().clear();
                *state.loading.lock().unwrap() = None;
                let mut last = serde_json::Map::new();
                last.insert("lastModel".into(), name.clone().into());
                let _ = store::save_settings(&last);
                let _ = app.emit("model-loaded", json!({ "name": name, "blockSize": block_size, "seconds": clock.elapsed().as_secs_f64(), "device": label }));
            }
            Err(error) => {
                log::error(&format!("chargement de « {name} » impossible : {error}"));
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

/// Les infos d'un .nelmodel ou d'un .gguf avant de l'importer (format vérifié) : nom proposé, et s'il est déjà pris.
#[tauri::command]
fn inspect_package(path: String) -> Result<Value> {
    let path = PathBuf::from(path);
    let gguf = store::is_gguf(&path);
    let info = if gguf { store::read_gguf_info(&path)? } else { store::read_package_info(&path)? };
    let name = if gguf {
        path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        store::suggested_name(&path, &info)
    };
    let exists = store::valid_name(&name) && store::models_dir().join(&name).exists();
    Ok(json!({ "info": info, "name": name, "exists": exists, "gguf": gguf }))
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
            Ok(report) => {
                log::info(&format!("modèle « {name} » importé"));
                app.emit("import-done", report)
            }
            Err(error) => {
                log::error(&format!("import de « {name} » impossible : {error}"));
                app.emit("import-error", json!({ "error": error, "path": path, "name": name }))
            }
        };
    });
    Ok(())
}

#[tauri::command]
async fn pick_nelmodel(app: AppHandle) -> Option<String> {
    let file = app.dialog().file().set_title("Importer un modèle").add_filter("Modèle (.nelmodel, .gguf)", &["nelmodel", "gguf"]).blocking_pick_file()?;
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

/// Ce que le modèle verra au prochain message : tokens du prompt, combien de tours (les plus récents) y tiennent,
/// et la place gardée pour la réponse.
#[tauri::command]
fn context_info(state: State<AppState>, history: Vec<(String, String)>, message: String) -> Result<Value> {
    let (_, m) = current(&state)?;
    let (prompt, kept) = m.chat(&history, &message);
    let reserve = m.max_reply(store::load_settings()["maxReplyTokens"].as_u64().unwrap_or(80) as usize);
    Ok(json!({ "tokens": prompt.len(), "blockSize": m.context_size(), "keptTurns": kept, "reserve": reserve }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenOptions {
    temperature: f32,
    top_k: usize,
    top_p: f32,
    max_reply_tokens: usize,
    /// 1 : désactivée. Absente (ancienne interface) : la valeur par défaut.
    #[serde(default = "default_penalty")]
    repetition_penalty: f32,
    /// Mode transparence : les 5 choix les plus probables de chaque token.
    #[serde(default)]
    transparency: bool,
}

fn default_penalty() -> f32 {
    Sampling::default().repetition_penalty
}

impl GenOptions {
    fn sampling(&self) -> Sampling {
        Sampling {
            temperature: if self.temperature.is_finite() { self.temperature.clamp(0.1, 2.0) } else { 0.8 },
            top_k: self.top_k,
            top_p: if self.top_p.is_finite() { self.top_p.clamp(0.05, 1.0) } else { 0.9 },
            repetition_penalty: if self.repetition_penalty.is_finite() { self.repetition_penalty.clamp(1.0, 2.0) } else { default_penalty() },
        }
    }
}

/// Une graine pour le tirage (l'heure en nanosecondes).
fn seed() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos() as u64
}

/// Génère après `prompt` en rendant le texte morceau par morceau : chaque token donne ce qu'il ajoute au texte décodé
/// jusque-là (un caractère sur plusieurs tokens d'octets n'est donné qu'une fois complet, le texte est vide avant).
/// `on_text` reçoit aussi les choix de la transparence ; false arrête. Rend les tokens écrits.
fn text_stream(model: &dyn ChatModel, prompt: &[u32], max: usize, sampling: &Sampling, transparency: bool, mut on_text: impl FnMut(&str, &[(u32, f32)]) -> bool) -> nel_engine::Result<Vec<u32>> {
    let (mut ids, mut shown) = (Vec::new(), 0);
    let out = model.stream(prompt, max, sampling, &mut Rng(seed()), true, transparency, &mut |id, choices| {
        ids.push(id);
        let full = model.decode(&ids);
        if full.ends_with('\u{FFFD}') {
            return on_text("", choices);
        }
        let text = full.get(shown..).unwrap_or_default().to_string();
        shown = full.len();
        on_text(&text, choices)
    })?;
    Ok(out.into_iter().map(|(id, _)| id).collect())
}

/// Écrit une réponse. Chaque token part dans « gen-token » : { text, side, choices? } (choices : [[texte, p] ×5]
/// en mode transparence). Rend le résumé pour « gen-done ».
#[allow(clippy::too_many_arguments)]
fn write_reply(app: &AppHandle, model: &dyn ChatModel, name: &str, history: &[(String, String)], message: &str, options: &GenOptions, stop: &AtomicBool, side: &str) -> Value {
    let clock = Instant::now();
    let (prompt, _) = model.chat(history, message);
    let max = model.max_reply(options.max_reply_tokens);
    let result = text_stream(model, &prompt, max, &options.sampling(), options.transparency, |text, choices| {
        let mut token = json!({ "text": text, "side": side });
        if options.transparency {
            token["choices"] = choices.iter().map(|&(c, p)| json!([model.decode(&[c]), p])).collect();
        }
        let _ = app.emit("gen-token", token);
        !stop.load(Ordering::SeqCst)
    });
    match result {
        Ok(out) => json!({
            "text": model.decode(&out),
            "model": name,
            "tokens": out.len(),
            "promptTokens": prompt.len(),
            "seconds": clock.elapsed().as_secs_f64(),
            "stopped": stop.load(Ordering::SeqCst),
        }),
        Err(e) => {
            log::error(&format!("génération avec « {name} » : {e}"));
            json!({ "error": e.to_string() })
        }
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
        let done = write_reply(&app, &*model, &name, &history, &message, &options, &stop, "");
        generating.store(false, Ordering::SeqCst);
        let _ = app.emit("gen-done", done);
    });
    Ok(())
}

/// Le modèle `name` pour la comparaison : celui chargé s'il a ce nom, sinon un de la réserve, sinon chargé dans la réserve.
fn compare_model(state: &AppState, name: &str) -> Result<Arc<dyn ChatModel>> {
    if let Some(l) = state.model.lock().unwrap().as_ref().filter(|l| l.name == name) {
        return Ok(l.model.clone());
    }
    let mut cache = state.compare.lock().unwrap();
    if let Some(l) = cache.iter().find(|l| l.name == name) {
        return Ok(l.model.clone());
    }
    let (device, label) = pick_device(state);
    let clock = Instant::now();
    let model = store::load_folder(&store::models_dir().join(name), &device).inspect_err(|e| log::error(&format!("comparaison : « {name} » ne se charge pas : {e}")))?;
    log::info(&format!("comparaison : « {name} » chargé en {:.2} s sur {label}", clock.elapsed().as_secs_f64()));
    cache.push(Loaded { name: name.to_string(), model: model.clone(), device: label });
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
                Ok(model) => write_reply(&app, &*model, name, history, &message, &options, &stop, side),
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

/// Une ligne du journal venue de l'interface (mises à jour, erreurs affichées). Jamais de texte de conversation.
#[tauri::command]
fn log_event(level: String, message: String) {
    let message: String = message.chars().take(500).collect();
    if level == "error" { log::error(&message) } else { log::info(&message) }
}

/// La version de Windows, comme `ver` l'écrit (« Microsoft Windows [version 10.0.26200.1234] »).
fn windows_version() -> String {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd")
        .args(["/c", "ver"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|e| format!("inconnue ({e})"))
}

/// « Copier un rapport de bug » : version, Windows, modèle actif, les 50 dernières lignes du journal.
#[tauri::command]
fn bug_report(state: State<AppState>) -> String {
    let model = state.model.lock().unwrap().as_ref().map(|m| format!("{} ({})", m.name, m.device)).unwrap_or_else(|| "(aucun)".into());
    let probe = nel_engine::gpu::probe();
    let gpu = match (nel_engine::gpu::compiled(), probe.card) {
        (false, _) => "compilé sans CUDA".to_string(),
        (true, None) => "aucune carte NVIDIA".to_string(),
        (true, Some(card)) => format!(
            "{card}, pilote {} (CUDA {}), pack {}",
            probe.driver.as_deref().unwrap_or("?"),
            probe.driver_cuda.map(|(a, b)| format!("{a}.{b}")).unwrap_or_else(|| "?".into()),
            if gpu::installed() { "installé" } else { "absent" }
        ),
    };
    format!(
        "Nel Code {}\nWindows : {}\nModèle actif : {model}\nGPU : {gpu}\n\nJournal (50 dernières lignes, heures UTC) :\n{}\n",
        env!("CARGO_PKG_VERSION"),
        windows_version(),
        log::tail(50).join("\n")
    )
}

// --- GPU et test de vitesse --------------------------------------------------------------------------------

#[tauri::command]
fn gpu_status(state: State<AppState>) -> Value {
    gpu::status(state.gpu.get().map(|r| r.as_ref().map(|(_, label)| label.clone()).map_err(|e| e.clone())).as_ref())
}

/// Télécharge et installe le pack GPU (« gpu-pack-progress »). Rend quand c'est fini, annulé ou en erreur.
#[tauri::command]
async fn install_gpu_pack(app: AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    if state.gpu_installing.swap(true, Ordering::SeqCst) {
        return Err("installation déjà en cours".into());
    }
    state.gpu_cancel.store(false, Ordering::SeqCst);
    let result = gpu::install(&app, &state.gpu_cancel).await;
    state.gpu_installing.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
fn cancel_gpu_pack(state: State<AppState>) {
    state.gpu_cancel.store(true, Ordering::SeqCst);
}

/// Rend true si le pack est retiré tout de suite, false s'il l'est au prochain démarrage (DLL chargées).
#[tauri::command]
fn remove_gpu_pack(state: State<AppState>) -> Result<bool> {
    gpu::remove(state.gpu.get().is_some_and(|r| r.is_ok()))
}

const BENCH_TOKENS: usize = 200;
const BENCH_PROMPT: &str = "Bonjour, peux-tu te présenter en quelques phrases ?";

/// Une mesure : chargement du modèle sur `device`, temps jusqu'au premier token (le prompt), puis tokens/s sur
/// 200 tokens gloutons (sans s'arrêter aux tokens spéciaux).
fn bench_one(folder: &std::path::Path, device: &Device, label: &str) -> Result<Value> {
    let clock = Instant::now();
    let m = store::load_folder(folder, device)?;
    let (prompt, _) = m.chat(&[], BENCH_PROMPT);
    m.stream(&prompt[..1], 1, &Sampling::GREEDY, &mut Rng(0), false, false, &mut |_, _| true).map_err(|e| e.to_string())?; // premier passage : noyaux GPU prêts
    let load = clock.elapsed().as_secs_f64();
    let start = Instant::now();
    let mut first = None;
    let out = m
        .stream(&prompt, BENCH_TOKENS, &Sampling::GREEDY, &mut Rng(0), false, false, &mut |_, _| {
            first.get_or_insert_with(|| start.elapsed().as_secs_f64());
            true
        })
        .map_err(|e| e.to_string())?;
    let total = start.elapsed().as_secs_f64();
    let first = first.unwrap_or(total);
    Ok(json!({
        "device": label,
        "loadSeconds": load,
        "promptTokens": prompt.len(),
        "promptSeconds": first,
        "tokens": out.len(),
        "tokensPerSecond": (out.len().saturating_sub(1)) as f64 / (total - first).max(1e-9),
    }))
}

/// « Tester la vitesse » du modèle actif, sur CPU puis sur GPU s'il est disponible. Fin : « bench-done ».
#[tauri::command]
fn benchmark(app: AppHandle, state: State<AppState>) -> Result<()> {
    let (name, _) = current(&state)?;
    if state.generating.swap(true, Ordering::SeqCst) {
        return Err("une réponse est en cours".into());
    }
    let generating = state.generating.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let folder = store::models_dir().join(&name);
        let mut devices = vec![("cpu", Device::Cpu, "CPU".to_string())];
        if nel_engine::gpu::compiled() && gpu::installed() && let Ok((d, label)) = gpu_device(&state) {
            devices.push(("gpu", d, label));
        }
        let mut error = None;
        for (key, device, label) in devices {
            let _ = app.emit("bench-progress", &label);
            match bench_one(&folder, &device, &label) {
                Ok(r) => {
                    log::info(&format!("test de vitesse « {name} » sur {label} : {:.1} tokens/s", r["tokensPerSecond"].as_f64().unwrap_or(0.0)));
                    if let Err(e) = store::save_benchmark(&name, key, r) {
                        error = Some(e);
                    }
                }
                Err(e) => {
                    log::error(&format!("test de vitesse « {name} » sur {label} : {e}"));
                    error = Some(format!("{label} : {e}"));
                }
            }
        }
        generating.store(false, Ordering::SeqCst);
        let _ = app.emit("bench-done", json!({ "name": name, "error": error, "results": store::load_benchmarks() }));
    });
    Ok(())
}

/// Le lien « Télécharger le pilote NVIDIA » (adresse fixe : l'interface ne peut pas ouvrir autre chose).
#[tauri::command]
fn open_driver_page() -> Result<()> {
    std::process::Command::new("explorer").arg("https://www.nvidia.com/fr-fr/drivers/").spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn benchmarks() -> Value {
    store::load_benchmarks()
}

// --- Catalogue ----------------------------------------------------------------------------------------------

#[tauri::command]
fn catalog() -> Value {
    catalog::list()
}

/// Télécharge, vérifie et installe un modèle du catalogue (« catalog-progress »). Rend quand c'est fini, annulé ou en erreur.
#[tauri::command]
async fn install_catalog_model(app: AppHandle, name: String) -> Result<store::ImportReport> {
    let state = app.state::<AppState>();
    if state.catalog_installing.swap(true, Ordering::SeqCst) {
        return Err("un téléchargement est déjà en cours".into());
    }
    state.catalog_cancel.store(false, Ordering::SeqCst);
    let result = catalog::install(&app, &name, &state.catalog_cancel).await;
    state.catalog_installing.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
fn cancel_catalog(state: State<AppState>) {
    state.catalog_cancel.store(true, Ordering::SeqCst);
}

// --- Fichiers du dossier de travail (lecture seule : Nel Code n'y écrit jamais) ----------------------------

/// Les fichiers du dossier de travail (chemins relatifs, avec des /), sans les dossiers cachés ni ceux de compilation.
#[tauri::command]
fn list_files(dir: String) -> Result<Vec<String>> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("dossier introuvable : {dir}"));
    }
    Ok(agent::walk(&root))
}

/// Lit un fichier texte du dossier de travail, sans pouvoir en sortir (« .. », lien, chemin absolu). Au plus
/// 100 Ko, en UTF-8. Un fichier protégé (.env, *.pem, réglages…) n'est lu qu'avec `confirm` : sinon l'erreur
/// « PROTECTED\t<motif>\t<chemin> » demande à l'interface de poser la question.
#[tauri::command]
fn read_file(dir: String, path: String, confirm: Option<bool>) -> Result<String> {
    let sb = agent::Sandbox::new(&dir)?;
    let abs = sb.resolve(&path).map_err(|e| if e.contains("sort du dossier") || e.contains("« .. »") || e.contains("chemin absolu") { format!("« {path} » n'est pas un fichier du dossier de travail") } else { e })?;
    if let Some(pattern) = sb.protected(&abs)
        && confirm != Some(true)
    {
        return Err(format!("PROTECTED\t{pattern}\t{}", sb.rel(&abs)));
    }
    agent::read_text(&abs, &path)
}

// --- Serveur local (API OpenAI) ----------------------------------------------------------------------------

/// Le port du serveur s'il est actif, l'adresse à donner aux clients, et la clé.
#[tauri::command]
fn server_status(state: State<AppState>) -> Value {
    let port = state.server.lock().unwrap().as_ref().map(|s| s.port);
    let s = store::load_settings();
    json!({ "port": port, "url": format!("http://127.0.0.1:{}/v1", s["serverPort"]), "key": s["serverKey"] })
}

/// Après un changement des réglages : démarre, redémarre ou arrête le serveur.
#[tauri::command]
fn server_apply(app: AppHandle) -> Result<Option<u16>> {
    server::apply(&app)
}

/// Une nouvelle clé d'accès (l'ancienne ne marche plus tout de suite).
#[tauri::command]
fn regenerate_server_key() -> Result<String> {
    let key = server::new_key();
    let mut change = serde_json::Map::new();
    change.insert("serverKey".into(), key.clone().into());
    store::save_settings(&change)?;
    log::info("serveur local : nouvelle clé d'accès");
    Ok(key)
}

// --- Modèles distants (fournisseurs compatibles avec l'API OpenAI) ----------------------------------------

#[tauri::command]
fn list_providers() -> Vec<Value> {
    remote::list()
}

/// `key` : nouvelle clé (vide : retirée ; absente : inchangée), rangée dans le Gestionnaire d'identification.
#[tauri::command]
fn save_provider(id: Option<String>, name: String, url: String, key: Option<String>) -> Result<Value> {
    remote::save(id, &name, &url, key.as_deref())
}

#[tauri::command]
fn delete_provider(id: String) -> Result<()> {
    remote::delete(&id)
}

/// « Tester » : la liste des modèles du fournisseur (GET /v1/models), gardée dans les réglages.
#[tauri::command]
async fn test_provider(id: String) -> Result<Vec<String>> {
    remote::test(&id).await
}

#[tauri::command]
fn import_qwen() -> Result<Value> {
    remote::import_qwen()
}

/// Comme `generate`, avec le modèle `model` du fournisseur `provider` : « gen-token », « gen-reasoning » (la réflexion),
/// puis « gen-done » ({ text, reasoning, reasoningSeconds, … } ou { error }).
#[tauri::command]
fn remote_generate(app: AppHandle, state: State<AppState>, provider: String, model: String, history: Vec<(String, String)>, message: String, options: GenOptions) -> Result<()> {
    if state.generating.swap(true, Ordering::SeqCst) {
        return Err("une réponse est déjà en cours".into());
    }
    state.stop.store(false, Ordering::SeqCst);
    let cancel = Arc::new(tokio::sync::Notify::new());
    *state.remote_cancel.lock().unwrap() = Some(cancel.clone());
    let generating = state.generating.clone();
    tauri::async_runtime::spawn(async move {
        let clock = Instant::now();
        let s = options.sampling();
        let done = match remote::generate(&app, &provider, &model, &history, &message, (s.temperature, s.top_p), cancel).await {
            Ok(r) => json!({
                "text": r.content, "reasoning": r.reasoning, "reasoningSeconds": r.reasoning_seconds, "model": model,
                "tokens": r.tokens, "seconds": clock.elapsed().as_secs_f64(), "stopped": r.stopped,
            }),
            Err(e) => {
                log::error(&format!("modèle distant « {model} » : {e}"));
                json!({ "error": e })
            }
        };
        app.state::<AppState>().remote_cancel.lock().unwrap().take();
        generating.store(false, Ordering::SeqCst);
        let _ = app.emit("gen-done", done);
    });
    Ok(())
}

// --- Mode Agent -------------------------------------------------------------------------------------------

/// Comme `remote_generate`, avec les outils de l'agent dans le dossier de travail `dir` : les étapes partent dans
/// « agent-step », puis « gen-done » ({ …, agent: { request, steps } }).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn agent_generate(app: AppHandle, state: State<AppState>, provider: String, model: String, history: Vec<(String, String)>, message: String, dir: String, options: GenOptions) -> Result<()> {
    if state.generating.swap(true, Ordering::SeqCst) {
        return Err("une réponse est déjà en cours".into());
    }
    state.stop.store(false, Ordering::SeqCst);
    let cancel = Arc::new(tokio::sync::Notify::new());
    *state.remote_cancel.lock().unwrap() = Some(cancel.clone());
    let generating = state.generating.clone();
    let max_turns = store::load_settings()["agentMaxTurns"].as_u64().unwrap_or(10) as usize;
    tauri::async_runtime::spawn(async move {
        let s = options.sampling();
        let done = agent::run(&app, &provider, &model, &history, &message, &dir, (s.temperature, s.top_p), max_turns, cancel).await;
        app.state::<AppState>().remote_cancel.lock().unwrap().take();
        generating.store(false, Ordering::SeqCst);
        let _ = app.emit("gen-done", done);
    });
    Ok(())
}

/// La réponse de l'utilisateur à une écriture : "accept", "reject" ou "accept_all" (pour le reste de la demande).
#[tauri::command]
fn agent_decide(state: State<AppState>, request: String, step: String, decision: String) -> Result<()> {
    if !["accept", "reject", "accept_all"].contains(&decision.as_str()) {
        return Err(format!("décision inconnue : {decision}"));
    }
    let tx = state.approvals.lock().unwrap().remove(&format!("{request}/{step}")).ok_or("cette écriture n'attend plus de réponse")?;
    tx.send(decision).map_err(|_| "la demande est finie".to_string())
}

#[tauri::command]
fn agent_undo(request: String, step: String) -> Result<()> {
    agent::undo(&request, &step)
}

#[tauri::command]
fn agent_undo_all(request: String) -> Result<Vec<String>> {
    agent::undo_all(&request)
}

/// Stop / Échap : le thread de génération s'arrête après le token en cours ; une réponse distante ferme sa connexion.
#[tauri::command]
fn stop_generation(state: State<AppState>) {
    state.stop.store(true, Ordering::SeqCst);
    if let Some(c) = state.remote_cancel.lock().unwrap().as_ref() {
        c.notify_one();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .setup(|app| {
            log::prune();
            gpu::startup();
            log::info(&format!("démarrage de Nel Code {}", env!("CARGO_PKG_VERSION")));
            let config = app.config().app.windows[0].clone();
            #[allow(unused_mut)]
            let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
            // En debug, NELCODE_DEBUG_PORT ouvre le port de débogage de WebView2 (tests de l'interface).
            #[cfg(debug_assertions)]
            if let Ok(port) = std::env::var("NELCODE_DEBUG_PORT") {
                window = window.additional_browser_args(&format!("--remote-debugging-port={port}"));
            }
            window.build()?;
            // Le serveur local, s'il a été activé dans les réglages (une erreur, port pris, est dans le journal).
            let _ = server::apply(app.handle());
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
            log_event,
            bug_report,
            gpu_status,
            install_gpu_pack,
            cancel_gpu_pack,
            remove_gpu_pack,
            benchmark,
            benchmarks,
            open_driver_page,
            catalog,
            install_catalog_model,
            cancel_catalog,
            list_files,
            read_file,
            server_status,
            server_apply,
            regenerate_server_key,
            list_providers,
            save_provider,
            delete_provider,
            test_provider,
            import_qwen,
            remote_generate,
            agent_generate,
            agent_decide,
            agent_undo,
            agent_undo_all,
        ])
        .run(tauri::generate_context!())
        .expect("impossible de lancer Nel Code");
}
