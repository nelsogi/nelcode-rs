//! Ce qui dépend du système : dossiers (données, personnel), programmes cherchés dans le PATH, ouvrir un dossier ou
//! une adresse, espace disque libre, heure locale, version du système. Windows, Linux et macOS.
//!
//! Les règles de chaque système sont des fonctions qui prennent le système en paramètre (`Os`) : leurs tests tournent
//! partout, même sous Windows pour les règles de Linux et de macOS.

use crate::t;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Os {
    Windows,
    MacOs,
    Linux,
}

/// Le système pour lequel Nel Code est compilé (les autres Unix suivent les règles de Linux).
pub const CURRENT: Os = if cfg!(windows) {
    Os::Windows
} else if cfg!(target_os = "macos") {
    Os::MacOs
} else {
    Os::Linux
};

impl Os {
    /// « windows », « macos », « linux » (pour l'interface).
    pub fn id(self) -> &'static str {
        match self {
            Os::Windows => "windows",
            Os::MacOs => "macos",
            Os::Linux => "linux",
        }
    }

    /// Où sont rangées les clés (textes de l'interface et erreurs).
    pub fn keystore(self) -> &'static str {
        match self {
            Os::Windows => "rs.os.keystore_windows",
            Os::MacOs => "rs.os.keystore_macos",
            Os::Linux => "rs.os.keystore_linux",
        }
    }

    /// Le gestionnaire de fichiers (« Ouvrir dans l'Explorateur »).
    pub fn file_manager(self) -> &'static str {
        match self {
            Os::Windows => "rs.os.files_windows",
            Os::MacOs => "rs.os.files_macos",
            Os::Linux => "rs.os.files_linux",
        }
    }
}

type Var<'a> = &'a dyn Fn(&str) -> Option<OsString>;

fn env(name: &str) -> Option<OsString> {
    std::env::var_os(name).filter(|v| !v.is_empty())
}

fn home_for(os: Os, var: Var) -> Option<PathBuf> {
    var(if os == Os::Windows { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Le dossier personnel : %USERPROFILE% (Windows), $HOME (Linux, macOS).
pub fn home() -> Option<PathBuf> {
    home_for(CURRENT, &env)
}

/// Le dossier des données : %APPDATA%\NelCode sous Windows (partagé avec la version C#, inchangé),
/// ~/Library/Application Support/NelCode sous macOS, $XDG_DATA_HOME/nelcode (sinon ~/.local/share/nelcode) sous Linux.
fn data_dir_for(os: Os, var: Var) -> PathBuf {
    let home = || home_for(os, var).unwrap_or_default();
    match os {
        Os::Windows => PathBuf::from(var("APPDATA").unwrap_or_default()).join("NelCode"),
        Os::MacOs => home().join("Library").join("Application Support").join("NelCode"),
        // XDG : un chemin relatif dans la variable est ignoré.
        Os::Linux => var("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home().join(".local").join("share")).join("nelcode"),
    }
}

pub fn data_dir() -> PathBuf {
    data_dir_for(CURRENT, &env)
}

/// La configuration de Claude Desktop (import des serveurs MCP).
fn claude_desktop_config_for(os: Os, var: Var) -> PathBuf {
    let dir = match os {
        Os::Windows => PathBuf::from(var("APPDATA").unwrap_or_default()),
        Os::MacOs => home_for(os, var).unwrap_or_default().join("Library").join("Application Support"),
        Os::Linux => var("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home_for(os, var).unwrap_or_default().join(".config")),
    };
    dir.join("Claude").join("claude_desktop_config.json")
}

pub fn claude_desktop_config() -> PathBuf {
    claude_desktop_config_for(CURRENT, &env)
}

// ---------------------------------------------------------------------------------------------------------
// Programmes

/// Les noms essayés pour un programme : sous Windows, tel quel s'il a une extension, sinon .exe, .cmd, .bat, .com
/// (npx est npx.cmd) ; ailleurs, le nom tel quel.
fn program_names(os: Os, name: &str) -> Vec<String> {
    if os != Os::Windows || Path::new(name).extension().is_some() {
        return vec![name.to_string()];
    }
    [".exe", ".cmd", ".bat", ".com"].iter().map(|e| format!("{name}{e}")).collect()
}

/// Un fichier qu'on peut lancer : sous Linux et macOS, avec un droit d'exécution.
pub fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    p.is_file()
}

fn find_in(os: Os, name: &str, dirs: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    let names = program_names(os, name);
    dirs.into_iter().flat_map(|d| names.iter().map(move |n| d.join(n)).collect::<Vec<_>>()).find(|p| is_executable(p))
}

/// Un programme cherché dans le PATH, selon les règles du système.
pub fn find_program(name: &str) -> Option<PathBuf> {
    find_in(CURRENT, name, std::env::split_paths(&std::env::var_os("PATH")?).collect::<Vec<_>>())
}

/// Les dossiers ajoutés au PATH sous Linux et macOS s'ils manquent : une appli lancée depuis le Finder (ou un menu)
/// n'a que /usr/bin:/bin:/usr/sbin:/sbin, sans Homebrew ni ~/.local/bin (claude, node, npx).
fn extra_path_dirs(os: Os, home: Option<&Path>) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if os == Os::Windows {
        return v;
    }
    if let Some(h) = home {
        v.push(h.join(".local").join("bin"));
    }
    if os == Os::MacOs {
        v.push("/opt/homebrew/bin".into());
    }
    v.push("/usr/local/bin".into());
    v
}

/// Le PATH complété par `extra_path_dirs` (ceux qui existent et n'y sont pas déjà), à la fin : ce qui est déjà dans
/// le PATH garde la priorité.
fn extended_path(os: Os, path: Option<OsString>, home: Option<&Path>, exists: impl Fn(&Path) -> bool) -> Option<OsString> {
    let mut dirs: Vec<PathBuf> = path.as_ref().map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    let before = dirs.len();
    for d in extra_path_dirs(os, home) {
        if !dirs.contains(&d) && exists(&d) {
            dirs.push(d);
        }
    }
    (dirs.len() > before).then(|| std::env::join_paths(dirs).ok()).flatten()
}

/// Au démarrage, avant tout lancement de programme (rien sous Windows).
pub fn extend_path() {
    if let Some(p) = extended_path(CURRENT, std::env::var_os("PATH"), home().as_deref(), Path::is_dir) {
        // SAFETY : appelé au début de main, avant tout autre thread.
        unsafe { std::env::set_var("PATH", p) };
    }
}

/// Les mises à jour automatiques : sous Linux, seulement pour l'AppImage ($APPIMAGE, posée par son lanceur) ; un
/// Nel Code installé par le paquet .deb se met à jour à la main.
fn self_update_for(os: Os, var: Var) -> bool {
    os != Os::Linux || var("APPIMAGE").is_some()
}

pub fn self_update() -> bool {
    self_update_for(CURRENT, &env)
}

/// Ouvre un dossier ou une adresse avec le programme du système (Explorateur, Finder, xdg-open).
pub fn open(target: &str) -> Result<(), String> {
    let program = match CURRENT {
        Os::Windows => "explorer",
        Os::MacOs => "open",
        Os::Linux => "xdg-open",
    };
    Command::new(program).arg(target).spawn().map(|_| ()).map_err(|e| format!("{program} : {e}"))
}

/// L'adresse d'un lien d'une réponse, normalisée : http ou https seulement, avec un hôte, sans identifiants ni
/// caractère de contrôle (4096 caractères au plus).
pub fn web_link(link: &str) -> Result<String, String> {
    let refused = |why: &str| Err(t!("rs.link.refused", why = t!(why)));
    if link.len() > 4096 || link.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return refused("rs.link.too_long");
    }
    let Ok(url) = reqwest::Url::parse(link) else { return refused("rs.link.invalid") };
    if !matches!(url.scheme(), "http" | "https") {
        return refused("rs.link.scheme");
    }
    if url.host_str().is_none_or(str::is_empty) || !url.username().is_empty() || url.password().is_some() {
        return refused("rs.link.host");
    }
    Ok(url.into())
}

/// Ouvre une adresse http(s) (voir `web_link`) dans le navigateur. Windows : ShellExecute, sans ligne de commande.
/// En debug, NELCODE_OPEN_LOG la note dans un fichier à la place (tests).
pub fn open_link(link: &str) -> Result<(), String> {
    let url = web_link(link)?;
    #[cfg(debug_assertions)]
    if let Some(file) = std::env::var_os("NELCODE_OPEN_LOG") {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(file).map_err(|e| e.to_string())?;
        return writeln!(f, "{url}").map_err(|e| e.to_string());
    }
    #[cfg(windows)]
    {
        let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
        let (verb, target) = (wide("open"), wide(&url));
        // SAFETY : deux chaînes UTF-16 terminées par 0, vivantes pendant l'appel.
        let code = unsafe {
            windows_sys::Win32::UI::Shell::ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL)
        } as usize;
        if code > 32 { Ok(()) } else { Err(t!("rs.link.browser", code = code)) }
    }
    #[cfg(not(windows))]
    open(&url)
}

/// Ouvre un fichier (chemin absolu, déjà vérifié) avec le programme par défaut du système : le navigateur pour un
/// .html. Windows : ShellExecute, sans ligne de commande. En debug, NELCODE_OPEN_LOG le note à la place (tests).
pub fn open_file(path: &std::path::Path) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if let Some(file) = std::env::var_os("NELCODE_OPEN_LOG") {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(file).map_err(|e| e.to_string())?;
        return writeln!(f, "file:{}", path.display()).map_err(|e| e.to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let verb: Vec<u16> = "open".encode_utf16().chain([0]).collect();
        // Sans le préfixe \\?\ de canonicalize : ShellExecute ne le comprend pas toujours.
        let shown = path.to_string_lossy();
        let plain = shown.strip_prefix(r"\\?\").unwrap_or(&shown);
        let target: Vec<u16> = std::ffi::OsStr::new(plain).encode_wide().chain([0]).collect();
        // SAFETY : deux chaînes UTF-16 terminées par 0, vivantes pendant l'appel.
        let code = unsafe {
            windows_sys::Win32::UI::Shell::ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL)
        } as usize;
        if code > 32 { Ok(()) } else { Err(t!("rs.link.browser", code = code)) }
    }
    #[cfg(not(windows))]
    open(&path.to_string_lossy())
}

/// Une adresse de l'interface elle-même (tauri://localhost, http(s)://tauri.localhost sous Windows) : la fenêtre ne va
/// jamais ailleurs.
pub fn is_app_url(url: &reqwest::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------------------------
// Disque, heure, version

/// L'espace libre (octets) du disque de `path`.
pub fn free_bytes(path: &Path) -> Option<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        let mut free = 0u64;
        let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
        (ok != 0).then_some(free)
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
        (unsafe { libc::statvfs(c.as_ptr(), &mut s) } == 0).then(|| s.f_bavail as u64 * s.f_frsize as u64)
    }
}

/// L'heure locale : (année, mois, jour, heure, minute, seconde) de l'instant `ts` (secondes Unix).
pub fn local_time(ts: i64) -> (i32, u32, u32, u32, u32, u32) {
    #[cfg(windows)]
    {
        let _ = ts; // GetLocalTime : l'instant présent (local_now l'appelle juste après avoir lu ts)
        let mut t: windows_sys::Win32::Foundation::SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe { windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut t) };
        (t.wYear as i32, t.wMonth as u32, t.wDay as u32, t.wHour as u32, t.wMinute as u32, t.wSecond as u32)
    }
    #[cfg(unix)]
    {
        let t = ts as libc::time_t;
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        unsafe { libc::localtime_r(&t, &mut tm) };
        (tm.tm_year + 1900, tm.tm_mon as u32 + 1, tm.tm_mday as u32, tm.tm_hour as u32, tm.tm_min as u32, tm.tm_sec as u32)
    }
}

/// La version du système (rapport de bug) : « Microsoft Windows [version 10.0.26200.1234] », « macOS 15.1 »,
/// « Ubuntu 24.04.1 LTS ».
pub fn version() -> String {
    match CURRENT {
        Os::Windows => {
            let mut cmd = Command::new("cmd");
            crate::process::hide_window(&mut cmd);
            cmd.args(["/c", "ver"]).output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_else(|e| format!("Windows, unknown version ({e})"))
        }
        Os::MacOs => Command::new("sw_vers").arg("-productVersion").output().map(|o| format!("macOS {}", String::from_utf8_lossy(&o.stdout).trim())).unwrap_or_else(|e| format!("macOS, unknown version ({e})")),
        Os::Linux => std::fs::read_to_string("/etc/os-release").ok().and_then(|t| os_release_name(&t)).unwrap_or_else(|| "Linux".into()),
    }
}

/// PRETTY_NAME de /etc/os-release, guillemets retirés.
fn os_release_name(text: &str) -> Option<String> {
    text.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=")).map(|v| v.trim().trim_matches('"').to_string()).filter(|v| !v.is_empty())
}

/// La taille de la fenêtre au lancement, en pixels logiques : environ 80 % de la zone utile de l'écran (sans la barre
/// des tâches), jamais moins que la taille minimale (720 × 480) ni plus que l'écran. `work` : la zone utile en pixels
/// physiques, `scale` : l'échelle de l'écran (1,5 pour 150 %).
pub fn initial_window_size(work: (u32, u32), scale: f64) -> (f64, f64) {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let (w, h) = (work.0 as f64 / scale, work.1 as f64 / scale);
    if w < 1.0 || h < 1.0 {
        return (1200.0, 800.0);
    }
    ((w * 0.8).round().clamp(720f64.min(w), w), (h * 0.8).round().clamp(480f64.min(h), h))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[allow(unused_imports)]
    use crate::i18n::Fr;
    use std::collections::HashMap;

    #[test]
    fn window_is_80_percent_of_the_screen() {
        assert_eq!(initial_window_size((1920, 1040), 1.0), (1536.0, 832.0));
        assert_eq!(initial_window_size((2560, 1390), 1.25), (1638.0, 890.0));
        assert_eq!(initial_window_size((3840, 2100), 2.0), (1536.0, 840.0));
        // Petit écran : au moins la taille minimale, sans dépasser l'écran.
        assert_eq!(initial_window_size((800, 560), 1.0), (720.0, 480.0));
        assert_eq!(initial_window_size((640, 400), 1.0), (640.0, 400.0));
        assert_eq!(initial_window_size((0, 0), f64::NAN), (1200.0, 800.0));
    }

    #[test]
    fn links_open_only_in_http_and_https() {
        for (link, url) in [
            ("https://exemple.ch/a?b=1,2#c", "https://exemple.ch/a?b=1,2#c"),
            ("HTTP://Exemple.ch", "http://exemple.ch/"),
            ("https://exemple.ch/\"&calc", "https://exemple.ch/%22&calc"),
            ("https://\u{430}pple.com/", "https://xn--pple-43d.com/"),
        ] {
            assert_eq!(web_link(link).as_deref(), Ok(url), "{link}");
        }
        for link in [
            "", "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///C:/Windows/System32/calc.exe", "vbscript:x", "ftp://exemple.ch/",
            "ms-settings:display", "C:\\Windows\\System32\\calc.exe", "calc.exe", "//exemple.ch", "/select,C:\\", "http://", "https://user:mdp@exemple.ch/", "https://banque.ch@pirate.ch/",
            "https://exemple.ch/ a", "java\nscript:alert(1)", "https://exemple.ch/\n", " https://exemple.ch/",
        ] {
            assert!(web_link(link).is_err(), "{link}");
        }
        assert!(web_link(&format!("https://exemple.ch/{}", "a".repeat(5000))).is_err());
    }

    #[test]
    fn the_window_stays_on_the_app() {
        let ok = |u: &str| is_app_url(&reqwest::Url::parse(u).unwrap());
        for u in ["tauri://localhost/index.html", "http://tauri.localhost/", "https://tauri.localhost/index.html", "about:blank"] {
            assert!(ok(u), "{u}");
        }
        for u in ["https://exemple.ch/", "http://tauri.localhost.exemple.ch/", "http://localhost/", "tauri://exemple/", "data:text/html,x", "file:///C:/x.html", "javascript:alert(1)", "about:config"] {
            assert!(!ok(u), "{u}");
        }
    }

    fn vars(list: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> + use<> {
        let m: HashMap<String, String> = list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).map(OsString::from)
    }

    #[test]
    fn dossiers_de_donnees() {
        // Windows : %APPDATA%\NelCode, comme avant (les données existantes restent où elles sont).
        let w = vars(&[("APPDATA", "C:\\Users\\a\\AppData\\Roaming"), ("USERPROFILE", "C:\\Users\\a"), ("HOME", "/ignoré")]);
        assert_eq!(data_dir_for(Os::Windows, &w), PathBuf::from("C:\\Users\\a\\AppData\\Roaming").join("NelCode"));
        assert_eq!(home_for(Os::Windows, &w), Some(PathBuf::from("C:\\Users\\a")));
        assert_eq!(claude_desktop_config_for(Os::Windows, &w), PathBuf::from("C:\\Users\\a\\AppData\\Roaming").join("Claude").join("claude_desktop_config.json"));
        // macOS
        let m = vars(&[("HOME", "/Users/a")]);
        assert_eq!(data_dir_for(Os::MacOs, &m), PathBuf::from("/Users/a").join("Library").join("Application Support").join("NelCode"));
        assert_eq!(claude_desktop_config_for(Os::MacOs, &m), PathBuf::from("/Users/a").join("Library").join("Application Support").join("Claude").join("claude_desktop_config.json"));
        // Linux : XDG_DATA_HOME s'il est absolu, sinon ~/.local/share.
        let l = vars(&[("HOME", "/home/a")]);
        assert_eq!(data_dir_for(Os::Linux, &l), PathBuf::from("/home/a").join(".local").join("share").join("nelcode"));
        assert_eq!(claude_desktop_config_for(Os::Linux, &l), PathBuf::from("/home/a").join(".config").join("Claude").join("claude_desktop_config.json"));
        let abs = if cfg!(windows) { "C:\\xdg" } else { "/xdg" };
        let x = vars(&[("HOME", "/home/a"), ("XDG_DATA_HOME", abs), ("XDG_CONFIG_HOME", abs)]);
        assert_eq!(data_dir_for(Os::Linux, &x), PathBuf::from(abs).join("nelcode"));
        assert_eq!(claude_desktop_config_for(Os::Linux, &x), PathBuf::from(abs).join("Claude").join("claude_desktop_config.json"));
        let rel = vars(&[("HOME", "/home/a"), ("XDG_DATA_HOME", "relatif")]);
        assert_eq!(data_dir_for(Os::Linux, &rel), PathBuf::from("/home/a").join(".local").join("share").join("nelcode"), "XDG relatif ignoré");
    }

    #[test]
    fn noms_des_programmes() {
        assert_eq!(program_names(Os::Windows, "npx"), ["npx.exe", "npx.cmd", "npx.bat", "npx.com"]);
        assert_eq!(program_names(Os::Windows, "node.exe"), ["node.exe"]);
        assert_eq!(program_names(Os::Linux, "npx"), ["npx"]);
        assert_eq!(program_names(Os::MacOs, "claude"), ["claude"]);
    }

    #[test]
    fn programme_dans_le_path() {
        let d = std::env::temp_dir().join(format!("nelcode-os-{}", std::process::id()));
        let (a, b) = (d.join("a"), d.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("outil.txt"), "x").unwrap();
        if cfg!(windows) {
            std::fs::write(b.join("outil.cmd"), "x").unwrap();
            assert_eq!(find_in(Os::Windows, "outil", [a.clone(), b.clone()]), Some(b.join("outil.cmd")));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Sans droit d'exécution : ignoré ; avec : trouvé dans le premier dossier qui l'a.
            std::fs::write(a.join("outil"), "x").unwrap();
            std::fs::write(b.join("outil"), "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(b.join("outil"), std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(find_in(CURRENT, "outil", [a.clone(), b.clone()]), Some(b.join("outil")));
            std::fs::set_permissions(a.join("outil"), std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(find_in(CURRENT, "outil", [a.clone(), b.clone()]), Some(a.join("outil")));
            assert!(!is_executable(&a), "un dossier n'est pas un programme");
        }
        assert_eq!(find_in(CURRENT, "introuvable-xyz", [a, b]), None);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn path_complete_sous_linux_et_macos() {
        let all = |_: &Path| true;
        let home = Path::new("/home/a");
        assert_eq!(extended_path(Os::Windows, Some("C:\\x".into()), Some(home), all), None, "Windows : PATH inchangé");
        let p = extended_path(Os::MacOs, Some(OsString::from("/usr/bin:/bin")), Some(home), all);
        if cfg!(unix) {
            assert_eq!(p, Some(OsString::from("/usr/bin:/bin:/home/a/.local/bin:/opt/homebrew/bin:/usr/local/bin")));
            // Déjà là, ou absent du disque : pas ajouté.
            let p = extended_path(Os::Linux, Some(OsString::from("/usr/local/bin:/usr/bin")), Some(home), |d| d != Path::new("/home/a/.local/bin"));
            assert_eq!(p, None);
        }
        assert_eq!(extra_path_dirs(Os::Linux, Some(home)), [home.join(".local").join("bin"), PathBuf::from("/usr/local/bin")]);
    }

    #[test]
    fn mises_a_jour_automatiques() {
        let none = vars(&[]);
        assert!(self_update_for(Os::Windows, &none) && self_update_for(Os::MacOs, &none));
        assert!(!self_update_for(Os::Linux, &none), "paquet .deb : à la main");
        assert!(self_update_for(Os::Linux, &vars(&[("APPIMAGE", "/home/a/Nel_Code.AppImage")])));
    }

    #[test]
    fn version_du_systeme() {
        assert_eq!(os_release_name("NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nID=ubuntu\n").as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(os_release_name("PRETTY_NAME=Debian\n").as_deref(), Some("Debian"));
        assert_eq!(os_release_name("ID=x\n"), None);
        let v = version();
        match CURRENT {
            Os::Windows => assert!(v.contains("Windows"), "{v}"),
            Os::MacOs => assert!(v.starts_with("macOS"), "{v}"),
            Os::Linux => assert!(!v.is_empty()),
        }
    }

    #[test]
    fn disque_et_heure() {
        assert!(free_bytes(&std::env::temp_dir()).is_some_and(|b| b > 0));
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        let (y, mo, d, h, mi, s) = local_time(ts);
        assert!((2024..3000).contains(&y) && (1..=12).contains(&mo) && (1..=31).contains(&d) && h < 24 && mi < 60 && s < 61);
    }
}
