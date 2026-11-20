//! Les fichiers de Nel Code, partagés avec la version C# : %APPDATA%\NelCode\{models, sessions, settings.json}.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use std::sync::Arc;

use candle_core::{Device, Tensor};
use nel_engine::{ChatModel, Config, GgufModel, MiniGpt, NelModel, Tokenizer};
use serde::Serialize;

pub type Result<T> = std::result::Result<T, String>;

pub fn root() -> PathBuf {
    // NELCODE_HOME : pour les tests, un dossier à part.
    std::env::var_os("NELCODE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("NelCode"))
}

pub fn models_dir() -> PathBuf {
    root().join("models")
}

/// Un nom utilisable comme nom de dossier, sans pouvoir sortir de son dossier ("..", "a\b", "CON").
pub fn valid_name(name: &str) -> bool {
    let n = name.trim();
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3"];
    !n.is_empty()
        && n == name
        && n.len() <= 100
        && !n.chars().any(|c| c < ' ' || r#"<>:"/\|?*"#.contains(c))
        && !n.ends_with('.')
        && !reserved.contains(&n.to_ascii_uppercase().as_str())
}

fn read(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|e| format!("{} : {e}", path.display()))
}

// ---------------------------------------------------------------------------------------------------------
// Modèles

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub name: String,
    pub bytes: u64,
    pub modified: u64, // secondes depuis 1970
    pub parameters: Option<u64>,
    pub block_size: Option<usize>,
    pub weights: &'static str, // "safetensors", "weights.dat" ou "gguf"
    pub license: Option<String>,
}

/// Un modèle ouvert : model.gguf (et son tokenizer.json s'il en a un), avec un model-info.json écrit par Nel Code.
pub const GGUF_FILE: &str = "model.gguf";

fn weights_file(folder: &Path) -> Option<(PathBuf, &'static str)> {
    if folder.join(GGUF_FILE).is_file() {
        return Some((folder.join(GGUF_FILE), "gguf"));
    }
    let st = folder.join("model.safetensors");
    let dat = folder.join("weights.dat");
    if st.is_file() {
        Some((st, "safetensors"))
    } else if dat.is_file() {
        Some((dat, "weights.dat"))
    } else {
        None
    }
}

fn is_model_folder(folder: &Path) -> bool {
    folder.join(GGUF_FILE).is_file() || (folder.join("config.json").is_file() && folder.join("tokenizer.json").is_file() && weights_file(folder).is_some())
}

/// Les modèles installés, du plus récent au plus ancien.
pub fn list_models() -> Vec<ModelEntry> {
    let Ok(dir) = fs::read_dir(models_dir()) else { return vec![] };
    let mut list: Vec<ModelEntry> = dir
        .flatten()
        .filter(|e| is_model_folder(&e.path()))
        .map(|e| {
            let folder = e.path();
            let (weights, kind) = weights_file(&folder).unwrap();
            let meta = fs::metadata(&weights).ok();
            let json = |f: &str| fs::read(folder.join(f)).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
            ModelEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                bytes: meta.as_ref().map_or(0, |m| m.len()),
                modified: meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_secs()),
                parameters: json("model-info.json").and_then(|v| v["parameters"].as_u64()),
                block_size: json("config.json")
                    .and_then(|v| v["BlockSize"].as_u64())
                    .or_else(|| json("model-info.json").and_then(|v| v["contextLength"].as_u64()))
                    .map(|b| b as usize),
                license: json("model-info.json").and_then(|v| v["license"].as_str().map(str::to_string)),
                weights: kind,
            }
        })
        .collect();
    list.sort_by(|a, b| b.modified.cmp(&a.modified));
    list
}

/// Charge un dossier de modèle : model.gguf, ou config.json, tokenizer.json, model.safetensors ou weights.dat.
/// Un modèle GGUF utilise au plus `contextLimit` tokens de contexte (réglages).
pub fn load_folder(folder: &Path, device: &Device) -> Result<Arc<dyn ChatModel>> {
    if folder.join(GGUF_FILE).is_file() {
        let limit = load_settings()["contextLimit"].as_u64().unwrap_or(8192) as usize;
        return Ok(Arc::new(GgufModel::load(&folder.join(GGUF_FILE), device, limit).map_err(|e| e.to_string())?));
    }
    load_counted(folder, device).map(|(m, _)| Arc::new(m) as Arc<dyn ChatModel>)
}

/// Comme load_folder, avec le vrai nombre de paramètres.
fn load_counted(folder: &Path, device: &Device) -> Result<(NelModel, u64)> {
    let config: Config = serde_json::from_slice(&read(&folder.join("config.json"))?).map_err(|e| format!("config.json : {e}"))?;
    let tok = read(&folder.join("tokenizer.json"))?;
    let tokenizer = Tokenizer::from_json(std::str::from_utf8(&tok).map_err(|e| e.to_string())?, config.vocab_size).map_err(|e| e.to_string())?;
    let (weights, kind) = weights_file(folder).ok_or("ni model.safetensors ni weights.dat")?;
    let tensors = if kind == "safetensors" {
        candle_core::safetensors::load(&weights, &Device::Cpu).map_err(|e| format!("model.safetensors : {e}"))?
    } else {
        read_torchsharp(&read(&weights)?)?
    };
    let info = fs::read(folder.join("model-info.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let parameters = tensors.values().map(|t| t.elem_count() as u64).sum();
    let model = MiniGpt::new(config, tensors, device).map_err(|e| e.to_string())?;
    Ok((NelModel { model, tokenizer, info }, parameters))
}

// ---------------------------------------------------------------------------------------------------------
// Import d'un .nelmodel (NELMODEL-FORMAT.md, « Import dans Nel Code »)

/// Les fichiers repris de l'archive, cherchés par leur nom exact à la racine et écrits sous ce même nom :
/// un chemin piégé dans le zip ("..\..\x") ne peut rien écrire ailleurs. weights.dat est gardé pour que
/// Nel Code C# puisse aussi lire le modèle.
const PACKAGE_FILES: [(&str, u64); 6] = [
    ("config.json", 1 << 20),
    ("tokenizer.json", 64 << 20),
    ("model-info.json", 1 << 20),
    ("reference.json", 16 << 20),
    ("model.safetensors", 8 << 30),
    ("weights.dat", 8 << 30),
];
pub const FORMAT_VERSION: u64 = 2;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub name: String,
    pub parameters: u64,
    pub warning: Option<String>,
}

/// Le contenu de model-info.json d'un .nelmodel, vérifié (zip lisible, fichiers présents, formatVersion).
pub fn read_package_info(path: &Path) -> Result<serde_json::Value> {
    let file = fs::File::open(path).map_err(|e| format!("{} : {e}", path.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| format!("« {} » n'est pas une archive zip valide", file_name(path)))?;
    let has = |zip: &zip::ZipArchive<fs::File>, f: &str| zip.index_for_name(f).is_some();
    let mut missing: Vec<&str> = ["config.json", "tokenizer.json", "model-info.json"].into_iter().filter(|f| !has(&zip, f)).collect();
    if !has(&zip, "model.safetensors") && !has(&zip, "weights.dat") {
        missing.push("model.safetensors");
    }
    if !missing.is_empty() {
        return Err(format!("fichier(s) manquant(s) dans le .nelmodel : {}", missing.join(", ")));
    }
    let info: serde_json::Value = serde_json::from_slice(&read_zip_entry(&mut zip, "model-info.json", 1 << 20)?)
        .map_err(|e| format!("model-info.json illisible : {e}"))?;
    match info["formatVersion"].as_u64() {
        None => Err("model-info.json n'indique pas de formatVersion".into()),
        Some(0) => Err("formatVersion 0 invalide".into()),
        Some(v) if v > FORMAT_VERSION => Err(format!(
            "format trop récent (formatVersion {v}, Nel Code lit jusqu'à la version {FORMAT_VERSION}) : mets Nel Code à jour"
        )),
        Some(_) => Ok(info),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Lit une entrée en refusant d'aller au-delà de `limit` octets décompressés (une archive piégée qui
/// annonce une petite taille et se décompresse en énorme est arrêtée).
fn read_zip_entry(zip: &mut zip::ZipArchive<fs::File>, name: &str, limit: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    let entry = zip.by_name(name).map_err(|e| format!("{name} : {e}"))?;
    let mut bytes = Vec::new();
    entry.take(limit + 1).read_to_end(&mut bytes).map_err(|e| format!("{name} : {e}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("{name} est trop gros"));
    }
    Ok(bytes)
}

pub fn temp_folder() -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    root().join("import-tmp").join(format!("{nanos:x}-{}", std::process::id()))
}

/// Le nom proposé pour un .nelmodel : `name` de model-info.json, sinon le nom du fichier.
pub fn suggested_name(path: &Path, info: &serde_json::Value) -> String {
    info["name"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default())
}

/// Installe un .nelmodel sous `name`. Les fichiers vont d'abord dans un dossier temporaire et le modèle y est
/// chargé : il n'apparaît dans la liste que s'il se charge. Un modèle du même nom n'est remplacé (avec
/// `replace`) qu'une fois le nouveau vérifié. Erreur "exists" si le nom est pris et `replace` est faux.
pub fn import(path: &Path, name: &str, replace: bool) -> Result<ImportReport> {
    if !valid_name(name) {
        return Err(format!("« {name} » n'est pas un nom de modèle valide"));
    }
    if is_gguf(path) {
        return import_gguf(path, name, replace, serde_json::json!({ "source": file_name(path) }));
    }
    let info = read_package_info(path)?;
    let target = models_dir().join(name);
    if target.exists() && !replace {
        return Err("exists".into());
    }
    let staging = temp_folder();
    let result = (|| {
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        for (file, limit) in PACKAGE_FILES {
            if zip.index_for_name(file).is_some() {
                fs::write(staging.join(file), read_zip_entry(&mut zip, file, limit)?).map_err(|e| e.to_string())?;
            }
        }
        let (_, parameters) = load_counted(&staging, &Device::Cpu).map_err(|e| format!("le modèle ne se charge pas : {e}"))?;
        install(&staging, &target)?;
        let warning = info["parameters"]
            .as_u64()
            .filter(|&p| p != parameters)
            .map(|p| format!("model-info.json annonce {p} paramètres, le modèle en a {parameters}"));
        Ok(ImportReport { name: name.to_string(), parameters, warning })
    })();
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

pub fn is_gguf(path: &Path) -> bool {
    path.extension().is_some_and(|x| x.eq_ignore_ascii_case("gguf"))
}

/// Les infos d'un .gguf, pour la fenêtre d'import (en-tête, tokenizer et format de chat vérifiés).
pub fn read_gguf_info(path: &Path) -> Result<serde_json::Value> {
    let info = nel_engine::gguf::inspect(path).map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(info).unwrap())
}

/// Installe un .gguf sous `name` : copié (avec le tokenizer.json posé à côté, s'il y en a un) dans un dossier
/// temporaire, model-info.json écrit (infos de l'en-tête, plus `extra`), chargé pour vérifier, puis mis en place.
/// `path` peut déjà être dans le dossier temporaire (catalogue) : il y est alors déplacé, pas copié.
pub fn import_gguf(path: &Path, name: &str, replace: bool, extra: serde_json::Value) -> Result<ImportReport> {
    if !valid_name(name) {
        return Err(format!("« {name} » n'est pas un nom de modèle valide"));
    }
    let target = models_dir().join(name);
    if target.exists() && !replace {
        return Err("exists".into());
    }
    let staging = temp_folder();
    let result = (|| {
        let info = nel_engine::gguf::inspect(path).map_err(|e| e.to_string())?;
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        if path.starts_with(root()) {
            fs::rename(path, staging.join(GGUF_FILE)).map_err(|e| e.to_string())?;
        } else {
            fs::copy(path, staging.join(GGUF_FILE)).map_err(|e| format!("copie impossible : {e}"))?;
        }
        if let Some(tok) = path.parent().map(|d| d.join("tokenizer.json")).filter(|t| t.is_file()) {
            fs::copy(tok, staging.join("tokenizer.json")).map_err(|e| e.to_string())?;
        }
        let mut meta = serde_json::to_value(&info).unwrap();
        meta["format"] = "gguf".into();
        meta["name"] = name.into();
        for (k, v) in extra.as_object().into_iter().flatten() {
            meta[k] = v.clone();
        }
        fs::write(staging.join("model-info.json"), serde_json::to_string_pretty(&meta).unwrap()).map_err(|e| e.to_string())?;
        GgufModel::load(&staging.join(GGUF_FILE), &Device::Cpu, 512).map_err(|e| format!("le modèle ne se charge pas : {e}"))?;
        install(&staging, &target)?;
        Ok(ImportReport { name: name.to_string(), parameters: info.parameters, warning: None })
    })();
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

/// Met staging à la place de target ; l'ancien est mis de côté et remis en place si le déplacement échoue.
fn install(staging: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(models_dir()).map_err(|e| e.to_string())?;
    if !target.exists() {
        return fs::rename(staging, target).map_err(|e| e.to_string());
    }
    let old = temp_folder();
    fs::rename(target, &old).map_err(|e| format!("l'ancien modèle est utilisé ({e})"))?;
    if let Err(e) = fs::rename(staging, target) {
        let _ = fs::rename(&old, target);
        return Err(e.to_string());
    }
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

pub fn delete_model(name: &str) -> Result<()> {
    let folder = models_dir().join(name);
    if !valid_name(name) || !is_model_folder(&folder) {
        return Err(format!("modèle inconnu : « {name} »"));
    }
    fs::remove_dir_all(folder).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------------------
// Conversations : un fichier JSON par conversation, sessions\{id}.json, au format de Nel Code C#
// ({ id, model, workingDirectory, title?, date, messages: [{ role, content, versions? }] }).
// Gardées en JSON brut : un champ inconnu de cette version n'est jamais perdu.

/// Le dossier des conversations ; les images d'une conversation sont dans son sous-dossier `{id}\` (images.rs).
pub fn sessions_dir() -> PathBuf {
    root().join("sessions")
}

/// Toutes les conversations lisibles (un fichier abîmé est ignoré, comme en C#).
pub fn list_sessions() -> Vec<serde_json::Value> {
    let Ok(dir) = fs::read_dir(sessions_dir()) else { return vec![] };
    dir.flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_slice::<serde_json::Value>(&fs::read(e.path()).ok()?).ok())
        .filter(|s| s["id"].is_string() && s["messages"].is_array())
        .collect()
}

/// Écrit à côté puis remplace : une coupure pendant l'écriture ne perd pas la conversation.
pub fn save_session(session: &serde_json::Value) -> Result<()> {
    let id = session["id"].as_str().filter(|id| valid_name(id)).ok_or("conversation sans id valide")?;
    fs::create_dir_all(sessions_dir()).map_err(|e| e.to_string())?;
    let path = sessions_dir().join(format!("{id}.json"));
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(session).unwrap()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn delete_session(id: &str) -> Result<()> {
    if !valid_name(id) {
        return Err("id invalide".into());
    }
    match fs::remove_file(sessions_dir().join(format!("{id}.json"))) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        // Ses images partent avec elle.
        _ => match fs::remove_dir_all(sessions_dir().join(id)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("images de la conversation : {e}")),
            _ => Ok(()),
        },
    }
}

// ---------------------------------------------------------------------------------------------------------
// settings.json, partagé avec Nel Code C# : on ne change que nos clés, le reste (window, theme...) est gardé.
//
// Plusieurs fils l'écrivent (interface, détection des images, clé du serveur, chargement d'un modèle) : chaque
// modification lit, change et réécrit le fichier sous le verrou SETTINGS, et l'écriture remplace le fichier d'un coup
// (fichier temporaire renommé). Sans cela, une lecture pouvait tomber sur le fichier vidé par une écriture en cours,
// repartir de {} et réécrire les réglages sans les fournisseurs.

static SETTINGS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn settings_lock() -> std::sync::MutexGuard<'static, ()> {
    SETTINGS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Le contenu de settings.json : Ok(None) s'il n'existe pas, Err s'il est illisible (après quelques essais : un autre
/// programme, comme Nel Code C#, peut être en train de l'écrire).
fn read_settings() -> Result<Option<serde_json::Value>> {
    let path = root().join("settings.json");
    let mut last = String::new();
    for attempt in 0..5 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        match fs::read(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => last = e.to_string(),
            Ok(b) => match serde_json::from_slice::<serde_json::Value>(&b) {
                Ok(v) if v.is_object() => return Ok(Some(v)),
                _ => last = "pas un objet JSON".into(),
            },
        }
    }
    Err(format!("settings.json illisible ({last})"))
}

pub fn load_settings() -> serde_json::Value {
    let s = {
        let _guard = settings_lock();
        read_settings()
    };
    normalize(s.ok().flatten().unwrap_or_else(|| serde_json::json!({})))
}

/// Modifie les réglages sous le verrou : `change` reçoit les réglages actuels (normalisés). Rend les réglages
/// enregistrés et ce que rend `change`. `change` ne doit pas appeler load_settings ni save_settings (même verrou).
pub fn update_settings<T>(change: impl FnOnce(&mut serde_json::Value) -> Result<T>) -> Result<(serde_json::Value, T)> {
    let _guard = settings_lock();
    let path = root().join("settings.json");
    let current = match read_settings() {
        Ok(s) => s,
        Err(e) => {
            // Jamais écraser des réglages qu'on n'a pas su lire : le fichier est mis de côté.
            fs::rename(&path, root().join("settings.illisible.json")).map_err(|r| format!("{e} ; réglages non enregistrés ({r})"))?;
            crate::log::error(&format!("{e} : mis de côté dans settings.illisible.json"));
            None
        }
    };
    let mut s = normalize(current.unwrap_or_else(|| serde_json::json!({})));
    let out = change(&mut s)?;
    let s = normalize(s);
    fs::create_dir_all(root()).map_err(|e| e.to_string())?;
    let tmp = root().join("settings.json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&s).unwrap()).map_err(|e| e.to_string())?;
    // Le remplacement peut être refusé un instant si un autre programme lit le fichier.
    let mut renamed = fs::rename(&tmp, &path);
    for _ in 0..10 {
        if renamed.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        renamed = fs::rename(&tmp, &path);
    }
    if let Err(e) = renamed {
        let _ = fs::remove_file(&tmp);
        return Err(format!("réglages non enregistrés : {e}"));
    }
    Ok((s, out))
}

/// Les bornes de Nel Code C# (Settings.Clamp*), valeurs par défaut si absentes ou pas des nombres finis.
fn normalize(mut s: serde_json::Value) -> serde_json::Value {
    let num = |v: &serde_json::Value, d: f64| v.as_f64().filter(|x| x.is_finite()).unwrap_or(d);
    s["temperature"] = num(&s["temperature"], 0.8).clamp(0.1, 2.0).into();
    s["topK"] = (num(&s["topK"], 20.0).max(0.0) as u64).into();
    s["topP"] = num(&s["topP"], 0.9).clamp(0.05, 1.0).into();
    s["maxReplyTokens"] = (num(&s["maxReplyTokens"], 80.0).clamp(16.0, 128.0) as u64).into();
    // Arrondi au centième : le curseur des réglages avance de 0,01.
    s["repetitionPenalty"] = ((num(&s["repetitionPenalty"], 1.15).clamp(1.0, 2.0) * 100.0).round() / 100.0).into();
    // Le contexte d'un modèle GGUF (ses 32 768 tokens prendraient trop de mémoire et de temps sur un PC ordinaire).
    s["contextLimit"] = ((num(&s["contextLimit"], 8192.0).clamp(512.0, 131072.0) as u64) / 256 * 256).into();
    // Résumé automatique : part du contexte (en %) à partir de laquelle les anciens échanges sont résumés ; 0 = jamais.
    s["summaryThreshold"] = (num(&s["summaryThreshold"], 80.0).clamp(0.0, 95.0) as u64).into();
    // Images : le plus grand côté après préparation (images.rs).
    s["imageMaxSide"] = (num(&s["imageMaxSide"], crate::images::DEFAULT_MAX_SIDE as f64).clamp(512.0, 4096.0) as u64).into();
    // Le serveur local : désactivé par défaut, port de 1024 à 65535.
    s["serverEnabled"] = s["serverEnabled"].as_bool().unwrap_or(false).into();
    s["serverPort"] = (num(&s["serverPort"], 8765.0).clamp(1024.0, 65535.0) as u64).into();
    // Mode Agent : le nombre maximal de tours (une demande d'outils et son résultat = un tour).
    s["agentMaxTurns"] = (num(&s["agentMaxTurns"], 10.0).clamp(1.0, 50.0) as u64).into();
    // Les explorateurs du mode Agent : combien en même temps (2 : beaucoup de serveurs, comme Ollama, traitent les
    // requêtes l'une après l'autre), combien par demande (0 : pas d'explorateurs), leurs tours, et leur modèle
    // ({ provider, model } ; null : celui de l'agent).
    s["explorerConcurrency"] = (num(&s["explorerConcurrency"], 2.0).clamp(1.0, 8.0) as u64).into();
    s["explorerMax"] = (num(&s["explorerMax"], 5.0).clamp(0.0, 20.0) as u64).into();
    s["explorerTurns"] = (num(&s["explorerTurns"], 6.0).clamp(1.0, 20.0) as u64).into();
    let em = &s["explorerModel"];
    s["explorerModel"] = match (em["provider"].as_str(), em["model"].as_str()) {
        (Some(p), Some(m)) if !p.is_empty() && !m.trim().is_empty() => serde_json::json!({ "provider": p, "model": m }),
        _ => serde_json::Value::Null,
    };
    // Fichiers protégés en plus de ceux par défaut : des motifs, sans vide ni doublon, 200 au plus.
    let mut protected: Vec<String> = Vec::new();
    for p in s["protectedFiles"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).map(|p| p.trim().to_string()) {
        if !p.is_empty() && !protected.contains(&p) && protected.len() < 200 {
            protected.push(p);
        }
    }
    s["protectedFiles"] = protected.into();
    // Commandes du mode Agent : délai maximal (2 min par défaut), et celles autorisées sans confirmation (aucune).
    s["commandTimeout"] = (num(&s["commandTimeout"], 120.0).clamp(1.0, 3600.0) as u64).into();
    // MCP : délais maximaux du démarrage d'un serveur (processus, initialize, tools/list) et d'un appel d'outil.
    s["mcpStartTimeout"] = (num(&s["mcpStartTimeout"], 30.0).clamp(1.0, 300.0) as u64).into();
    s["mcpCallTimeout"] = (num(&s["mcpCallTimeout"], 60.0).clamp(1.0, 3600.0) as u64).into();
    let mut allowed: Vec<String> = Vec::new();
    for c in s["allowedCommands"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).map(|c| c.split_whitespace().collect::<Vec<_>>().join(" ")) {
        if !c.is_empty() && !allowed.contains(&c) && allowed.len() < 100 {
            allowed.push(c);
        }
    }
    s["allowedCommands"] = allowed.into();
    // Claude Agent : mode de permission (rien d'automatique par défaut, ou acceptEdits) et outils autorisés.
    let mode = s["claudePermissionMode"].as_str().filter(|m| crate::claude_agent::PERMISSION_MODES.contains(m)).unwrap_or("default").to_string();
    s["claudePermissionMode"] = mode.into();
    let mut tools: Vec<String> = Vec::new();
    for t in s["claudeAllowedTools"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).map(|t| t.trim().to_string()) {
        if !t.is_empty() && !tools.contains(&t) && tools.len() < 100 {
            tools.push(t);
        }
    }
    s["claudeAllowedTools"] = tools.into();
    let model = s["claudeModel"].as_str().map(str::trim).filter(|m| crate::claude_agent::valid_model(m)).unwrap_or_default().to_string();
    s["claudeModel"] = model.into();
    // Projets : les dossiers de travail récents (12 au plus, sans doublon à la casse près), le projet affiché.
    let mut recent: Vec<String> = Vec::new();
    for p in s["recentProjects"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).map(|p| p.trim().trim_end_matches(['\\', '/']).to_string()) {
        if !p.is_empty() && !recent.iter().any(|r| r.eq_ignore_ascii_case(&p)) && recent.len() < 12 {
            recent.push(p);
        }
    }
    s["recentProjects"] = recent.into();
    if !s["currentProject"].is_string() {
        s["currentProject"] = "".into();
    }
    // Interface : taille du texte (80 à 150 %, par pas de 10), panneau Fichiers ouvert, premier lancement fait.
    s["textSize"] = ((num(&s["textSize"], 100.0).clamp(80.0, 150.0) / 10.0).round() as u64 * 10).into();
    s["filesPanel"] = s["filesPanel"].as_bool().unwrap_or(false).into();
    s["onboarded"] = s["onboarded"].as_bool().unwrap_or(false).into();
    // Suivi : la table de prix modifiée (absente : celle par défaut, voir usage.rs), le budget mensuel en dollars
    // (0 : aucun) et la confirmation à 100 % (activée par défaut).
    match crate::usage::clean_prices(&s["prices"]) {
        Some(p) => s["prices"] = p,
        None => {
            s.as_object_mut().unwrap().remove("prices");
        }
    }
    s["budgetMonthly"] = ((num(&s["budgetMonthly"], 0.0).clamp(0.0, 1e6) * 100.0).round() / 100.0).into();
    s["budgetConfirm"] = s["budgetConfirm"].as_bool().unwrap_or(true).into();
    s
}

pub fn save_settings(changes: &serde_json::Map<String, serde_json::Value>) -> Result<serde_json::Value> {
    update_settings(|s| {
        for (k, v) in changes {
            s[k] = v.clone();
        }
        Ok(())
    })
    .map(|(s, ())| s)
}

// ---------------------------------------------------------------------------------------------------------
// benchmarks.json : les tests de vitesse, { "<modèle>": { "cpu": {...}, "gpu": {...} } }, le dernier par périphérique.

pub fn load_benchmarks() -> serde_json::Value {
    fs::read(root().join("benchmarks.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}

pub fn save_benchmark(model: &str, device: &str, mut result: serde_json::Value) -> Result<()> {
    let mut all = load_benchmarks();
    result["date"] = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis().to_string().into();
    if !all[model].is_object() {
        all[model] = serde_json::json!({});
    }
    all[model][device] = result;
    fs::write(root().join("benchmarks.json"), serde_json::to_string_pretty(&all).unwrap()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------------------
// arena.json : les votes du mode comparaison, { votes: [{ id, a, b, winner: "a" | "b" | "tie", date }] }.
// `id` (conversation#message) : revoter sur la même réponse remplace l'ancien vote.

pub fn load_arena() -> serde_json::Value {
    fs::read(root().join("arena.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .filter(|v| v["votes"].is_array())
        .unwrap_or_else(|| serde_json::json!({ "votes": [] }))
}

pub fn arena_vote(vote: serde_json::Value) -> Result<serde_json::Value> {
    let str_of = |k: &str| vote[k].as_str().filter(|s| !s.is_empty());
    let (Some(id), Some(_), Some(_), Some(winner)) = (str_of("id"), str_of("a"), str_of("b"), str_of("winner")) else {
        return Err("vote incomplet".into());
    };
    if !["a", "b", "tie"].contains(&winner) {
        return Err(format!("vote inconnu : {winner}"));
    }
    let mut arena = load_arena();
    let votes = arena["votes"].as_array_mut().unwrap();
    votes.retain(|v| v["id"].as_str() != Some(id));
    votes.push(vote);
    fs::create_dir_all(root()).map_err(|e| e.to_string())?;
    let path = root().join("arena.json");
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&arena).unwrap()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(arena)
}

// ---------------------------------------------------------------------------------------------------------

/// weights.dat de TorchSharp (`module.save`) : nombre de tenseurs, puis pour chacun son nom, son type,
/// sa forme et ses données brutes (little-endian). Les entiers sont en LEB128, le nom en UTF-8 préfixé
/// de sa longueur (BinaryWriter de .NET). Seul le type 6 (float32) est accepté.
pub fn read_torchsharp(bytes: &[u8]) -> Result<HashMap<String, Tensor>> {
    let bad = || "weights.dat tronqué ou illisible".to_string();
    let mut pos = 0usize;
    let leb = |pos: &mut usize| -> Result<u64> {
        let (mut v, mut shift) = (0u64, 0);
        loop {
            let b = *bytes.get(*pos).ok_or_else(bad)?;
            *pos += 1;
            if shift > 63 {
                return Err(bad());
            }
            v |= ((b & 0x7f) as u64) << shift;
            shift += 7;
            if b < 0x80 {
                return Ok(v);
            }
        }
    };
    let count = leb(&mut pos)?;
    let mut map = HashMap::new();
    for _ in 0..count {
        let len = leb(&mut pos)? as usize;
        let name = std::str::from_utf8(bytes.get(pos..pos.checked_add(len).ok_or_else(bad)?).ok_or_else(bad)?).map_err(|_| bad())?.to_string();
        pos += len;
        let dtype = leb(&mut pos)?;
        if dtype != 6 {
            return Err(format!("weights.dat : {name} n'est pas en float32 (type {dtype})"));
        }
        let ndim = leb(&mut pos)? as usize;
        if ndim > 8 {
            return Err(bad());
        }
        let shape = (0..ndim).map(|_| leb(&mut pos).map(|d| d as usize)).collect::<Result<Vec<_>>>()?;
        let n: usize = shape.iter().try_fold(1usize, |a, &d| a.checked_mul(d)).ok_or_else(bad)?;
        let end = n.checked_mul(4).and_then(|b| pos.checked_add(b)).ok_or_else(bad)?;
        let data = bytes.get(pos..end).ok_or_else(bad)?;
        pos = end;
        let values: Vec<f32> = data.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        map.insert(name, Tensor::from_vec(values, shape, &Device::Cpu).map_err(|e| e.to_string())?);
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_model() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-models/minichat-v3b.nelmodel")
    }

    #[test]
    fn weights_dat_egal_safetensors() {
        let dat = read_torchsharp(&nel_engine::read_entry(&test_model(), "weights.dat").unwrap()).unwrap();
        let st = candle_core::safetensors::load_buffer(&nel_engine::read_entry(&test_model(), "model.safetensors").unwrap(), &Device::Cpu).unwrap();
        assert_eq!(dat.len(), 58);
        assert_eq!(dat.len(), st.len());
        for (name, t) in &st {
            let d = &dat[name];
            assert_eq!(d.dims(), t.dims(), "{name}");
            let (a, b) = (d.flatten_all().unwrap().to_vec1::<f32>().unwrap(), t.flatten_all().unwrap().to_vec1::<f32>().unwrap());
            assert!(a.iter().zip(&b).all(|(x, y)| x.to_bits() == y.to_bits()), "{name}");
        }
        assert!(read_torchsharp(&[1, 3, b'a']).is_err());
    }

    /// Un .nelmodel fait à la main : les fichiers du modèle de test, sauf `skip`, plus `extra`.
    fn package(dir: &Path, file: &str, skip: &[&str], extra: &[(&str, &[u8])]) -> PathBuf {
        use std::io::Write;
        let path = dir.join(file);
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for f in ["config.json", "tokenizer.json", "model-info.json", "model.safetensors"] {
            if !skip.contains(&f) {
                zip.start_file(f, opts).unwrap();
                zip.write_all(&nel_engine::read_entry(&test_model(), f).unwrap()).unwrap();
            }
        }
        for (name, bytes) in extra {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    /// Les tests qui changent NELCODE_HOME (et appellent root()) passent l'un après l'autre.
    static HOME: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn home(name: &str) -> (PathBuf, std::sync::MutexGuard<'static, ()>) {
        let guard = HOME.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("nelcode-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        // SAFETY : seuls les tests qui tiennent HOME lisent NELCODE_HOME (les autres n'appellent pas root()).
        unsafe { std::env::set_var("NELCODE_HOME", &home) };
        (home, guard)
    }

    #[test]
    fn images_de_la_conversation() {
        let (home, _guard) = home("images");
        let session = serde_json::json!({ "id": "2026-01-01_00-00-00-000", "model": "v3", "messages": [] });
        save_session(&session).unwrap();
        // Ses images : dans son dossier, jamais avec un chemin dans le nom, supprimées avec elle.
        let mut png = Vec::new();
        image::RgbImage::from_pixel(4, 3, image::Rgb([9, 9, 9])).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        let data = format!("data:image/png;base64,{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png));
        let img = crate::images::prepare_data("2026-01-01_00-00-00-000", &data, "C:\\photos\\vacances.png").unwrap();
        assert_eq!((img["name"].as_str(), img["width"].as_u64(), img["height"].as_u64()), (Some("vacances.png"), Some(4), Some(3)));
        let file = img["file"].as_str().unwrap();
        assert!(home.join("sessions/2026-01-01_00-00-00-000").join(file).is_file());
        assert!(crate::images::data_url("2026-01-01_00-00-00-000", file).unwrap().starts_with("data:image/png;base64,iVBOR"));
        assert_eq!(list_sessions(), vec![session], "le dossier d'images n'est pas une conversation");
        delete_session("2026-01-01_00-00-00-000").unwrap();
        assert!(list_sessions().is_empty());
        assert!(!home.join("sessions/2026-01-01_00-00-00-000").exists(), "images supprimées avec la conversation");
        // Une image ajoutée à une conversation jamais gardée : son dossier est retiré au démarrage.
        crate::images::prepare_data("2026-01-02_00-00-00-000", &data, "x.png").unwrap();
        fs::create_dir_all(home.join("sessions/autre")).unwrap();
        fs::write(home.join("sessions/autre/notes.txt"), "à moi").unwrap();
        crate::images::clean_orphans();
        assert!(!home.join("sessions/2026-01-02_00-00-00-000").exists());
        assert!(home.join("sessions/autre/notes.txt").exists(), "un dossier qui n'est pas à Nel Code n'est pas touché");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn reglages_ecrits_en_meme_temps() {
        let (home, _guard) = home("reglages");
        fs::write(home.join("settings.json"), r#"{"theme":"dark","providers":[{"id":"p1","models":[]}]}"#).unwrap();
        // Des fils qui modifient chacun leur clé, d'autres qui ajoutent un modèle au fournisseur, d'autres qui lisent :
        // aucune lecture ne voit les réglages sans le fournisseur, aucune modification n'en efface une autre.
        std::thread::scope(|t| {
            for i in 0..8 {
                t.spawn(move || {
                    for j in 0..10 {
                        let mut c = serde_json::Map::new();
                        c.insert(format!("k{i}"), j.into());
                        save_settings(&c).unwrap();
                        update_settings(|s| {
                            s["providers"][0]["models"].as_array_mut().unwrap().push(format!("m{i}-{j}").into());
                            Ok(())
                        })
                        .unwrap();
                    }
                });
                t.spawn(|| {
                    for _ in 0..30 {
                        let s = load_settings();
                        assert_eq!(s["providers"][0]["id"], "p1", "réglages lus à moitié écrits");
                        assert_eq!(s["theme"], "dark");
                    }
                });
            }
        });
        let s = load_settings();
        for i in 0..8 {
            assert_eq!(s[format!("k{i}")], 9);
        }
        assert_eq!(s["providers"][0]["models"].as_array().unwrap().len(), 80);
        assert!(!home.join("settings.json.tmp").exists());

        // Un fichier illisible n'est jamais écrasé : il est mis de côté.
        fs::write(home.join("settings.json"), "{ pas du json").unwrap();
        let mut c = serde_json::Map::new();
        c.insert("topK".into(), 5.into());
        assert_eq!(save_settings(&c).unwrap()["topK"], 5);
        assert_eq!(fs::read_to_string(home.join("settings.illisible.json")).unwrap(), "{ pas du json");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn import_nelmodel() {
        let (home, _guard) = home("test");
        fs::write(home.join("settings.json"), r#"{"theme":"dark","window":{"x":1},"topK":7}"#).unwrap();

        // Le vrai .nelmodel s'installe, avec ses fichiers, et passe dans la liste.
        let report = import(&test_model(), "v3", false).unwrap();
        assert_eq!(report.parameters, 27_746_816);
        assert!(report.warning.is_none());
        for f in ["config.json", "tokenizer.json", "model-info.json", "model.safetensors", "weights.dat", "reference.json"] {
            assert!(home.join("models/v3").join(f).is_file(), "{f}");
        }
        assert_eq!(list_models()[0].name, "v3");
        assert_eq!(import(&test_model(), "v3", false).unwrap_err(), "exists");
        import(&test_model(), "v3", true).unwrap();
        assert!(import(&test_model(), "../x", false).is_err());

        // Refus : pas un zip, fichier manquant, version trop récente ; un chemin piégé n'écrit rien dehors.
        let bad = home.join("bad.nelmodel");
        fs::write(&bad, b"pas un zip").unwrap();
        assert!(import(&bad, "b", false).unwrap_err().contains("zip"));
        let p = package(&home, "missing.nelmodel", &["tokenizer.json"], &[]);
        assert!(import(&p, "b", false).unwrap_err().contains("tokenizer.json"));
        let p = package(&home, "v9.nelmodel", &["model-info.json"], &[("model-info.json", br#"{"formatVersion":9}"#)]);
        assert!(import(&p, "b", false).unwrap_err().contains("trop récent"));
        let p = package(&home, "evil.nelmodel", &[], &[("../evil.txt", b"x"), ("sub/config.json", b"x")]);
        import(&p, "evil", false).unwrap();
        assert!(!home.join("models/evil.txt").exists() && !home.join("evil.txt").exists());
        assert!(!home.join("models/evil/sub").exists());
        assert_eq!(fs::read_dir(home.join("import-tmp")).unwrap().count(), 0, "dossier temporaire nettoyé");

        // Réglages : nos clés bornées, les autres gardées.
        let mut changes = serde_json::Map::new();
        changes.insert("temperature".into(), 5.0.into());
        let s = save_settings(&changes).unwrap();
        assert_eq!((s["temperature"].as_f64(), s["topK"].as_u64(), s["window"]["x"].as_u64()), (Some(2.0), Some(7), Some(1)));

        // Conversations : aller-retour sans perte d'un champ inconnu.
        let session = serde_json::json!({ "id": "2026-01-01_00-00-00-000", "model": "v3", "messages": [], "futur": 1 });
        save_session(&session).unwrap();
        assert_eq!(list_sessions(), vec![session.clone()]);
        delete_session("2026-01-01_00-00-00-000").unwrap();
        assert!(list_sessions().is_empty());
        assert!(save_session(&serde_json::json!({ "id": "../x", "messages": [] })).is_err());

        // Arène : un vote par réponse (revoter remplace), votes invalides refusés.
        assert_eq!(load_arena()["votes"].as_array().unwrap().len(), 0);
        arena_vote(serde_json::json!({ "id": "s#1", "a": "v3", "b": "v4", "winner": "a" })).unwrap();
        let arena = arena_vote(serde_json::json!({ "id": "s#1", "a": "v3", "b": "v4", "winner": "tie" })).unwrap();
        assert_eq!(arena["votes"].as_array().unwrap().len(), 1);
        assert_eq!(load_arena()["votes"][0]["winner"], "tie");
        assert!(arena_vote(serde_json::json!({ "id": "s#2", "a": "v3", "b": "v4", "winner": "x" })).is_err());

        // Un .gguf : refusé s'il est faux ; sinon copié avec son model-info.json, dans la liste, contexte limité à 8192.
        let fake = home.join("faux.gguf");
        fs::write(&fake, b"GGUF pas vraiment").unwrap();
        assert!(import(&fake, "faux", false).unwrap_err().contains("gguf"));
        let gguf = test_model().with_file_name("qwen2.5-coder-0.5b-instruct-q4_k_m.gguf");
        if gguf.is_file() {
            import(&gguf, "qwen", false).unwrap();
            let e = list_models().into_iter().find(|m| m.name == "qwen").unwrap();
            assert_eq!((e.weights, e.block_size), ("gguf", Some(32768)));
            assert_eq!(load_folder(&models_dir().join("qwen"), &Device::Cpu).unwrap().context_size(), 8192);
            assert_eq!(import(&gguf, "qwen", false).unwrap_err(), "exists");
        }
        assert_eq!(fs::read_dir(home.join("import-tmp")).unwrap().count(), 0, "dossier temporaire nettoyé");
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn noms_valides() {
        assert!(valid_name("minichat-v3"));
        for bad in ["", " a", "..", ".", "a/b", r"a\b", "con", "x:y", "a."] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn reglages_des_explorateurs() {
        let s = normalize(serde_json::json!({}));
        assert_eq!((s["explorerConcurrency"].as_u64(), s["explorerMax"].as_u64(), s["explorerTurns"].as_u64()), (Some(2), Some(5), Some(6)));
        assert!(s["explorerModel"].is_null());
        let s = normalize(serde_json::json!({ "explorerConcurrency": 99, "explorerMax": -3, "explorerTurns": 0, "explorerModel": { "provider": "p1", "model": "qwen3:4b" } }));
        assert_eq!((s["explorerConcurrency"].as_u64(), s["explorerMax"].as_u64(), s["explorerTurns"].as_u64()), (Some(8), Some(0), Some(1)));
        assert_eq!(s["explorerModel"], serde_json::json!({ "provider": "p1", "model": "qwen3:4b" }));
        for bad in [serde_json::json!("p1/qwen"), serde_json::json!({ "provider": "", "model": "m" }), serde_json::json!({ "provider": "p" })] {
            assert!(normalize(serde_json::json!({ "explorerModel": bad })) ["explorerModel"].is_null());
        }
    }
}
