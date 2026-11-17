//! Points de restauration du mode Agent : avant chaque demande, si le dossier de travail est dans un dépôt git,
//! son état (fichiers suivis et non suivis, sans ceux ignorés par .gitignore) devient un commit à part, gardé sous
//! refs/nelcode/checkpoints/<id> (git gc ne le ramasse pas). L'index, HEAD, les branches et le stash de l'utilisateur
//! ne sont jamais touchés : git travaille sur un index temporaire (GIT_INDEX_FILE).
//! Création et restauration se limitent au dossier de travail (git lancé dedans, chemins relatifs à lui).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::store::Result;

/// Lance git dans `dir` (sans fenêtre), avec l'index `index` s'il est donné. Rend la sortie standard. Sans conversion
/// des fins de ligne (core.autocrlf) : les fichiers reviennent octet pour octet. L'auteur des points : Nel Code.
fn git(dir: &Path, index: Option<&Path>, args: &[&str]) -> Result<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.autocrlf=false", "-c", "user.name=Nel Code", "-c", "user.email=nelcode@localhost"]).args(args).current_dir(dir).stdin(Stdio::null()).creation_flags(CREATE_NO_WINDOW);
    if let Some(i) = index {
        cmd.env("GIT_INDEX_FILE", i);
    }
    let o = cmd.output().map_err(|e| format!("git introuvable : {e}"))?;
    if !o.status.success() {
        return Err(format!("git {} : {}", args[0], String::from_utf8_lossy(&o.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&o.stdout).into_owned())
}

fn random_hex() -> String {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).expect("générateur aléatoire du système");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Un index temporaire, effacé à la fin.
struct TempIndex(PathBuf);

impl TempIndex {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("nelcode-index-{}", random_hex())))
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("point de restauration invalide".into());
    }
    Ok(())
}

/// Crée un point du dossier `dir` et rend son id ; None si `dir` n'est pas dans un dépôt git (pas de point).
pub fn create(dir: &str) -> Result<Option<String>> {
    let id = format!("c{}", random_hex());
    let dir = Path::new(dir);
    match git(dir, None, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(s) if s.trim() == "true" => {}
        Err(e) if e.starts_with("git introuvable") => return Err(e),
        _ => return Ok(None),
    }
    // Un index vide : chaque fichier du dossier est relu tel quel (pas les infos de l'index de l'utilisateur, faites
    // peut-être avec une autre conversion des fins de ligne).
    // ponytail: tout est rehaché à chaque demande ; partir d'une copie de l'index si c'est trop lent sur un gros dépôt.
    let index = TempIndex::new();
    git(dir, Some(&index.0), &["add", "-A", "--", "."])?;
    let tree = git(dir, Some(&index.0), &["write-tree"])?;
    let head = git(dir, None, &["rev-parse", "--verify", "-q", "HEAD"]).unwrap_or_default();
    let mut args = vec!["commit-tree", "--no-gpg-sign", tree.trim(), "-m", "Nel Code : point de restauration avant une demande"];
    if !head.trim().is_empty() {
        args.extend(["-p", head.trim()]);
    }
    let commit = git(dir, None, &args)?;
    git(dir, None, &["update-ref", &format!("refs/nelcode/checkpoints/{id}"), commit.trim()])?;
    Ok(Some(id))
}

/// Remet le dossier `dir` dans l'état du point `id` : les fichiers du point reprennent leur contenu, ceux créés depuis
/// (non ignorés) sont supprimés. Les fichiers ignorés, l'index et HEAD de l'utilisateur ne changent pas.
pub fn restore(dir: &str, id: &str) -> Result<()> {
    valid_id(id)?;
    let dir = Path::new(dir);
    let tree = git(dir, None, &["rev-parse", "--verify", "-q", &format!("refs/nelcode/checkpoints/{id}^{{tree}}")])
        .map_err(|_| "ce point de restauration n'existe plus dans le dépôt (supprimé, ou dossier de travail déplacé)".to_string())?;
    let index = TempIndex::new();
    git(dir, Some(&index.0), &["read-tree", tree.trim()])?;
    // Lancé dans `dir`, checkout-index -a n'écrit que les fichiers sous `dir`.
    git(dir, Some(&index.0), &["checkout-index", "-a", "-f"])?;
    // Ce qui n'est pas dans le point et pas ignoré : créé depuis. Seulement des fichiers (jamais un dossier entier).
    let others = git(dir, Some(&index.0), &["ls-files", "-z", "--others", "--exclude-standard"])?;
    for rel in others.split('\0').filter(|r| !r.is_empty() && !r.ends_with('/')) {
        if let Err(e) = fs::remove_file(dir.join(rel)) {
            crate::log::error(&format!("point de restauration : « {rel} » non supprimé : {e}"));
        }
    }
    crate::log::info(&format!("point de restauration {id} remis"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("nelcode-ckpt-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn read(d: &Path, f: &str) -> String {
        fs::read_to_string(d.join(f)).unwrap()
    }

    #[test]
    fn creation_et_restauration() {
        let d = tmp();
        let g = |args: &[&str]| git(&d, None, args).unwrap();
        g(&["init", "-q"]);
        fs::write(d.join(".gitignore"), "*.log\n").unwrap();
        fs::write(d.join("suivi.txt"), "v1\n").unwrap();
        g(&["add", "-A"]);
        g(&["commit", "-q", "--no-gpg-sign", "-m", "init"]);
        // Avant la demande : un fichier suivi modifié (et indexé à moitié), un non suivi, un ignoré.
        fs::write(d.join("suivi.txt"), "v2\n").unwrap();
        g(&["add", "suivi.txt"]);
        fs::write(d.join("suivi.txt"), "v3\n").unwrap();
        fs::write(d.join("libre.txt"), "libre\n").unwrap();
        fs::write(d.join("trace.log"), "log1\n").unwrap();
        let (head, staged, refs) = (g(&["rev-parse", "HEAD"]), g(&["diff", "--cached"]), g(&["for-each-ref", "refs/heads", "refs/stash"]));
        let dir = d.to_str().unwrap();
        let id = create(dir).unwrap().expect("un point");
        // Pendant la demande.
        fs::write(d.join("suivi.txt"), "agent\n").unwrap();
        fs::remove_file(d.join("libre.txt")).unwrap();
        fs::create_dir_all(d.join("neuf")).unwrap();
        fs::write(d.join("neuf/cree.txt"), "x").unwrap();
        fs::write(d.join("trace.log"), "log2\n").unwrap();
        restore(dir, &id).unwrap();
        assert_eq!(read(&d, "suivi.txt"), "v3\n");
        assert_eq!(read(&d, "libre.txt"), "libre\n");
        assert!(!d.join("neuf/cree.txt").exists(), "créé depuis : supprimé");
        assert_eq!(read(&d, "trace.log"), "log2\n", "ignoré : intact");
        // L'utilisateur : HEAD, index (v2 indexé), branches et stash inchangés.
        assert_eq!((g(&["rev-parse", "HEAD"]), g(&["diff", "--cached"]), g(&["for-each-ref", "refs/heads", "refs/stash"])), (head, staged, refs));
        assert!(g(&["show", ":suivi.txt"]) == "v2\n");
        assert!(restore(dir, "r2").unwrap_err().contains("n'existe plus"));
        assert!(restore(dir, "../x").is_err());
        // Un sous-dossier comme dossier de travail : rien n'est touché à côté.
        fs::create_dir_all(d.join("sous")).unwrap();
        fs::write(d.join("sous/a.txt"), "a\r\n").unwrap();
        let sous = d.join("sous");
        let id = create(sous.to_str().unwrap()).unwrap().unwrap();
        fs::write(d.join("sous/a.txt"), "b").unwrap();
        fs::write(d.join("sous/b.txt"), "b").unwrap();
        fs::write(d.join("suivi.txt"), "dehors\n").unwrap();
        restore(sous.to_str().unwrap(), &id).unwrap();
        assert_eq!((read(&d, "sous/a.txt"), d.join("sous/b.txt").exists(), read(&d, "suivi.txt")), ("a\r\n".into(), false, "dehors\n".into()));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn dossier_sans_git() {
        let d = tmp();
        assert_eq!(create(d.to_str().unwrap()), Ok(None));
        let _ = fs::remove_dir_all(&d);
    }
}
