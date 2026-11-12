//! Le journal : %APPDATA%\NelCode\logs\nelcode-AAAA-MM-JJ.log, un fichier par jour (UTC), 7 jours gardés.
//! Démarrage, modèles, erreurs, mises à jour, GPU. Jamais le texte des conversations.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const KEEP_DAYS: usize = 7;

fn dir() -> PathBuf {
    crate::store::root().join("logs")
}

/// (année, mois, jour) d'un nombre de jours depuis 1970-01-01 (algorithme de Howard Hinnant).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// (« 2026-11-12 », « 2026-11-12 13:05:09 »), en UTC.
fn now() -> (String, String) {
    let s = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let (y, m, d) = civil(s.div_euclid(86_400));
    let t = s.rem_euclid(86_400);
    let day = format!("{y:04}-{m:02}-{d:02}");
    (day.clone(), format!("{day} {:02}:{:02}:{:02}", t / 3600, t / 60 % 60, t % 60))
}

fn write(level: &str, message: &str) {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (day, time) = now();
    let line = format!("{time} {level:<5} {}\n", message.replace(['\r', '\n'], " "));
    let _ = fs::create_dir_all(dir());
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir().join(format!("nelcode-{day}.log"))) {
        let _ = f.write_all(line.as_bytes());
    }
    #[cfg(debug_assertions)]
    eprint!("{line}");
}

pub fn info(message: &str) {
    write("INFO", message);
}

pub fn error(message: &str) {
    write("ERROR", message);
}

/// Les journaux, du plus ancien au plus récent (le nom contient la date).
fn files() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir())
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("nelcode-") && n.ends_with(".log")))
        .collect();
    v.sort();
    v
}

/// Garde les 7 journaux les plus récents.
pub fn prune() {
    let files = files();
    for old in &files[..files.len().saturating_sub(KEEP_DAYS)] {
        let _ = fs::remove_file(old);
    }
}

/// Les `n` dernières lignes, sur plusieurs jours au besoin.
pub fn tail(n: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for f in files().iter().rev() {
        let text = fs::read_to_string(f).unwrap_or_default();
        let mut day: Vec<String> = text.lines().map(String::from).collect();
        day.append(&mut lines);
        lines = day;
        if lines.len() >= n {
            break;
        }
    }
    lines.split_off(lines.len().saturating_sub(n))
}

#[cfg(test)]
mod tests {
    #[test]
    fn dates() {
        assert_eq!(super::civil(0), (1970, 1, 1));
        assert_eq!(super::civil(20_769), (2026, 11, 12));
        assert_eq!(super::civil(11_016), (2000, 2, 29));
    }
}
