// Faux « claude » pour les tests de l'interface (e2e/claude.test.mjs), compilé par le test avec rustc, sans
// dépendance. Il rejoue un flux stream-json enregistré : e2e/fake-claude/<premier mot du message>.jsonl (sinon
// texte.jsonl). Lignes spéciales : « #pause <ms> », et « #attendre-ctrl-c » (attend Ctrl+C, puis écrit le résultat
// d'une demande interrompue et finit proprement). {{SESSION}} devient l'id de session (celui de --resume, sinon
// « sess-neuve »). Chaque lancement est noté dans FAKE_CLAUDE_LOG (une ligne JSON) : arguments, message reçu sur
// l'entrée standard, clé API, présence d'une variable secrète, dossier courant, événements.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static CTRL_C: AtomicBool = AtomicBool::new(false);

#[link(name = "kernel32")]
unsafe extern "system" {
    fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
}

unsafe extern "system" fn on_ctrl(kind: u32) -> i32 {
    if kind == 0 {
        CTRL_C.store(true, Ordering::SeqCst); // CTRL_C_EVENT : géré, le processus continue
        1
    } else {
        0
    }
}

fn esc(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn log(event: &str, args: &[String], prompt: &str) {
    let Ok(path) = std::env::var("FAKE_CLAUDE_LOG") else { return };
    let key = std::env::var("ANTHROPIC_API_KEY").map(|k| esc(&k)).unwrap_or_else(|_| "null".into());
    let secret = std::env::var("NELCODE_E2E_SECRET_TOKEN").is_ok();
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let line = format!(
        "{{\"event\":{},\"args\":[{}],\"prompt\":{},\"key\":{},\"secret\":{},\"cwd\":{}}}\n",
        esc(event),
        args.iter().map(|a| esc(a)).collect::<Vec<_>>().join(","),
        esc(prompt),
        key,
        secret,
        esc(&cwd)
    );
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn main() {
    unsafe { SetConsoleCtrlHandler(Some(on_ctrl), 1) };
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut prompt = String::new();
    let _ = std::io::stdin().read_to_string(&mut prompt);
    let session = args.windows(2).find(|w| w[0] == "--resume").map(|w| w[1].clone()).unwrap_or_else(|| "sess-neuve".into());
    log("start", &args, &prompt);
    let dir = std::env::var("FAKE_CLAUDE_DIR").expect("FAKE_CLAUDE_DIR");
    let scenario = prompt.split_whitespace().next().unwrap_or("texte").to_lowercase();
    let script = std::fs::read_to_string(format!("{dir}/{scenario}.jsonl")).or_else(|_| std::fs::read_to_string(format!("{dir}/texte.jsonl"))).expect("scénario");
    let mut out = std::io::stdout();
    for line in script.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(ms) = line.strip_prefix("#pause ") {
            std::thread::sleep(Duration::from_millis(ms.parse().unwrap_or(100)));
            continue;
        }
        if line == "#attendre-ctrl-c" {
            let start = Instant::now();
            while !CTRL_C.load(Ordering::SeqCst) {
                if start.elapsed() > Duration::from_secs(60) {
                    log("jamais-de-ctrl-c", &args, &prompt);
                    std::process::exit(3);
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            log("ctrl-c", &args, &prompt);
            let result = format!("{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"result\":\"\",\"session_id\":\"{session}\",\"total_cost_usd\":0.002,\"duration_ms\":900,\"num_turns\":1}}");
            let _ = writeln!(out, "{result}");
            let _ = out.flush();
            log("fin-propre", &args, &prompt);
            return;
        }
        let _ = writeln!(out, "{}", line.replace("{{SESSION}}", &session));
        let _ = out.flush();
        std::thread::sleep(Duration::from_millis(20));
    }
    log("fin", &args, &prompt);
}
