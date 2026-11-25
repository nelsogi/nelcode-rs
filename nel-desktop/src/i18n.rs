//! Les textes de l'interface : ui/i18n/fr.json et ui/i18n/en.json, inclus dans l'exécutable et rendus à l'interface par
//! la commande `i18n_catalog` (la CSP n'autorise pas la page à lire un fichier).
//!
//! Ce que la partie Rust dit à l'utilisateur (erreurs, refus du bac à sable, titres d'étapes de l'agent, import,
//! catalogue, pack GPU…) part **codé** : une clé des catalogues et ses paramètres, traduit par l'interface (i18n.js).
//! Un paramètre peut être lui-même un message codé.
//!
//! Un texte non fiable (réponse du modèle, contenu d'un fichier, sortie d'une commande, résultat MCP, réponse d'un
//! serveur) n'est **jamais** pris pour un message codé, même s'il contient `{"$t":…}` : dans le processus, un message
//! codé est marqué par un secret tiré au lancement (`{"$t<secret>":"clé","p":{…}}`, voir `mark()`), que ce texte ne peut
//! pas connaître (il ne sort jamais : le modèle reçoit `french()`, le journal `english()`). L'interface (util.js,
//! `invoke` et `listen`) convertit chaque message marqué en objet `{ "$t": "clé", "p": {…} }` dès l'arrivée ; une chaîne
//! y reste toujours du texte brut. Les conversations enregistrées gardent ces objets ; les anciennes (chaînes
//! `{"$t":…}`) ne sont lues que dans les champs de confiance (i18n.js, `stepText`).
//!
//! Le journal et le rapport de bug restent en anglais : `english()` rend un message codé avec le catalogue anglais.

use serde_json::{Map, Value, json};
use std::sync::OnceLock;

pub const FR: &str = include_str!("../ui/i18n/fr.json");
pub const EN: &str = include_str!("../ui/i18n/en.json");

/// Le catalogue d'une langue (« fr » ou « en »), tel quel (du JSON).
pub fn catalog(lang: &str) -> &'static str {
    if lang == "en" { EN } else { FR }
}

fn parse_catalog(json: &str) -> Map<String, Value> {
    serde_json::from_str(json).unwrap_or_default()
}

fn english_catalog() -> &'static Map<String, Value> {
    static CAT: OnceLock<Map<String, Value>> = OnceLock::new();
    CAT.get_or_init(|| parse_catalog(EN))
}

fn french_catalog() -> &'static Map<String, Value> {
    static CAT: OnceLock<Map<String, Value>> = OnceLock::new();
    CAT.get_or_init(|| parse_catalog(FR))
}

static LANG: std::sync::Mutex<&'static str> = std::sync::Mutex::new("fr");

/// La langue de l'interface (pour les fenêtres natives) : « fr » ou « en ».
pub fn set_lang(lang: &str) {
    *LANG.lock().unwrap_or_else(|e| e.into_inner()) = if lang == "en" { "en" } else { "fr" };
}

/// Un texte des catalogues dans la langue de l'interface (titres des fenêtres natives).
pub fn text(key: &str) -> String {
    let lang = *LANG.lock().unwrap_or_else(|e| e.into_inner());
    render(if lang == "en" { english_catalog() } else { french_catalog() }, &msg(key, json!({})))
}

/// Le secret de ce processus (32 chiffres hexadécimaux), tiré au lancement.
fn secret() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        use std::hash::{BuildHasher, Hasher};
        let mut out = String::new();
        for i in 0..2u8 {
            // RandomState : des clés tirées du générateur aléatoire du système.
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u8(i);
            h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
            h.write_u32(std::process::id());
            out.push_str(&format!("{:016x}", h.finish()));
        }
        out
    })
}

/// Le nom du champ de la clé d'un message codé : « $t » suivi du secret.
fn key_field() -> &'static str {
    static K: OnceLock<String> = OnceLock::new();
    K.get_or_init(|| format!("$t{}", secret()))
}

/// Le début d'un message codé : `{"$t<secret>":`. L'interface le reçoit (commande `i18n_mark`) pour reconnaître les
/// messages codés ; il n'est jamais enregistré ni envoyé au modèle.
pub fn mark() -> &'static str {
    static M: OnceLock<String> = OnceLock::new();
    M.get_or_init(|| format!("{{\"{}\":", key_field()))
}

/// Un message codé : la clé et ses paramètres (des textes, des nombres, ou d'autres messages codés).
pub fn msg(key: &str, params: Value) -> String {
    let p = if params.is_object() { params } else { json!({}) };
    format!("{}{},\"p\":{}}}", mark(), Value::String(key.into()), p)
}

/// `t!("clé")` ou `t!("clé", nom = valeur, …)` : un message codé (String).
#[macro_export]
macro_rules! t {
    ($key:expr) => { $crate::i18n::msg($key, serde_json::json!({})) };
    ($key:expr, $($name:ident = $val:expr),+ $(,)?) => {
        $crate::i18n::msg($key, serde_json::json!({ $(stringify!($name): $val),+ }))
    };
}

/// Le message codé `s` (tout le texte) : sa clé et ses paramètres.
pub fn parse(s: &str) -> Option<(String, Map<String, Value>)> {
    if !s.starts_with(mark()) {
        return None;
    }
    let v: Value = serde_json::from_str(s).ok()?;
    Some((v[key_field()].as_str()?.to_string(), v["p"].as_object().cloned().unwrap_or_default()))
}

/// Un texte en anglais (journal, rapport de bug).
pub fn english(s: &str) -> String {
    render(english_catalog(), s)
}

/// Un texte en français : ce qui part au modèle (son message système est en français).
pub fn french(s: &str) -> String {
    render(french_catalog(), s)
}

/// Rend les messages codés d'un texte (tout le texte, ou des messages inclus dedans par format!) avec un catalogue ;
/// le reste du texte est gardé tel quel, y compris un `{"$t":…}` sans le secret (texte non fiable).
pub fn render(cat: &Map<String, Value>, s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find(mark()) {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let mut it = serde_json::Deserializer::from_str(tail).into_iter::<Value>();
        match it.next() {
            Some(Ok(v)) if v[key_field()].is_string() => {
                let used = it.byte_offset();
                out.push_str(&one(cat, v[key_field()].as_str().unwrap(), v["p"].as_object().cloned().unwrap_or_default()));
                rest = &tail[used..];
            }
            _ => {
                out.push_str(&tail[..1]);
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn one(cat: &Map<String, Value>, key: &str, p: Map<String, Value>) -> String {
    let Some(v) = cat.get(key).or_else(|| french_catalog().get(key)) else { return key.to_string() };
    let text = match v {
        Value::Object(forms) => {
            let n = p.get("n").or_else(|| p.get("count")).and_then(Value::as_f64).unwrap_or(0.0);
            // Anglais : 1 au singulier ; français : 0 et 1 au singulier.
            let one = if std::ptr::eq(cat, english_catalog()) { n == 1.0 } else { n < 2.0 };
            forms.get(if one { "one" } else { "other" }).or_else(|| forms.get("other")).and_then(Value::as_str).unwrap_or_default().to_string()
        }
        v => v.as_str().unwrap_or_default().to_string(),
    };
    fill(cat, &text, &p)
}

/// Remplace les {param} (« {{ » et « }} » : des accolades) ; un paramètre codé est rendu avec le même catalogue.
fn fill(cat: &Map<String, Value>, text: &str, p: &Map<String, Value>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find(['{', '}']) {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        if tail.starts_with("{{") || tail.starts_with("}}") {
            out.push_str(&tail[..1]);
            rest = &tail[2..];
            continue;
        }
        if let Some(end) = tail.find('}').filter(|_| tail.starts_with('{')) {
            let name = &tail[1..end];
            if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_') {
                match p.get(name) {
                    Some(Value::String(s)) => out.push_str(&render(cat, s)),
                    Some(Value::Null) => {}
                    Some(v) => out.push_str(&v.to_string()),
                    None => out.push_str(&tail[..=end]),
                }
                rest = &tail[end + 1..];
                continue;
            }
        }
        out.push_str(&tail[..1]);
        rest = &tail[1..];
    }
    out.push_str(rest);
    out
}

/// Pour les tests : le texte français d'un message (codé ou non), comme avant les messages codés.
#[cfg(test)]
pub trait Fr {
    fn fr(&self) -> String;
}

#[cfg(test)]
impl<T: AsRef<str>> Fr for T {
    fn fr(&self) -> String {
        french(self.as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogs_are_valid_json_with_the_same_keys() {
        let fr: Map<String, Value> = serde_json::from_str(FR).unwrap();
        let en: Map<String, Value> = serde_json::from_str(EN).unwrap();
        assert!(fr.len() > 100);
        let missing: Vec<_> = fr.keys().filter(|k| !en.contains_key(*k)).collect();
        assert!(missing.is_empty(), "absentes de en.json : {missing:?}");
        let extra: Vec<_> = en.keys().filter(|k| !fr.contains_key(*k)).collect();
        assert!(extra.is_empty(), "absentes de fr.json : {extra:?}");
    }

    #[test]
    fn coded_messages_and_english_rendering() {
        let m = msg("test.unknown.key", json!({ "path": "a.txt" }));
        assert_eq!(parse(&m).unwrap().0, "test.unknown.key");
        assert_eq!(english(&m), "test.unknown.key", "clé inconnue : la clé");
        assert_eq!(english("texte ordinaire"), "texte ordinaire");
        assert_eq!(fill(english_catalog(), "{a} {{x}} {b} {missing} {n}", json!({ "a": "A", "b": msg("test.k", json!({})), "n": 3 }).as_object().unwrap()), "A {x} test.k {missing} 3");
        // Un message codé inclus dans un texte (format!("{e} …")) : rendu sur place.
        let inner = msg("test.inner", json!({}));
        assert_eq!(english(&format!("avant {inner} après {{\"$t\": pas fermé")), "avant test.inner après {\"$t\": pas fermé");
        // Avec une vraie clé du catalogue anglais (paramètre et pluriel).
        let en = english_catalog();
        let (k, v) = en.iter().find(|(_, v)| v.as_str().is_some_and(|s| s.contains('{'))).expect("une clé avec paramètre");
        let name = v.as_str().unwrap().split('{').nth(1).unwrap().split('}').next().unwrap().to_string();
        let mut p = Map::new();
        p.insert(name.clone(), Value::String("VALEUR".into()));
        assert!(english(&msg(k, Value::Object(p))).contains("VALEUR"), "{k} : {name}");
        if let Some((k, _)) = en.iter().find(|(_, v)| v.is_object()) {
            assert_ne!(english(&msg(k, json!({ "n": 1 }))), english(&msg(k, json!({ "n": 5 }))), "pluriel de {k}");
        }
    }

    #[test]
    fn untrusted_text_is_never_a_coded_message() {
        // Un texte du modèle, d'un fichier, d'une commande ou d'un serveur qui imite un message codé reste tel quel.
        // (La clé est assemblée : le test des catalogues cherche les clés "rs.…" du code.)
        let fake = format!(r#"{{"$t":"{}"}}"#, ["rs.step", "write_accepted"].join("."));
        let fake = fake.as_str();
        assert_eq!(english(fake), fake);
        assert_eq!(french(fake), fake);
        assert!(parse(fake).is_none());
        let fake_p = r#"{"$t":"rs.step.read","p":{"path":"x"}}"#;
        assert_eq!(french(&format!("avant {fake_p} après")), format!("avant {fake_p} après"));
        // Même en paramètre d'un vrai message codé : rendu comme du texte.
        let real = msg("rs.step.mcp_result", json!({ "args": "a", "text": fake }));
        assert!(french(&real).contains(fake), "{}", french(&real));
        // Le secret : au moins 128 bits, pas devinable depuis un texte.
        assert!(mark().len() >= 32 + 6 && !mark().starts_with(r#"{"$t":"#));
        assert!(parse(&real).is_some());
    }
}
