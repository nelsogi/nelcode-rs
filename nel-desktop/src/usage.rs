//! Le suivi de l'utilisation : %APPDATA%\NelCode\usage.jsonl, une ligne JSON par réponse (chat, mode Agent,
//! Claude Agent, serveur local). Jamais le texte des messages : date, projet (dossier de travail), fournisseur, modèle,
//! tokens d'entrée et de sortie, durée, tokens/s, type, coût estimé.
//!
//! Une ligne : `{ ts, date, project, provider, model, kind, input, output, seconds, tps, cost }` (`ts` : secondes Unix ;
//! `date` : heure locale « 2026-11-19T10:23:45 »). Les lignes de plus de 90 jours sont regroupées par jour (et par
//! projet, fournisseur, modèle, type) : `date` n'a alors que le jour, et `n` compte les réponses regroupées.
//!
//! Les coûts sont des estimations : la table de prix (réglages `prices`, sinon `default_prices`) en dollars par million
//! de tokens, à 0 pour les modèles de ce PC et ceux qui n'y sont pas ; Claude Agent donne son propre coût.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use crate::store;

/// Les lignes plus anciennes sont regroupées par jour.
pub const KEEP_DAYS: i64 = 90;
/// La page officielle des tarifs, et le jour où la table par défaut y a été vérifiée.
pub const PRICES_SOURCE: &str = "https://platform.claude.com/docs/en/about-claude/pricing";
pub const PRICES_CHECKED: &str = "2026-11-19";

static LOCK: Mutex<()> = Mutex::new(());

pub fn path() -> PathBuf {
    store::root().join("usage.jsonl")
}

/// Les prix des modèles Claude (API d'Anthropic, tarif de base, $ par million de tokens), relevés sur PRICES_SOURCE.
/// Claude Haiku 5.5 : le prix des prompts jusqu'à 100 000 tokens.
pub fn default_prices() -> Value {
    let p = [
        ("claude-fable-5-2", 8.0, 40.0),
        ("claude-mythos-5-2", 8.0, 40.0),
        ("claude-fable-5-1", 10.0, 50.0),
        ("claude-mythos-5-1", 10.0, 50.0),
        ("claude-fable-5", 10.0, 50.0),
        ("claude-mythos-5", 10.0, 50.0),
        ("claude-opus-5-5", 4.0, 20.0),
        ("claude-opus-5", 5.0, 25.0),
        ("claude-opus-4-8", 5.0, 25.0),
        ("claude-opus-4-7", 5.0, 25.0),
        ("claude-opus-4-6", 5.0, 25.0),
        ("claude-opus-4-5", 5.0, 25.0),
        ("claude-opus-4-1", 15.0, 75.0),
        ("claude-opus-4", 15.0, 75.0),
        ("claude-sonnet-5-5", 2.0, 10.0),
        ("claude-sonnet-5", 2.0, 10.0),
        ("claude-sonnet-4-6", 3.0, 15.0),
        ("claude-sonnet-4-5", 3.0, 15.0),
        ("claude-sonnet-4", 3.0, 15.0),
        ("claude-haiku-5-5", 0.1, 0.5),
        ("claude-haiku-4-5", 1.0, 5.0),
    ];
    p.iter().map(|(m, i, o)| json!({ "model": m, "input": i, "output": o })).collect()
}

/// La table de prix nettoyée : `{ model, input, output }`, nom non vide, prix finis et positifs, 300 au plus.
/// Rend None si `v` n'est pas une liste (la table par défaut s'applique).
pub fn clean_prices(v: &Value) -> Option<Value> {
    let list = v.as_array()?;
    let mut out: Vec<Value> = Vec::new();
    for p in list {
        let model = p["model"].as_str().map(str::trim).unwrap_or_default().to_lowercase();
        let num = |x: &Value| x.as_f64().or_else(|| x.as_str().and_then(|s| s.trim().replace(',', ".").parse().ok())).filter(|n: &f64| n.is_finite() && *n >= 0.0);
        let (Some(i), Some(o)) = (num(&p["input"]), num(&p["output"])) else { continue };
        if model.is_empty() || out.iter().any(|q| q["model"] == model.as_str()) || out.len() >= 300 {
            continue;
        }
        out.push(json!({ "model": model, "input": i, "output": o }));
    }
    Some(out.into())
}

/// La table en vigueur : celle des réglages, sinon celle par défaut.
pub fn prices() -> Value {
    let s = store::load_settings();
    if s["prices"].is_array() { s["prices"].clone() } else { default_prices() }
}

/// Le prix (entrée, sortie) de `model` : l'entrée de la table la plus longue dont il est le nom, ou le début suivi de
/// « - », « @ », « . » ou « : » (une date ou une variante : « claude-sonnet-4-5-20250929 », « …@20250929 »). Un préfixe
/// de fournisseur (« anthropic/claude-… ») est ignoré.
pub fn price_of(prices: &Value, model: &str) -> Option<(f64, f64)> {
    let m = model.trim().to_lowercase();
    let m = m.rsplit('/').next().unwrap_or(&m);
    prices
        .as_array()?
        .iter()
        .filter_map(|p| Some((p["model"].as_str()?.to_lowercase(), p["input"].as_f64()?, p["output"].as_f64()?)))
        .filter(|(k, _, _)| !k.is_empty() && (m == k || m.strip_prefix(k.as_str()).is_some_and(|rest| rest.starts_with(['-', '@', '.', ':']))))
        .max_by_key(|(k, _, _)| k.len())
        .map(|(_, i, o)| (i, o))
}

/// Le coût estimé, en dollars.
pub fn cost(prices: &Value, model: &str, input: u64, output: u64) -> f64 {
    price_of(prices, model).map_or(0.0, |(i, o)| (input as f64 * i + output as f64 * o) / 1e6)
}

/// L'heure locale : (secondes Unix, « AAAA-MM-JJTHH:MM:SS »).
pub fn local_now() -> (i64, String) {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let (y, mo, d, h, mi, s) = crate::os::local_time(ts);
    (ts, format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}"))
}

/// Une réponse à enregistrer. `cost` : le coût donné par l'outil (Claude Agent) ; sinon calculé avec la table
/// (`local` : un modèle de ce PC, toujours gratuit).
pub struct Rec<'a> {
    pub project: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub kind: &'a str,
    pub input: u64,
    pub output: u64,
    pub seconds: f64,
    pub cost: Option<f64>,
    pub local: bool,
}

/// La ligne de `r` (sans écrire).
pub fn line(r: &Rec, prices: &Value, ts: i64, date: &str) -> Value {
    let cost = if r.local { 0.0 } else { r.cost.filter(|c| c.is_finite() && *c >= 0.0).unwrap_or_else(|| cost(prices, r.model, r.input, r.output)) };
    let seconds = if r.seconds.is_finite() { r.seconds.max(0.0) } else { 0.0 };
    json!({
        "ts": ts, "date": date, "project": r.project, "provider": r.provider, "model": r.model, "kind": r.kind,
        "input": r.input, "output": r.output, "seconds": round(seconds, 3),
        "tps": if seconds > 0.0 { round(r.output as f64 / seconds, 2) } else { 0.0 }, "cost": round(cost, 8),
    })
}

fn round(x: f64, digits: i32) -> f64 {
    let f = 10f64.powi(digits);
    (x * f).round() / f
}

/// Enregistre une réponse dans usage.jsonl ; rend `{ input, output, cost }` pour l'interface (en-tête de la conversation).
/// Une erreur d'écriture va dans le journal, jamais à l'utilisateur.
pub fn record(r: Rec) -> Value {
    let (ts, date) = local_now();
    let l = line(&r, &prices(), ts, &date);
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _ = fs::create_dir_all(store::root());
    let written = fs::OpenOptions::new().create(true).append(true).open(path()).and_then(|mut f| f.write_all(format!("{l}\n").as_bytes()));
    if let Err(e) = written {
        crate::log::error(&format!("suivi : usage.jsonl non écrit ({e})"));
    }
    json!({ "input": l["input"], "output": l["output"], "cost": l["cost"] })
}

/// Les lignes lisibles d'un fichier (les autres sont ignorées).
pub fn read(path: &Path) -> Vec<Value> {
    fs::read_to_string(path).unwrap_or_default().lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(Value::is_object).collect()
}

pub fn load() -> Vec<Value> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read(&path())
}

/// Regroupe par jour (et par projet, fournisseur, modèle, type) les lignes d'avant `cutoff` (secondes Unix), déjà
/// regroupées comprises : rendre le résultat une deuxième fois ne change rien. Les sommes : n, tokens, durée, coût ;
/// tokens/s recalculé. Les lignes récentes restent telles quelles, l'ordre aussi (les jours regroupés en tête).
pub fn compact(entries: Vec<Value>, cutoff: i64) -> Vec<Value> {
    let (old, recent): (Vec<Value>, Vec<Value>) = entries.into_iter().partition(|e| e["ts"].as_i64().unwrap_or(0) < cutoff);
    let mut days: Vec<Value> = Vec::new();
    for e in old {
        let day: String = e["date"].as_str().unwrap_or_default().chars().take(10).collect();
        let key = |x: &Value| (x["date"].as_str() == Some(day.as_str())) && ["project", "provider", "model", "kind"].iter().all(|k| x[k] == e[k]);
        let n = e["n"].as_u64().unwrap_or(1);
        match days.iter_mut().find(|d| key(&**d)) {
            Some(d) => {
                d["n"] = (d["n"].as_u64().unwrap_or(0) + n).into();
                for k in ["input", "output"] {
                    d[k] = (d[k].as_u64().unwrap_or(0) + e[k].as_u64().unwrap_or(0)).into();
                }
                for k in ["seconds", "cost"] {
                    d[k] = round(d[k].as_f64().unwrap_or(0.0) + e[k].as_f64().unwrap_or(0.0), 8).into();
                }
                d["ts"] = d["ts"].as_i64().unwrap_or(0).min(e["ts"].as_i64().unwrap_or(0)).into();
            }
            None => {
                let mut d = Map::new();
                for k in ["ts", "project", "provider", "model", "kind", "input", "output", "seconds", "cost"] {
                    d.insert(k.into(), e[k].clone());
                }
                d.insert("date".into(), day.clone().into());
                d.insert("n".into(), n.into());
                days.push(d.into());
            }
        }
    }
    for d in &mut days {
        let (out, s) = (d["output"].as_u64().unwrap_or(0) as f64, d["seconds"].as_f64().unwrap_or(0.0));
        d["tps"] = if s > 0.0 { round(out / s, 2) } else { 0.0 }.into();
    }
    days.extend(recent);
    days
}

/// Au démarrage : regroupe les lignes de plus de 90 jours (le fichier ne grossit pas sans fin). Réécrit le fichier
/// seulement s'il y a quelque chose à regrouper (par un fichier temporaire, puis renommage).
pub fn prune() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let file = path();
    let entries = read(&file);
    let cutoff = local_now().0 - KEEP_DAYS * 86_400;
    let raw_old = entries.iter().filter(|e| e["ts"].as_i64().unwrap_or(0) < cutoff && e["n"].is_null()).count();
    if raw_old == 0 {
        return;
    }
    let before = entries.len();
    let kept = compact(entries, cutoff);
    let tmp = file.with_extension("jsonl.tmp");
    let text: String = kept.iter().map(|e| format!("{e}\n")).collect();
    match fs::write(&tmp, text).and_then(|_| fs::rename(&tmp, &file)) {
        Ok(()) => crate::log::info(&format!("suivi : {before} lignes, {} après regroupement par jour des plus de {KEEP_DAYS} jours", kept.len())),
        Err(e) => crate::log::error(&format!("suivi : regroupement impossible ({e})")),
    }
}

/// Le coût des lignes du mois `month` (« 2026-11 »).
pub fn month_cost(entries: &[Value], month: &str) -> f64 {
    entries.iter().filter(|e| e["date"].as_str().is_some_and(|d| d.starts_with(month))).map(|e| e["cost"].as_f64().unwrap_or(0.0)).sum()
}

/// Avant une demande : est-elle payante (Claude Agent, ou un modèle distant avec un prix), et où en est le budget du
/// mois (`budgetMonthly`, 0 : aucun ; `budgetConfirm` : demander confirmation à 100 %).
pub fn budget(model: Option<&str>, claude: bool) -> Value {
    let s = store::load_settings();
    let paid = claude || model.and_then(|m| price_of(&prices(), m)).is_some_and(|(i, o)| i > 0.0 || o > 0.0);
    let month: String = local_now().1.chars().take(7).collect();
    let spent = month_cost(&load(), &month);
    let budget = s["budgetMonthly"].as_f64().unwrap_or(0.0);
    json!({ "paid": paid, "month": month, "monthCost": spent, "budget": budget, "confirm": s["budgetConfirm"] != false,
        "percent": if budget > 0.0 { 100.0 * spent / budget } else { 0.0 } })
}

/// L'export CSV (séparateur « ; », pour Excel en français ; points décimaux ; noms de colonnes en anglais, pour les
/// outils qui le reliront), avec un BOM UTF-8.
pub fn csv(entries: &[Value]) -> String {
    let field = |v: &Value| {
        let s = match v {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            v => v.to_string(),
        };
        if s.contains([';', '"', '\n', '\r']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s }
    };
    let cols = ["date", "project", "provider", "model", "kind", "input", "output", "seconds", "tps", "cost", "n"];
    let mut out = String::from("\u{feff}date;project;provider;model;kind;input_tokens;output_tokens;duration_s;tokens_per_s;estimated_cost_usd;responses\r\n");
    for e in entries {
        let mut row: Vec<String> = cols.iter().map(|k| field(&e[*k])).collect();
        if row[10].is_empty() {
            row[10] = "1".into();
        }
        out += &row.join(";");
        out += "\r\n";
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec<'a>(model: &'a str, local: bool, cost: Option<f64>) -> Rec<'a> {
        Rec { project: "C:\\p", provider: "x", model, kind: "chat", input: 1_000_000, output: 100_000, seconds: 2.0, cost, local }
    }

    #[test]
    fn prix_par_modele() {
        let p = default_prices();
        assert_eq!(price_of(&p, "claude-opus-5-5"), Some((4.0, 20.0)));
        assert_eq!(price_of(&p, "claude-sonnet-4-5-20250929"), Some((3.0, 15.0)), "date en suffixe");
        assert_eq!(price_of(&p, "claude-opus-4-20250514"), Some((15.0, 75.0)), "le préfixe le plus long gagne");
        assert_eq!(price_of(&p, "anthropic/Claude-Haiku-4-5"), Some((1.0, 5.0)), "fournisseur et casse ignorés");
        assert_eq!(price_of(&p, "claude-opus-55"), None, "pas un simple début de nom");
        assert_eq!(price_of(&p, "qwen2.5-coder"), None);
        assert!((cost(&p, "claude-sonnet-5-5", 1_000_000, 100_000) - 3.0).abs() < 1e-9);
        assert_eq!(cost(&p, "llama3", 1_000_000, 1_000_000), 0.0, "modèle sans prix : 0");
    }

    #[test]
    fn table_nettoyee() {
        let t = clean_prices(&json!([{ "model": " Mon-Modèle ", "input": "1,5", "output": 2 }, { "model": "", "input": 1, "output": 1 },
            { "model": "x", "input": -1, "output": 1 }, { "model": "mon-modèle", "input": 9, "output": 9 }])).unwrap();
        assert_eq!(t, json!([{ "model": "mon-modèle", "input": 1.5, "output": 2.0 }]));
        assert!(clean_prices(&Value::Null).is_none());
    }

    #[test]
    fn ligne_sans_texte_et_cout() {
        let p = default_prices();
        let l = line(&rec("claude-opus-5-5", false, None), &p, 100, "2026-11-19T10:00:00");
        assert!((l["cost"].as_f64().unwrap() - 6.0).abs() < 1e-9);
        assert_eq!(l["tps"], 50_000.0);
        let keys: Vec<&String> = l.as_object().unwrap().keys().collect();
        assert_eq!(keys.len(), 11, "seulement les champs prévus : {keys:?}");
        assert_eq!(line(&rec("claude-opus-5-5", true, None), &p, 0, "")["cost"], 0.0, "modèle de ce PC : gratuit");
        assert_eq!(line(&rec("claude-agent", false, Some(0.25)), &p, 0, "")["cost"], 0.25, "coût donné par Claude Agent");
        let zero = Rec { seconds: 0.0, ..rec("m", false, None) };
        assert_eq!(line(&zero, &p, 0, "")["tps"], 0.0);
    }

    #[test]
    fn regroupement_par_jour() {
        let e = |ts: i64, date: &str, model: &str, cost: f64| json!({ "ts": ts, "date": date, "project": "p", "provider": "f", "model": model, "kind": "chat", "input": 10, "output": 20, "seconds": 2.0, "tps": 10.0, "cost": cost });
        let all = vec![e(1, "2026-01-01T08:00:00", "a", 0.5), e(2, "2026-01-01T09:00:00", "a", 0.25), e(3, "2026-01-01T10:00:00", "b", 0.0), e(4, "2026-01-02T10:00:00", "a", 1.0), e(500, "2026-05-01T10:00:00", "a", 1.0)];
        let c = compact(all, 100);
        assert_eq!(c.len(), 4, "3 jours-modèles + la ligne récente");
        assert_eq!(c[0]["date"], "2026-01-01");
        assert_eq!((c[0]["n"].as_u64(), c[0]["input"].as_u64(), c[0]["output"].as_u64()), (Some(2), Some(20), Some(40)));
        assert_eq!((c[0]["seconds"].as_f64(), c[0]["cost"].as_f64(), c[0]["tps"].as_f64()), (Some(4.0), Some(0.75), Some(10.0)));
        assert_eq!(c[3]["ts"], 500);
        assert!(c[3]["n"].is_null(), "les lignes récentes ne changent pas");
        // Une deuxième fois : rien ne change.
        assert_eq!(compact(c.clone(), 100), c);
        assert!((month_cost(&c, "2026-01") - 1.75).abs() < 1e-9);
        assert_eq!(month_cost(&c, "2026-05"), 1.0);
    }

    #[test]
    fn export_csv() {
        let c = csv(&[json!({ "date": "2026-11-19T10:00:00", "project": "C:\\mon;projet", "provider": "local", "model": "m\"x", "kind": "chat", "input": 3, "output": 4, "seconds": 1.5, "tps": 2.67, "cost": 0.0 })]);
        let lines: Vec<&str> = c.split("\r\n").collect();
        assert!(lines[0].starts_with("\u{feff}date;project;provider;model;kind;input_tokens;output_tokens;"));
        assert_eq!(lines[1], "2026-11-19T10:00:00;\"C:\\mon;projet\";local;\"m\"\"x\";chat;3;4;1.5;2.67;0.0;1");
    }

    #[test]
    fn heure_locale() {
        let (ts, d) = local_now();
        assert!(ts > 1_700_000_000 && d.len() == 19 && &d[10..11] == "T", "{d}");
    }

    #[test]
    fn lecture_ignore_les_lignes_abimees() {
        let dir = std::env::temp_dir().join(format!("nelcode-usage-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("usage.jsonl");
        fs::write(&f, "{\"ts\":1}\npas du json\n[1]\n{\"ts\":2}\n").unwrap();
        assert_eq!(read(&f).len(), 2);
        fs::remove_dir_all(&dir).unwrap();
    }
}
