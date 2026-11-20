//! Mode Agent : les commandes (outil `run_command`). Un programme et ses arguments, lancé **sans shell** (jamais
//! cmd /c, PowerShell, bash ; pas de `|`, `>`, `&&`), dans le dossier de travail, avec un délai maximal. Le processus
//! et tous ses enfants sont dans un Job Object (Windows) ou un groupe de processus (Linux, macOS) : Stop, le délai ou
//! la fin de la commande les tuent tous. Les variables d'environnement dont le nom contient KEY, TOKEN ou SECRET ne
//! sont pas transmises.

use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

use crate::process;

/// La sortie gardée : le début et la fin (au-delà, le milieu est coupé).
const KEEP_HEAD: usize = 16_000;
const KEEP_TAIL: usize = 48_000;

/// Les shells et lanceurs qui interpréteraient une ligne de commande : refusés.
/// (Windows, puis Linux et macOS : sh, open, xdg-open, osascript…)
const SHELLS: &[&str] = &[
    "cmd", "powershell", "pwsh", "powershell_ise", "bash", "sh", "zsh", "wsl", "conhost", "wscript", "cscript", "mshta", "start", "explorer",
    "dash", "ksh", "csh", "tcsh", "fish", "osascript", "open", "xdg-open",
];
/// Les opérateurs d'un shell : sans shell, ils ne feraient rien, on les refuse pour que ce soit clair.
const OPERATORS: [&str; 10] = ["|", "||", "&", "&&", ";", ">", ">>", "<", "2>", "2>&1"];

/// Le nom d'un programme, sans dossier ni « .exe », en minuscules (« C:\x\Dotnet.EXE » → « dotnet »).
fn base(program: &str) -> String {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program).to_lowercase();
    name.strip_suffix(".exe").map(str::to_string).unwrap_or(name)
}

/// Refuse ce qui passerait par un shell : un shell, un script .bat/.cmd/.ps1 (Windows les lance par cmd.exe) ou .sh, un
/// programme avec ses arguments dans le même texte, un opérateur de shell.
pub fn validate(program: &str, args: &[String]) -> Result<(), String> {
    let p = program.trim();
    if p.is_empty() {
        return Err("program est vide".into());
    }
    if p.contains(char::is_whitespace) && !p.contains(['/', '\\']) {
        return Err(format!("« {p} » : program est un seul nom de programme ; les arguments vont dans args (pas de shell)"));
    }
    if SHELLS.contains(&base(p).as_str()) {
        return Err(format!("« {p} » est un shell : refusé. run_command lance un programme directement, sans shell (pas de cmd /c, PowerShell, bash…)"));
    }
    let lower = p.to_lowercase();
    if [".bat", ".cmd", ".ps1", ".vbs", ".js", ".wsf", ".psm1", ".sh", ".bash", ".zsh", ".command"].iter().any(|x| lower.ends_with(x)) {
        return Err(format!("« {p} » est un script qui passerait par un shell : refusé"));
    }
    if p.contains(['|', '&', '>', '<', ';']) {
        return Err(format!("« {p} » : caractère de shell refusé (pas de |, >, &&…)"));
    }
    if let Some(op) = args.iter().find(|a| OPERATORS.contains(&a.trim())) {
        return Err(format!("« {op} » : pas d'opérateur de shell (|, >, &&…) ; une seule commande, sans redirection"));
    }
    Ok(())
}

/// La commande comme on l'écrirait : « dotnet build -c Release ».
pub fn display(program: &str, args: &[String]) -> String {
    std::iter::once(program.to_string()).chain(args.iter().map(|a| if a.is_empty() || a.contains(char::is_whitespace) { format!("\"{a}\"") } else { a.clone() })).collect::<Vec<_>>().join(" ")
}

/// Autorisée sans confirmation : une entrée de la liste dont les mots sont le début de la commande (« dotnet build »
/// autorise « dotnet build src/App.csproj », pas « dotnet test »). Le programme se compare sans « .exe » ni casse.
/// Seulement un programme donné par son nom (cherché dans le PATH) : « outils/git.exe status », un programme du
/// projet, n'est jamais « git status ».
pub fn allowed(program: &str, args: &[String], list: &[String]) -> bool {
    if program.contains(['/', '\\']) {
        return false;
    }
    let words: Vec<String> = std::iter::once(base(program)).chain(args.iter().cloned()).collect();
    list.iter().any(|entry| {
        let want: Vec<&str> = entry.split_whitespace().collect();
        !want.is_empty() && want.len() <= words.len() && base(want[0]) == words[0] && want[1..].iter().zip(&words[1..]).all(|(a, b)| a == b)
    })
}

/// Une variable qui ne doit pas être transmise (son nom contient KEY, TOKEN ou SECRET).
pub fn hidden_var(name: &str) -> bool {
    let n = name.to_uppercase();
    ["KEY", "TOKEN", "SECRET"].iter().any(|w| n.contains(w))
}

pub struct Outcome {
    pub code: Option<i32>,
    pub output: String,
    pub timed_out: bool,
    pub stopped: bool,
}

/// La sortie gardée : début et fin, le milieu compté.
#[derive(Default)]
pub struct Capture {
    head: String,
    tail: String,
    cut: usize,
}

impl Capture {
    pub fn push(&mut self, text: &str) {
        if self.head.len() < KEEP_HEAD && self.cut == 0 && self.tail.is_empty() {
            let room = KEEP_HEAD - self.head.len();
            let mut k = room.min(text.len());
            while !text.is_char_boundary(k) {
                k -= 1;
            }
            self.head.push_str(&text[..k]);
            if k == text.len() {
                return;
            }
            self.tail.push_str(&text[k..]);
        } else {
            self.tail.push_str(text);
        }
        if self.tail.len() > KEEP_TAIL {
            let mut drop = self.tail.len() - KEEP_TAIL;
            while !self.tail.is_char_boundary(drop) {
                drop += 1;
            }
            self.cut += drop;
            self.tail.drain(..drop);
        }
    }

    pub fn text(&self) -> String {
        if self.cut == 0 {
            format!("{}{}", self.head, self.tail)
        } else {
            format!("{}\n… ({} octets coupés) …\n{}", self.head, self.cut, self.tail)
        }
    }
}

/// Lance `program args` dans `dir` (sans shell, sans fenêtre, sans entrée), arrête tout au bout de `timeout` ou sur
/// `cancel` (Stop). `on_output` reçoit la sortie (stdout et stderr) au fil de l'eau.
pub async fn execute(program: &str, args: &[String], dir: &Path, timeout: Duration, cancel: &Notify, mut on_output: impl FnMut(&str)) -> Result<Outcome, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let env: Vec<(OsString, OsString)> = std::env::vars_os().filter(|(k, _)| !hidden_var(&k.to_string_lossy())).collect();
    cmd.env_clear().envs(env);
    let (mut child, job) = process::spawn(&mut cmd).map_err(|e| format!("« {program} » ne se lance pas : {e} (programme introuvable dans le PATH ?)"))?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    for mut pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>), child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)].into_iter().flatten() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    let deadline = Instant::now() + timeout;
    let mut capture = Capture::default();
    let mut pending: Vec<u8> = Vec::new(); // un caractère UTF-8 coupé entre deux lectures
    let (mut timed_out, mut stopped, mut open) = (false, false, true);
    loop {
        if !open && let Ok(Some(_)) = child.try_wait() {
            break;
        }
        tokio::select! {
            chunk = rx.recv(), if open => match chunk {
                Some(bytes) => {
                    pending.extend(bytes);
                    let valid = match std::str::from_utf8(&pending) { Ok(_) => pending.len(), Err(e) if e.error_len().is_none() => e.valid_up_to(), Err(_) => pending.len() };
                    let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    capture.push(&text);
                    on_output(&text);
                }
                None => open = false,
            },
            _ = tokio::time::sleep(Duration::from_millis(30)), if !open => {}
            _ = tokio::time::sleep_until(deadline.into()) => { timed_out = true; job.kill(); break; }
            _ = cancel.notified() => { stopped = true; job.kill(); break; }
        }
    }
    let code = if timed_out || stopped {
        let _ = child.wait();
        None
    } else {
        child.wait().ok().and_then(|s| s.code())
    };
    drop(job); // ce qui resterait (un enfant détaché) est tué
    Ok(Outcome { code, output: capture.text(), timed_out, stopped })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn sans_shell() {
        for (p, args) in [("cmd", a(&["/c", "dir"])), ("CMD.EXE", a(&[])), ("powershell", a(&["-c", "ls"])), ("pwsh.exe", a(&[])), ("bash", a(&[])), ("C:\\Windows\\System32\\cmd.exe", a(&[])), ("wsl", a(&[]))] {
            assert!(validate(p, &args).unwrap_err().contains("shell"), "{p}");
        }
        // Linux et macOS.
        for p in ["/bin/sh", "/usr/bin/zsh", "fish", "open", "xdg-open", "osascript"] {
            assert!(validate(p, &a(&["-c", "x"])).unwrap_err().contains("shell"), "{p}");
        }
        assert!(validate("./build.sh", &[]).unwrap_err().contains("script"));
        assert!(validate("/usr/bin/git", &a(&["status"])).is_ok());
        assert!(validate("build.bat", &[]).unwrap_err().contains("script"));
        assert!(validate("tools\\x.cmd", &[]).is_err());
        assert!(validate("dotnet build", &[]).unwrap_err().contains("un seul nom"));
        for op in ["|", ">", "&&", "2>&1", ";"] {
            assert!(validate("dotnet", &a(&["build", op, "x"])).is_err(), "{op}");
        }
        assert!(validate("dotnet&calc", &[]).is_err());
        assert!(validate("", &[]).is_err());
        assert!(validate("dotnet", &a(&["test", "--filter", "Name~a|b"])).is_ok(), "un | dans un argument n'est pas un opérateur");
        assert!(validate("git", &a(&["log", "-1"])).is_ok());
        assert!(validate("C:\\Program Files\\dotnet\\dotnet.exe", &a(&["--version"])).is_ok());
    }

    #[test]
    fn liste_autorisee() {
        let list = a(&["dotnet build", "dotnet test", "  "]);
        assert!(allowed("dotnet", &a(&["build"]), &list));
        assert!(allowed("DOTNET.exe", &a(&["build", "src/App.csproj"]), &list));
        // Un programme donné par un chemin (un dotnet.exe du projet, par exemple) : toujours une confirmation.
        for p in ["outils/dotnet.exe", "outils\\dotnet", "./dotnet", "C:\\Program Files\\dotnet\\dotnet.exe"] {
            assert!(!allowed(p, &a(&["test"]), &list), "{p}");
        }
        assert!(!allowed("dotnet", &a(&["run"]), &list));
        assert!(!allowed("dotnet", &[], &list));
        assert!(!allowed("dotnetx", &a(&["build"]), &list));
        assert!(!allowed("dotnet", &a(&["build"]), &[]), "liste vide : toujours une confirmation");
        assert_eq!(display("dotnet", &a(&["test", "--filter", "a b"])), "dotnet test --filter \"a b\"");
    }

    #[test]
    fn variables_cachees() {
        for v in ["OPENAI_API_KEY", "GH_TOKEN", "client_secret", "AWS_SECRET_ACCESS_KEY", "KeyVault"] {
            assert!(hidden_var(v), "{v}");
        }
        for v in ["PATH", "USERPROFILE", "DOTNET_ROOT", "TEMP"] {
            assert!(!hidden_var(v), "{v}");
        }
    }

    #[test]
    fn sortie_limitee() {
        let mut c = Capture::default();
        c.push(&"a".repeat(10_000));
        c.push(&"é".repeat(40_000)); // 80 000 octets
        c.push("FIN");
        let t = c.text();
        assert!(t.starts_with(&"a".repeat(10_000)));
        assert!(t.ends_with("éFIN"));
        assert!(c.cut > 0 && t.contains("octets coupés"));
        assert!(t.len() < KEEP_HEAD + KEEP_TAIL + 100);
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn execution_sortie_code_et_environnement() {
        let dir = std::env::temp_dir();
        // SAFETY : seul ce test lit ces variables.
        unsafe {
            std::env::set_var("NELCODE_TEST_API_KEY", "cache");
            std::env::set_var("NELCODE_TEST_VISIBLE", "visible");
        }
        let out = rt().block_on(execute("where.exe", &a(&["/?"]), &dir, Duration::from_secs(20), &Notify::new(), |_| {})).unwrap();
        assert_eq!(out.code, Some(0));
        assert!(!out.output.is_empty());
        // L'environnement : les clés ne passent pas (vu depuis un processus enfant).
        let env = rt().block_on(execute("cmd.exe", &a(&["/d", "/c", "set NELCODE_TEST"]), &dir, Duration::from_secs(20), &Notify::new(), |_| {})).unwrap();
        assert!(env.output.contains("NELCODE_TEST_VISIBLE=visible"), "{}", env.output);
        assert!(!env.output.contains("cache"), "{}", env.output);
        let bad = rt().block_on(execute("cmd.exe", &a(&["/d", "/c", "exit 3"]), &dir, Duration::from_secs(20), &Notify::new(), |_| {})).unwrap();
        assert_eq!(bad.code, Some(3));
        assert!(rt().block_on(execute("programme-qui-n-existe-pas", &[], &dir, Duration::from_secs(5), &Notify::new(), |_| {})).is_err());
    }

    /// Stop et le délai tuent la commande et ses enfants : l'enfant (lancé par la commande) devait écrire un fichier
    /// au bout de 3 s ; tué avec elle, il ne l'écrit jamais.
    #[cfg(windows)]
    #[test]
    fn stop_et_delai_tuent_les_enfants() {
        let dir = std::env::temp_dir().join(format!("nelcode-cmd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let child = "ping -n 4 127.0.0.1 >nul & echo fini> marque.txt";
        let args = a(&["/d", "/c", &format!("start \"\" /b cmd /d /c \"{child}\" & ping -n 30 127.0.0.1 >nul")]);
        // Délai : 1 s.
        let t = Instant::now();
        let out = rt().block_on(execute("cmd.exe", &args, &dir, Duration::from_secs(1), &Notify::new(), |_| {})).unwrap();
        assert!(out.timed_out && out.code.is_none());
        assert!(t.elapsed() < Duration::from_secs(5));
        // Stop : au bout de 500 ms.
        let cancel = std::sync::Arc::new(Notify::new());
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            c2.notify_one();
        });
        let out = rt().block_on(execute("cmd.exe", &args, &dir, Duration::from_secs(60), &cancel, |_| {})).unwrap();
        assert!(out.stopped);
        std::thread::sleep(Duration::from_secs(5));
        assert!(!dir.join("marque.txt").exists(), "un enfant a survécu");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn execution_sous_linux_et_macos() {
        let dir = std::env::temp_dir();
        // SAFETY : seul ce test lit ces variables.
        unsafe {
            std::env::set_var("NELCODE_TEST_UNIX_TOKEN", "cache");
            std::env::set_var("NELCODE_TEST_UNIX_VISIBLE", "visible");
        }
        let env = rt().block_on(execute("env", &[], &dir, Duration::from_secs(20), &Notify::new(), |_| {})).unwrap();
        assert_eq!(env.code, Some(0));
        assert!(env.output.contains("NELCODE_TEST_UNIX_VISIBLE=visible"), "{}", env.output);
        assert!(!env.output.contains("cache"), "{}", env.output);
        let bad = rt().block_on(execute("/bin/sh", &a(&["-c", "exit 3"]), &dir, Duration::from_secs(20), &Notify::new(), |_| {})).unwrap();
        assert_eq!(bad.code, Some(3));
        assert!(rt().block_on(execute("programme-qui-n-existe-pas", &[], &dir, Duration::from_secs(5), &Notify::new(), |_| {})).is_err());
    }

    /// Le groupe de processus : Stop et le délai tuent aussi l'enfant lancé en arrière-plan par la commande.
    #[cfg(unix)]
    #[test]
    fn stop_et_delai_tuent_les_enfants_unix() {
        let dir = std::env::temp_dir().join(format!("nelcode-cmd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let args = a(&["-c", "(sleep 3; echo fini > marque.txt) & sleep 30"]);
        let t = Instant::now();
        let out = rt().block_on(execute("/bin/sh", &args, &dir, Duration::from_secs(1), &Notify::new(), |_| {})).unwrap();
        assert!(out.timed_out && out.code.is_none());
        assert!(t.elapsed() < Duration::from_secs(5));
        let cancel = std::sync::Arc::new(Notify::new());
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            c2.notify_one();
        });
        let out = rt().block_on(execute("/bin/sh", &args, &dir, Duration::from_secs(60), &cancel, |_| {})).unwrap();
        assert!(out.stopped);
        std::thread::sleep(Duration::from_secs(5));
        assert!(!dir.join("marque.txt").exists(), "un enfant a survécu");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
