// Avec la feature cuda, les DLL CUDA sont chargées en différé (/DELAYLOAD) : Nel Code démarre sans elles, et
// nel_engine::gpu::cuda_device les charge par chemin complet avant le premier appel. Liste : gpu::DELAY_LOADED
// (vérifier avec dumpbin /dependents qu'aucune DLL CUDA ne reste dans les dépendances normales).
const DELAY_LOADED: [&str; 4] = ["nvcuda.dll", "cudart64_12.dll", "cublas64_12.dll", "curand64_10.dll"];

fn main() {
    if std::env::var_os("CARGO_FEATURE_CUDA").is_some() {
        for dll in DELAY_LOADED {
            println!("cargo:rustc-link-arg-bins=/DELAYLOAD:{dll}");
        }
        println!("cargo:rustc-link-arg-bins=delayimp.lib");
    }
    tauri_build::build()
}
