//! Le catalogue : quelques modèles ouverts vérifiés, téléchargés depuis Hugging Face à une révision fixe, empreinte
//! SHA-256 écrite ici et vérifiée avant l'installation. Aussi le téléchargement vérifié du pack GPU.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::store::{self, Result};

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Le nom du modèle installé (dossier dans models).
    pub name: &'static str,
    pub description: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
    pub parameters: &'static str,
    /// Vérifiée sur la page Hugging Face du modèle (16.11.2026), affichée avant le téléchargement.
    pub license: &'static str,
    pub license_url: &'static str,
    pub page: &'static str,
}

pub const CATALOG: [Entry; 2] = [
    Entry {
        name: "Qwen2.5-Coder-0.5B-Instruct",
        description: "Petit modèle de code d'Alibaba (Qwen), rapide même sur CPU. Quantifié Q4_K_M.",
        url: "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/ebb2015119c907b064c512bf053e945850b5875f/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
        sha256: "1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32",
        bytes: 491_400_064,
        parameters: "0,5 milliard",
        license: "Apache 2.0",
        license_url: "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/blob/main/LICENSE",
        page: "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF",
    },
    Entry {
        name: "Qwen2.5-Coder-1.5B-Instruct",
        description: "Modèle de code d'Alibaba (Qwen), meilleur que le 0.5B, plus lent. Quantifié Q4_K_M.",
        url: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/f86cb2c1fa58255f8052cc32aeede1b7482d4361/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
        sha256: "cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046",
        bytes: 1_117_320_768,
        parameters: "1,5 milliard",
        license: "Apache 2.0",
        license_url: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/blob/main/LICENSE",
        page: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
    },
];

/// L'adresse d'un modèle. En debug, NELCODE_CATALOG_URL remplace le début (tests de l'interface, serveur local :
/// `{NELCODE_CATALOG_URL}/{nom du fichier}`) ; l'empreinte attendue reste celle du catalogue.
fn url_of(e: &Entry) -> String {
    #[cfg(debug_assertions)]
    if let Ok(base) = std::env::var("NELCODE_CATALOG_URL") {
        return format!("{base}/{}", e.url.rsplit('/').next().unwrap());
    }
    e.url.into()
}

pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut free = 0u64;
    let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
}

/// Télécharge `url` dans `dest`, empreinte calculée au fil de l'eau et comparée à `sha256` : un fichier faux est
/// effacé. Progression dans l'événement `event` ({ received, total } plus `tag`). Refuse plus de `bytes` + 1 Mo.
#[allow(clippy::too_many_arguments)]
pub async fn download(app: &AppHandle, url: &str, dest: &Path, sha256: &str, bytes: u64, cancel: &AtomicBool, event: &str, tag: serde_json::Value) -> Result<()> {
    let r = download_inner(app, url, dest, sha256, bytes, cancel, event, tag).await;
    if r.is_err() {
        let _ = fs::remove_file(dest);
    }
    r
}

#[allow(clippy::too_many_arguments)]
async fn download_inner(app: &AppHandle, url: &str, dest: &Path, sha256: &str, bytes: u64, cancel: &AtomicBool, event: &str, tag: serde_json::Value) -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder().user_agent("NelCode").build().map_err(|e| e.to_string())?;
    let mut resp = client.get(url).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("téléchargement impossible : {e}"))?;
    let total = resp.content_length().unwrap_or(bytes);
    let mut file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let (mut received, mut last) = (0u64, 0u64);
    let progress = |received: u64, extra: serde_json::Value| {
        let mut p = json!({ "received": received, "total": total, "tag": tag });
        p.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
        let _ = app.emit(event, p);
    };
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("téléchargement interrompu : {e}"))? {
        if cancel.load(Ordering::SeqCst) {
            return Err("annulé".into());
        }
        received += chunk.len() as u64;
        if received > bytes + 1_000_000 {
            return Err("le fichier téléchargé est plus gros que prévu".into());
        }
        hash.update(&chunk);
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| format!("écriture impossible : {e}"))?;
        if received - last > 1_000_000 || received == total {
            last = received;
            progress(received, json!({}));
        }
    }
    drop(file);
    let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if digest != sha256 {
        return Err(format!("empreinte SHA-256 incorrecte : le fichier est refusé ({digest})"));
    }
    progress(received, json!({ "extracting": true }));
    Ok(())
}

/// Les modèles du catalogue, avec s'ils sont installés.
pub fn list() -> serde_json::Value {
    CATALOG
        .iter()
        .map(|e| {
            let mut v = serde_json::to_value(e).unwrap();
            v["installed"] = store::models_dir().join(e.name).join(store::GGUF_FILE).is_file().into();
            v
        })
        .collect()
}

/// Télécharge et installe le modèle `name` du catalogue (« catalog-progress »).
pub async fn install(app: &AppHandle, name: &str, cancel: &AtomicBool) -> Result<store::ImportReport> {
    let e = CATALOG.iter().find(|e| e.name == name).ok_or_else(|| format!("« {name} » n'est pas dans le catalogue"))?;
    fs::create_dir_all(store::root()).map_err(|e| e.to_string())?;
    if let Some(free) = free_bytes(&store::root())
        && free < 2 * e.bytes
    {
        return Err(format!("espace disque insuffisant : {} Mo libres, {} Mo nécessaires", free / 1_000_000, 2 * e.bytes / 1_000_000));
    }
    let tmp = store::temp_folder();
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let file = tmp.join(e.url.rsplit('/').next().unwrap());
    let result = async {
        download(app, &url_of(e), &file, e.sha256, e.bytes, cancel, "catalog-progress", name.into()).await?;
        let extra = json!({ "source": e.page, "license": e.license, "licenseUrl": e.license_url, "sha256": e.sha256 });
        let name = name.to_string();
        tauri::async_runtime::spawn_blocking(move || store::import_gguf(&file, &name, true, extra)).await.map_err(|e| e.to_string())?
    }
    .await;
    let _ = fs::remove_dir_all(&tmp);
    match &result {
        Ok(_) => crate::log::info(&format!("modèle « {name} » installé depuis le catalogue")),
        Err(err) => crate::log::error(&format!("catalogue, « {name} » : {err}")),
    }
    result
}
