// Pas de console derrière la fenêtre en version publiée.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "cuda")]
mod delayload;
mod gpu;
mod log;
mod store;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use nel_engine::{Device, MAX_ANSWER_TOKENS, NelModel, Rng, Sampling};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use store::Result;

struct Loaded {
    name: String,
    model: Arc<NelModel>,
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
    device: Option<String>,
}

#[tauri::command]
fn model_status(state: State<AppState>) -> ModelStatus {
    let model = state.model.lock().unwrap();
    ModelStatus {
        name: model.as_ref().map(|m| m.name.clone()),
        loading: state.loading.lock().unwrap().clone(),
        block_size: model.as_ref().map(|m| m.model.model.config.block_size),
        parameters: model.as_ref().and_then(|m| m.model.info["parameters"].as_u64()),
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
                let block_size = model.model.config.block_size;
                log::info(&format!("modèle « {name} » chargé en {:.2} s sur {label} (contexte {block_size})", clock.elapsed().as_secs_f64()));
                *state.model.lock().unwrap() = Some(Loaded { name: name.clone(), model: Arc::new(model), device: label.clone() });
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
    let (device, label) = pick_device(state);
    let clock = Instant::now();
    let model = Arc::new(store::load_folder(&store::models_dir().join(name), &device).inspect_err(|e| log::error(&format!("comparaison : « {name} » ne se charge pas : {e}")))?);
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
    m.logits(&m.tokenizer.encode("<|doc|>")).map_err(|e| e.to_string())?; // premier passage : noyaux GPU prêts
    let load = clock.elapsed().as_secs_f64();
    let prompt = m.chat_prompt(&[], BENCH_PROMPT);
    let start = Instant::now();
    let mut first = None;
    let out = m
        .generate(&prompt, BENCH_TOKENS, &Sampling::GREEDY, &mut Rng(0), false, |_| {
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
        ])
        .run(tauri::generate_context!())
        .expect("impossible de lancer Nel Code");
}
