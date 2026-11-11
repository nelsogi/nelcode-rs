//! Les fichiers de Nel Code, partagés avec la version C# : %APPDATA%\NelCode\{models, sessions, settings.json}.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use candle_core::{Device, Tensor};
use nel_engine::{Config, MiniGpt, NelModel, Tokenizer};
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
    pub weights: &'static str, // "safetensors" ou "weights.dat"
}

fn weights_file(folder: &Path) -> Option<(PathBuf, &'static str)> {
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
    folder.join("config.json").is_file() && folder.join("tokenizer.json").is_file() && weights_file(folder).is_some()
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
                block_size: json("config.json").and_then(|v| v["BlockSize"].as_u64()).map(|b| b as usize),
                weights: kind,
            }
        })
        .collect();
    list.sort_by(|a, b| b.modified.cmp(&a.modified));
    list
}

/// Charge un dossier de modèle (config.json, tokenizer.json, model.safetensors ou weights.dat).
pub fn load_folder(folder: &Path) -> Result<NelModel> {
    load_counted(folder).map(|(m, _)| m)
}

/// Comme load_folder, avec le vrai nombre de paramètres.
fn load_counted(folder: &Path) -> Result<(NelModel, u64)> {
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
    let model = MiniGpt::new(config, tensors).map_err(|e| e.to_string())?;
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

fn temp_folder() -> PathBuf {
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
        let (_, parameters) = load_counted(&staging).map_err(|e| format!("le modèle ne se charge pas : {e}"))?;
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

fn sessions_dir() -> PathBuf {
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
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------------------------------------
// settings.json, partagé avec Nel Code C# : on ne change que nos clés, le reste (window, theme...) est gardé.

pub fn load_settings() -> serde_json::Value {
    let s = fs::read(root().join("settings.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
    normalize(s.filter(|v: &serde_json::Value| v.is_object()).unwrap_or_else(|| serde_json::json!({})))
}

/// Les bornes de Nel Code C# (Settings.Clamp*), valeurs par défaut si absentes ou pas des nombres finis.
fn normalize(mut s: serde_json::Value) -> serde_json::Value {
    let num = |v: &serde_json::Value, d: f64| v.as_f64().filter(|x| x.is_finite()).unwrap_or(d);
    s["temperature"] = num(&s["temperature"], 0.8).clamp(0.1, 2.0).into();
    s["topK"] = (num(&s["topK"], 20.0).max(0.0) as u64).into();
    s["topP"] = num(&s["topP"], 0.9).clamp(0.05, 1.0).into();
    s["maxReplyTokens"] = (num(&s["maxReplyTokens"], 80.0).clamp(16.0, 128.0) as u64).into();
    s
}

pub fn save_settings(changes: &serde_json::Map<String, serde_json::Value>) -> Result<serde_json::Value> {
    let mut s = load_settings();
    for (k, v) in changes {
        s[k] = v.clone();
    }
    let s = normalize(s);
    fs::create_dir_all(root()).map_err(|e| e.to_string())?;
    fs::write(root().join("settings.json"), serde_json::to_string_pretty(&s).unwrap()).map_err(|e| e.to_string())?;
    Ok(s)
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

    #[test]
    fn import_nelmodel() {
        let home = std::env::temp_dir().join(format!("nelcode-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        // SAFETY : seul ce test lit NELCODE_HOME (les autres n'appellent pas root()).
        unsafe { std::env::set_var("NELCODE_HOME", &home) };
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
        assert_eq!(list_sessions(), vec![session]);
        delete_session("2026-01-01_00-00-00-000").unwrap();
        assert!(list_sessions().is_empty());
        assert!(save_session(&serde_json::json!({ "id": "../x", "messages": [] })).is_err());
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn noms_valides() {
        assert!(valid_name("minichat-v3"));
        for bad in ["", " a", "..", ".", "a/b", r"a\b", "con", "x:y", "a."] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }
}
