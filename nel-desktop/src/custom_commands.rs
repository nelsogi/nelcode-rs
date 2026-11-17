//! Commandes personnalisées : les fichiers `.md` de `.nelcode/commands/` (dans le dossier de travail, lus par
//! `Sandbox` : liens et sorties du dossier refusés) et de `%APPDATA%\NelCode\commands` (globales).
//! Une commande n'est qu'un texte (avec `$ARGUMENTS`) que l'interface envoie au modèle comme un message ordinaire :
//! rien n'est lancé ici, et le mode Agent garde toutes ses validations.
//! Front matter facultatif : `description: …`. Une commande du projet remplace une globale du même nom.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::Path;

use serde_json::{Value, json};

use crate::agent::Sandbox;
use crate::store::{self, Result};

const MAX_BYTES: u64 = 64 * 1024;
const MAX_COMMANDS: usize = 200;
const PROJECT_DIR: &str = ".nelcode/commands";

/// Minuscules, chiffres, « - » et « _ », 40 caractères au plus (le nom du fichier sans « .md »).
pub fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 40 && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// (description, texte) d'un fichier : le front matter `---` … `---` est facultatif.
pub fn parse(text: &str) -> (String, String) {
    let t = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    if let Some(rest) = t.strip_prefix("---\n")
        && let Some(end) = rest.find("\n---")
        && (rest[end + 4..].is_empty() || rest[end + 4..].starts_with('\n'))
    {
        let description = rest[..end].lines().find_map(|l| l.strip_prefix("description:")).map(|d| d.trim().trim_matches(['"', '\'']).trim().to_string()).unwrap_or_default();
        return (description, rest[end + 4..].trim().to_string());
    }
    (String::new(), t.trim().to_string())
}

/// Les commandes d'un dossier : fichiers `.md` ordinaires (ni lien, ni trop gros), au nom valide.
fn scan(dir: &Path, origin: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = e.path();
        let ordinary = fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file() && m.len() <= MAX_BYTES);
        let name = path.file_stem().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        if !ordinary || path.extension().and_then(|x| x.to_str()).map(str::to_lowercase).as_deref() != Some("md") || !valid_name(&name) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let (description, body) = parse(&text);
        out.push(json!({ "name": name, "description": description, "origin": origin, "body": body, "path": path.to_string_lossy() }));
    }
    out
}

/// Le projet d'abord : à nom égal, sa commande remplace la globale. Triées par nom.
fn merge(project: Vec<Value>, global: Vec<Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut all: Vec<Value> = project.into_iter().chain(global).filter(|c| seen.insert(c["name"].as_str().unwrap_or_default().to_string())).collect();
    all.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    all.truncate(MAX_COMMANDS);
    all
}

pub fn list(dir: &str) -> Vec<Value> {
    let project = Sandbox::new(dir).and_then(|sb| sb.resolve(PROJECT_DIR)).map(|d| scan(&d, "project")).unwrap_or_default();
    merge(project, scan(&store::root().join("commands"), "global"))
}

/// Crée `<name>.md` dans le projet (`scope` = "project") ou en global, avec un modèle ; jamais par-dessus un fichier.
/// Rend le chemin du fichier.
pub fn create(dir: &str, scope: &str, name: &str, description: &str) -> Result<String> {
    let name = name.trim().trim_start_matches('/').to_lowercase();
    if !valid_name(&name) {
        return Err("nom invalide : lettres minuscules, chiffres, « - » et « _ », 40 caractères au plus".into());
    }
    let folder = match scope {
        "project" => Sandbox::new(dir)?.resolve(PROJECT_DIR)?,
        "global" => store::root().join("commands"),
        _ => return Err("portée inconnue (project ou global)".into()),
    };
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let file = folder.join(format!("{name}.md"));
    let description = description.lines().next().unwrap_or_default().trim();
    let text = format!("---\ndescription: {description}\n---\nDécris ici ce que le modèle doit faire. $ARGUMENTS est remplacé par le texte tapé après la commande.\n\n$ARGUMENTS\n");
    fs::OpenOptions::new().write(true).create_new(true).open(&file).and_then(|mut f| f.write_all(text.as_bytes())).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists { format!("la commande /{name} existe déjà : {}", file.display()) } else { e.to_string() }
    })?;
    Ok(file.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nelcode-cmds-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn front_matter() {
        assert_eq!(parse("---\ndescription: Relire le code\n---\nRelis $ARGUMENTS\n"), ("Relire le code".into(), "Relis $ARGUMENTS".into()));
        assert_eq!(parse("---\r\ndescription: \"Avec guillemets\"\r\nautre: x\r\n---\r\nTexte"), ("Avec guillemets".into(), "Texte".into()));
        assert_eq!(parse("\u{feff}Sans front matter\n"), (String::new(), "Sans front matter".into()));
        assert_eq!(parse("---\nautre: x\n---\nSans description"), (String::new(), "Sans description".into()));
        assert_eq!(parse("---\ndescription: x\n---"), ("x".into(), String::new()));
        assert_eq!(parse("--- pas un front matter\ntexte"), (String::new(), "--- pas un front matter\ntexte".into()));
    }

    #[test]
    fn noms_valides() {
        for ok in ["review", "a-b_c9"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["", "Review", "a b", "a/b", "..", "é", &"x".repeat(41)] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn dossier_et_priorite_du_projet() {
        let d = tmp();
        let (p, g) = (d.join("projet"), d.join("global"));
        fs::create_dir_all(&p).unwrap();
        fs::create_dir_all(&g).unwrap();
        fs::write(p.join("review.md"), "---\ndescription: Du projet\n---\nA").unwrap();
        fs::write(g.join("review.md"), "B").unwrap();
        fs::write(g.join("notes.md"), "C").unwrap();
        fs::write(g.join("Mauvais Nom.md"), "D").unwrap();
        fs::write(g.join("lisez.txt"), "E").unwrap();
        fs::write(g.join("gros.md"), "x".repeat(MAX_BYTES as usize + 1)).unwrap();
        let all = merge(scan(&p, "project"), scan(&g, "global"));
        let names: Vec<_> = all.iter().map(|c| (c["name"].as_str().unwrap(), c["origin"].as_str().unwrap(), c["body"].as_str().unwrap())).collect();
        assert_eq!(names, [("notes", "global", "C"), ("review", "project", "A")]);
        assert_eq!(all[1]["description"], "Du projet");
    }

    #[test]
    fn creation_sans_ecraser() {
        let d = tmp();
        let dir = d.to_str().unwrap();
        let file = create(dir, "project", "/Relire", "Relire le code\nsuite ignorée").unwrap();
        assert!(file.replace('\\', "/").ends_with(".nelcode/commands/relire.md"));
        let projet: Vec<_> = list(dir).into_iter().filter(|c| c["origin"] == "project").collect();
        assert_eq!((projet[0]["name"].as_str(), projet[0]["description"].as_str()), (Some("relire"), Some("Relire le code")));
        assert!(create(dir, "project", "relire", "autre").unwrap_err().contains("existe déjà"));
        assert!(fs::read_to_string(&file).unwrap().contains("Relire le code"), "le fichier existant n'est pas touché");
        assert!(create(dir, "project", "../x", "").unwrap_err().contains("nom invalide"));
        assert!(create(dir, "ailleurs", "x", "").is_err());
    }
}
