//! Le pack GPU : les DLL CUDA (redistribuables NVIDIA) dans %APPDATA%\NelCode\gpu, téléchargées à la demande.
//! L'installateur n'en contient aucune. Installation tout ou rien : téléchargement dans gpu.download, empreinte
//! SHA-256 vérifiée, extraction dans gpu.partial, puis renommage en gpu. Tout reste est effacé au démarrage.

use crate::t;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use nel_engine::gpu::{MIN_DRIVER_CUDA, MIN_DRIVER_TEXT, PACK_DLLS, probe};
use serde_json::{Value, json};
use tauri::AppHandle;

use crate::store::{Result, root};

/// Le pack publié (make-gpu-pack.ps1, release « gpu-pack-cuda12 »). L'empreinte est vérifiée avant toute extraction.
pub const PACK_URL: &str = "https://github.com/nelsogi/nelcode-rs/releases/download/gpu-pack-cuda12/nelcode-gpu-pack-cuda12.zip";
pub const PACK_SHA256: &str = "d60db45e35d1ff81cb826f28f6933cc1574455733602cc28c1fdd879fdf386dc";
/// Taille du zip, et des fichiers une fois extraits (pour l'espace disque).
pub const PACK_BYTES: u64 = 621411904;
pub const PACK_UNPACKED_BYTES: u64 = 851037832;
/// Le pack contient les DLL et l'avis de licence de NVIDIA, rien d'autre.
pub const LICENSE_FILE: &str = "NVIDIA-LICENSE.txt";

/// L'adresse du pack. En debug, NELCODE_GPU_PACK_URL la remplace (tests de l'interface, serveur local) ;
/// l'empreinte attendue reste PACK_SHA256.
fn pack_url() -> String {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("NELCODE_GPU_PACK_URL") {
        return url;
    }
    PACK_URL.into()
}

pub fn dir() -> PathBuf {
    root().join("gpu")
}

fn partial() -> PathBuf {
    root().join("gpu.partial")
}

fn download() -> PathBuf {
    root().join("gpu.download")
}

/// Retrait demandé alors que les DLL étaient chargées : fait au prochain démarrage.
fn remove_marker() -> PathBuf {
    root().join("gpu.remove")
}

pub fn installed() -> bool {
    !remove_marker().exists() && PACK_DLLS.iter().all(|f| dir().join(f).is_file())
}

/// Au démarrage, avant tout chargement : retrait en attente, restes d'une installation interrompue.
pub fn startup() {
    if remove_marker().exists() {
        match fs::remove_dir_all(dir()) {
            Ok(()) => crate::log::info("GPU pack removed"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => crate::log::error(&format!("cannot remove the GPU pack: {e}")),
        }
        let _ = fs::remove_file(remove_marker());
    }
    let _ = fs::remove_dir_all(partial());
    let _ = fs::remove_file(download());
}

/// Pour la section Calcul des réglages. `active` : le GPU déjà essayé (libellé, ou l'erreur).
pub fn status(active: Option<&std::result::Result<String, String>>) -> Value {
    let p = probe();
    json!({
        "compiled": nel_engine::gpu::compiled(),
        "card": p.card,
        "driver": p.driver,
        "driverCuda": p.driver_cuda.map(|(a, b)| format!("{a}.{b}")),
        "driverOk": p.driver_ok(),
        "needCuda": format!("{}.{}", MIN_DRIVER_CUDA.0, MIN_DRIVER_CUDA.1),
        "needDriver": MIN_DRIVER_TEXT,
        "installed": installed(),
        "packBytes": PACK_BYTES,
        "active": active.and_then(|r| r.as_ref().ok()),
        "error": active.and_then(|r| r.as_ref().err()),
    })
}

/// Efface le téléchargement et l'extraction en cours si l'installation n'arrive pas au bout.
struct Cleanup(bool);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(download());
        if !self.0 {
            let _ = fs::remove_dir_all(partial());
        }
    }
}

pub async fn install(app: &AppHandle, cancel: &AtomicBool) -> Result<()> {
    let r = install_inner(app, cancel).await;
    match &r {
        Ok(()) => crate::log::info("GPU pack installed"),
        Err(e) => crate::log::error(&format!("GPU pack installation: {e}")),
    }
    r
}

async fn install_inner(app: &AppHandle, cancel: &AtomicBool) -> Result<()> {
    if !nel_engine::gpu::compiled() {
        return Err(t!("rs.gpu.no_cuda"));
    }
    if installed() {
        return Err(t!("rs.gpu.installed"));
    }
    if dir().exists() {
        return Err(t!("rs.gpu.removal_pending"));
    }
    fs::create_dir_all(root()).map_err(|e| e.to_string())?;
    let need = PACK_BYTES + PACK_UNPACKED_BYTES + 50_000_000;
    if let Some(free) = crate::os::free_bytes(&root())
        && free < need
    {
        return Err(t!("rs.disk.space", free = free / 1_000_000, need = need / 1_000_000));
    }
    let mut cleanup = Cleanup(false);

    crate::catalog::download(app, &pack_url(), &download(), PACK_SHA256, PACK_BYTES, cancel, "gpu-pack-progress", serde_json::Value::Null).await?;

    // Extraction : seulement les fichiers attendus, à plat, dans gpu.partial ; puis gpu.partial devient gpu.
    let _ = fs::remove_dir_all(partial());
    fs::create_dir_all(partial()).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(fs::File::open(download()).map_err(|e| e.to_string())?).map_err(|e| t!("rs.gpu.unreadable", error = e.to_string()))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().map_err(|e| e.to_string())?.to_string();
        if entry.is_dir() {
            continue;
        }
        if !PACK_DLLS.contains(&name.as_str()) && name != LICENSE_FILE {
            return Err(t!("rs.gpu.unexpected", name = name));
        }
        if cancel.load(Ordering::SeqCst) {
            return Err("annulé".into());
        }
        let mut bytes = Vec::new();
        entry.by_ref().take(PACK_UNPACKED_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        fs::write(partial().join(&name), bytes).map_err(|e| format!("{name} : {e}"))?;
    }
    if let Some(missing) = PACK_DLLS.iter().find(|f| !partial().join(f).is_file()) {
        return Err(t!("rs.gpu.missing", name = missing));
    }
    fs::rename(partial(), dir()).map_err(|e| t!("rs.gpu.install_failed", error = e.to_string()))?;
    cleanup.0 = true;
    Ok(())
}

/// Retire le pack. Si les DLL sont chargées (Windows ne permet pas de les effacer), le retrait est fait au prochain
/// démarrage : rend false.
pub fn remove(loaded: bool) -> Result<bool> {
    if loaded {
        fs::write(remove_marker(), b"").map_err(|e| e.to_string())?;
        crate::log::info("GPU pack removed at the next startup");
        return Ok(false);
    }
    match fs::remove_dir_all(dir()) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(t!("rs.gpu.remove_failed", error = e.to_string())),
    }
    crate::log::info("GPU pack removed");
    Ok(true)
}
