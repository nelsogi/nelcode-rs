//! GPU NVIDIA (feature `cuda`). Candle lie les DLL CUDA (cudarc en `dynamic-linking`) ; l'exécutable de Nel Code
//! les charge en différé (/DELAYLOAD, nel-desktop/build.rs) : il démarre sans elles. Avant le premier appel CUDA,
//! `cuda_device` charge chaque DLL par son chemin complet (le pilote depuis System32, les autres depuis le pack) ;
//! le chargement différé retrouve ensuite ces modules déjà en mémoire. S'il en manque une, on n'appelle jamais CUDA
//! (un chargement différé raté arrêterait le programme) : le CPU est utilisé.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{Device, Result, err};

/// Les DLL du pack GPU (CUDA 12), dans l'ordre de chargement (une DLL après celles dont elle dépend) : le
/// runtime CUDA, cuBLASLt (dont cuBLAS dépend), cuBLAS, cuRAND. Ce sont celles que l'exécutable importe
/// (dumpbin /dependents), plus cuBLASLt, hors nvcuda.dll qui vient du pilote.
pub const PACK_DLLS: [&str; 4] = ["cudart64_12.dll", "cublasLt64_12.dll", "cublas64_12.dll", "curand64_10.dll"];

/// Toutes les DLL CUDA importées par l'exécutable : celles à charger en différé (même liste dans nel-desktop/build.rs).
pub const DELAY_LOADED: [&str; 4] = ["nvcuda.dll", "cudart64_12.dll", "cublas64_12.dll", "curand64_10.dll"];

/// Les noyaux de Candle sont compilés en PTX par le CUDA Toolkit 12.9 : il faut un pilote qui connaît CUDA 12.9
/// (Windows : 576.02 ou plus récent).
pub const MIN_DRIVER_CUDA: (u32, u32) = (12, 9);
pub const MIN_DRIVER_TEXT: &str = "576.02";

/// Ce que le pilote NVIDIA dit, sans rien charger de CUDA : carte, version du pilote, version de CUDA qu'il gère.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub card: Option<String>,
    pub driver: Option<String>,
    /// (12, 9) pour CUDA 12.9.
    pub driver_cuda: Option<(u32, u32)>,
}

impl Probe {
    pub fn driver_ok(&self) -> bool {
        self.driver_cuda.is_some_and(|v| v >= MIN_DRIVER_CUDA)
    }
}

pub const fn compiled() -> bool {
    cfg!(feature = "cuda")
}

#[cfg_attr(not(feature = "cuda"), allow(dead_code))]
fn system32() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32")
}

#[cfg(feature = "cuda")]
mod imp {
    use std::ffi::{c_char, c_int, c_uint, c_void};
    use std::path::Path;

    use libloading::os::windows::Library;

    use super::*;

    /// LOAD_WITH_ALTERED_SEARCH_PATH : les dépendances d'une DLL du pack sont cherchées d'abord dans le pack.
    const ALTERED: u32 = 0x8;

    pub fn load(path: &Path) -> std::result::Result<Library, String> {
        if !path.is_file() {
            return Err(format!("{} introuvable", path.display()));
        }
        unsafe { Library::load_with_flags(path, ALTERED) }.map_err(|e| format!("{} : {e}", path.display()))
    }

    fn text(buf: &[u8]) -> String {
        String::from_utf8_lossy(&buf[..buf.iter().position(|&b| b == 0).unwrap_or(buf.len())]).trim().to_string()
    }

    pub fn probe() -> Probe {
        let mut p = Probe::default();
        if let Ok(nvcuda) = load(&system32().join("nvcuda.dll")) {
            let mut v: c_int = 0;
            if let Ok(f) = unsafe { nvcuda.get::<unsafe extern "C" fn(*mut c_int) -> c_int>(b"cuDriverGetVersion\0") }
                && unsafe { f(&mut v) } == 0
            {
                p.driver_cuda = Some((v as u32 / 1000, v as u32 % 1000 / 10));
            }
        }
        // NVML (livré avec le pilote) : le nom de la carte et la version du pilote (« 621.14 »).
        if let Ok(nvml) = load(&system32().join("nvml.dll")) {
            unsafe {
                type Init = unsafe extern "C" fn() -> c_int;
                type Driver = unsafe extern "C" fn(*mut c_char, c_uint) -> c_int;
                type Handle = unsafe extern "C" fn(c_uint, *mut *mut c_void) -> c_int;
                type Name = unsafe extern "C" fn(*mut c_void, *mut c_char, c_uint) -> c_int;
                if let (Ok(init), Ok(driver), Ok(handle), Ok(name), Ok(shutdown)) = (
                    nvml.get::<Init>(b"nvmlInit_v2\0"),
                    nvml.get::<Driver>(b"nvmlSystemGetDriverVersion\0"),
                    nvml.get::<Handle>(b"nvmlDeviceGetHandleByIndex_v2\0"),
                    nvml.get::<Name>(b"nvmlDeviceGetName\0"),
                    nvml.get::<Init>(b"nvmlShutdown\0"),
                ) && init() == 0
                {
                    let mut buf = [0u8; 96];
                    if driver(buf.as_mut_ptr().cast(), buf.len() as c_uint) == 0 {
                        p.driver = Some(text(&buf));
                    }
                    let mut h = std::ptr::null_mut();
                    let mut buf = [0u8; 96];
                    if handle(0, &mut h) == 0 && name(h, buf.as_mut_ptr().cast(), buf.len() as c_uint) == 0 {
                        p.card = Some(text(&buf));
                    }
                    shutdown();
                }
            }
        }
        p
    }
}

/// La carte et le pilote. Sans la feature `cuda` : rien (l'application ne peut pas s'en servir).
pub fn probe() -> Probe {
    #[cfg(feature = "cuda")]
    return imp::probe();
    #[cfg(not(feature = "cuda"))]
    Probe::default()
}

/// Le GPU 0. `pack` : le dossier des DLL CUDA (Nel Code) ; None : la recherche habituelle de Windows (tests,
/// nel-chat, avec le CUDA Toolkit dans le PATH). Les DLL chargées le restent jusqu'à la fin du programme.
pub fn cuda_device(pack: Option<&Path>) -> Result<Device> {
    #[cfg(not(feature = "cuda"))]
    {
        let _ = pack;
        Err(err("Nel Code est compilé sans CUDA"))
    }
    #[cfg(feature = "cuda")]
    {
        let p = probe();
        let Some((major, minor)) = p.driver_cuda else {
            return Err(err("aucune carte NVIDIA, ou pilote NVIDIA absent"));
        };
        if !p.driver_ok() {
            let (a, b) = MIN_DRIVER_CUDA;
            return Err(err(format!("pilote trop ancien : CUDA {major}.{minor}, il faut CUDA {a}.{b} (pilote {MIN_DRIVER_TEXT} ou plus récent)")));
        }
        let mut libs = vec![imp::load(&system32().join("nvcuda.dll")).map_err(err)?];
        if let Some(dir) = pack {
            for dll in PACK_DLLS {
                libs.push(imp::load(&dir.join(dll)).map_err(err)?);
            }
        }
        libs.into_iter().for_each(std::mem::forget);
        match std::panic::catch_unwind(|| Device::new_cuda(0)) {
            Ok(r) => Ok(r?),
            Err(_) => Err(err("CUDA s'est arrêté pendant l'initialisation")),
        }
    }
}
