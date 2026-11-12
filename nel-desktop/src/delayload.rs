//! Chargement différé des DLL CUDA (feature cuda, voir build.rs) : les hooks de delayimp.lib.
//!
//! - Toute DLL CUDA chargée en différé l'est par son chemin complet : nvcuda.dll depuis System32, les autres
//!   depuis le pack (%APPDATA%\NelCode\gpu). Jamais par la recherche de Windows (PATH, dossier courant…).
//! - candle-kernels lie des noyaux compilés par nvcc (MoE, GGUF) dont les constructeurs C++ appellent cudart
//!   (`__cudaRegisterFatBinary`…) avant main, même sans GPU. Sans pack, ces appels vont à une fonction vide :
//!   Nel Code n'utilise jamais ces noyaux, et sans le pack il n'appelle pas CUDA (nel_engine::gpu::cuda_device
//!   vérifie chaque DLL avant). Toute autre DLL CUDA introuvable reste une erreur.

use std::ffi::{CStr, c_char, c_void};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Foundation::HMODULE;
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, LOAD_WITH_ALTERED_SEARCH_PATH, LoadLibraryExW};

type Farproc = *const c_void;

#[repr(C)]
pub struct DelayLoadInfo {
    cb: u32,
    pidd: *const c_void,
    ppfn: *mut Farproc,
    sz_dll: *const c_char,
    import_by_name: i32,
    proc_name: *const c_char,
    hmod_cur: HMODULE,
    pfn_cur: Farproc,
    last_error: u32,
}

type Hook = Option<unsafe extern "system" fn(u32, *const DelayLoadInfo) -> Farproc>;

const DLI_NOTE_PRE_LOAD_LIBRARY: u32 = 1;
const DLI_FAIL_GET_PROC: u32 = 4;

#[unsafe(no_mangle)]
pub static __pfnDliNotifyHook2: Hook = Some(notify);
#[unsafe(no_mangle)]
pub static __pfnDliFailureHook2: Hook = Some(failure);

const CUDART: &str = "cudart64_12.dll";

fn dll_name(info: &DelayLoadInfo) -> String {
    unsafe { CStr::from_ptr(info.sz_dll) }.to_string_lossy().to_ascii_lowercase()
}

fn load(path: &Path) -> HMODULE {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), LOAD_WITH_ALTERED_SEARCH_PATH) }
}

/// La fonction vide qui remplace celles de cudart sans pack : rend 0 (NULL, cudaSuccess).
extern "system" fn absent() -> usize {
    0
}

unsafe extern "system" fn notify(note: u32, info: *const DelayLoadInfo) -> Farproc {
    if note != DLI_NOTE_PRE_LOAD_LIBRARY {
        return std::ptr::null();
    }
    let info = unsafe { &*info };
    let name = dll_name(info);
    let path = if name == "nvcuda.dll" {
        std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32").join(&name)
    } else {
        crate::gpu::dir().join(&name)
    };
    let module = if path.is_file() { load(&path) } else { std::ptr::null_mut() };
    if !module.is_null() {
        return module as Farproc;
    }
    if name == CUDART.to_ascii_lowercase() {
        // Pas de pack : un module sans ces fonctions (l'exécutable), et chaque fonction devient `absent`.
        return unsafe { GetModuleHandleW(std::ptr::null()) } as Farproc;
    }
    std::ptr::null() // la recherche habituelle, puis l'erreur du chargement différé
}

unsafe extern "system" fn failure(note: u32, info: *const DelayLoadInfo) -> Farproc {
    let info = unsafe { &*info };
    if note == DLI_FAIL_GET_PROC && dll_name(info) == CUDART.to_ascii_lowercase() {
        return absent as *const () as Farproc;
    }
    std::ptr::null()
}
