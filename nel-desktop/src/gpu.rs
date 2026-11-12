//! Le pack GPU : les DLL CUDA (redistribuables NVIDIA) dans %APPDATA%\NelCode\gpu, téléchargées à la demande.
//! L'installateur n'en contient aucune. Installation tout ou rien : téléchargement dans gpu.download, empreinte
//! SHA-256 vérifiée, extraction dans gpu.partial, puis renommage en gpu. Tout reste est effacé au démarrage.

use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use nel_engine::gpu::{MIN_DRIVER_CUDA, MIN_DRIVER_TEXT, PACK_DLLS, probe};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

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
            Ok(()) => crate::log::info("pack GPU retiré"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => crate::log::error(&format!("retrait du pack GPU impossible : {e}")),
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

fn free_bytes(path: &std::path::Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut free = 0u64;
    let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
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
        Ok(()) => crate::log::info("pack GPU installé"),
        Err(e) => crate::log::error(&format!("installation du pack GPU : {e}")),
    }
    r
}

async fn install_inner(app: &AppHandle, cancel: &AtomicBool) -> Result<()> {
    if !nel_engine::gpu::compiled() {
        return Err("cette version de Nel Code est compilée sans CUDA".into());
    }
    if installed() {
        return Err("le pack GPU est déjà installé".into());
    }
    if dir().exists() {
        return Err("un retrait du pack est en attente : redémarre Nel Code avant de le réinstaller".into());
    }
    fs::create_dir_all(root()).map_err(|e| e.to_string())?;
    let need = PACK_BYTES + PACK_UNPACKED_BYTES + 50_000_000;
    if let Some(free) = free_bytes(&root())
        && free < need
    {
        return Err(format!("espace disque insuffisant : {} Mo libres, {} Mo nécessaires", free / 1_000_000, need / 1_000_000));
    }
    let mut cleanup = Cleanup(false);

    // Téléchargement, empreinte calculée au fil de l'eau.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder().user_agent("NelCode").build().map_err(|e| e.to_string())?;
    let mut resp = client.get(pack_url()).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("téléchargement impossible : {e}"))?;
    let total = resp.content_length().unwrap_or(PACK_BYTES);
    let mut file = fs::File::create(download()).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut received = 0u64;
    let mut last = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("téléchargement interrompu : {e}"))? {
        if cancel.load(Ordering::SeqCst) {
            return Err("annulé".into());
        }
        received += chunk.len() as u64;
        if received > PACK_BYTES + 1_000_000 {
            return Err("le fichier téléchargé est plus gros que le pack attendu".into());
        }
        hash.update(&chunk);
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| format!("écriture impossible : {e}"))?;
        if received - last > 1_000_000 || received == total {
            last = received;
            let _ = app.emit("gpu-pack-progress", json!({ "received": received, "total": total }));
        }
    }
    drop(file);
    let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if digest != PACK_SHA256 {
        return Err(format!("empreinte SHA-256 incorrecte : le pack est refusé ({digest})"));
    }
    let _ = app.emit("gpu-pack-progress", json!({ "received": received, "total": total, "extracting": true }));

    // Extraction : seulement les fichiers attendus, à plat, dans gpu.partial ; puis gpu.partial devient gpu.
    let _ = fs::remove_dir_all(partial());
    fs::create_dir_all(partial()).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(fs::File::open(download()).map_err(|e| e.to_string())?).map_err(|e| format!("pack illisible : {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().map_err(|e| e.to_string())?.to_string();
        if entry.is_dir() {
            continue;
        }
        if !PACK_DLLS.contains(&name.as_str()) && name != LICENSE_FILE {
            return Err(format!("fichier inattendu dans le pack : {name}"));
        }
        if cancel.load(Ordering::SeqCst) {
            return Err("annulé".into());
        }
        let mut bytes = Vec::new();
        entry.by_ref().take(PACK_UNPACKED_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        fs::write(partial().join(&name), bytes).map_err(|e| format!("{name} : {e}"))?;
    }
    if let Some(missing) = PACK_DLLS.iter().find(|f| !partial().join(f).is_file()) {
        return Err(format!("{missing} manque dans le pack"));
    }
    fs::rename(partial(), dir()).map_err(|e| format!("installation impossible : {e}"))?;
    cleanup.0 = true;
    Ok(())
}

/// Retire le pack. Si les DLL sont chargées (Windows ne permet pas de les effacer), le retrait est fait au prochain
/// démarrage : rend false.
pub fn remove(loaded: bool) -> Result<bool> {
    if loaded {
        fs::write(remove_marker(), b"").map_err(|e| e.to_string())?;
        crate::log::info("retrait du pack GPU au prochain démarrage");
        return Ok(false);
    }
    match fs::remove_dir_all(dir()) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("retrait impossible : {e}")),
    }
    crate::log::info("pack GPU retiré");
    Ok(true)
}
