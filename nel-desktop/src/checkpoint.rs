//! Points de restauration du mode Agent : avant chaque demande, si le dossier de travail est dans un dépôt git,
//! son état (fichiers suivis et non suivis, sans ceux ignorés par .gitignore ni les fichiers protégés) devient un
//! commit à part, gardé sous refs/nelcode/checkpoints/<dossier>/<id> (git gc ne le ramasse pas) ; les 20 derniers
//! points de chaque dossier sont gardés. L'index, HEAD, les branches et le stash de l'utilisateur ne sont jamais
//! touchés : git travaille sur un index temporaire (GIT_INDEX_FILE).
//! Création et restauration se limitent au dossier de travail (git lancé dedans, chemins relatifs à lui).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::agent::{extra_protected, protected_by};
use crate::store::Result;

/// Le nombre de points gardés par dossier de travail.
const KEEP: usize = 20;

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

/// Un fichier temporaire (index, liste de chemins), effacé à la fin.
struct TempFile(PathBuf);

impl TempFile {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("nelcode-git-{}", random_hex())))
    }
}

impl Drop for TempFile {
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

/// Le dossier des points de `dir` : refs/nelcode/checkpoints/<empreinte du chemin de `dir` dans le dépôt>/.
fn refs_of(dir: &Path) -> Result<String> {
    let prefix = git(dir, None, &["rev-parse", "--show-prefix"])?.trim().to_lowercase();
    // FNV-1a : une empreinte stable, sans dépendance.
    let h = prefix.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    Ok(format!("refs/nelcode/checkpoints/{h:016x}/"))
}

/// Les fichiers non ignorés de `dir` absents de l'index `index` (vide : tous), sans les fichiers protégés.
fn unprotected_others(dir: &Path, index: &Path) -> Result<Vec<String>> {
    let extra = extra_protected();
    let out = git(dir, Some(index), &["ls-files", "-z", "--others", "--exclude-standard"])?;
    Ok(out.split('\0').filter(|r| !r.is_empty() && !r.ends_with('/') && protected_by(r, &extra).is_none()).map(str::to_string).collect())
}

/// Crée un point du dossier `dir` et rend son id ; None si `dir` n'est pas dans un dépôt git (pas de point).
pub fn create(dir: &str) -> Result<Option<String>> {
    let dir = Path::new(dir);
    match git(dir, None, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(s) if s.trim() == "true" => {}
        Err(e) if e.starts_with("git introuvable") => return Err(e),
        _ => return Ok(None),
    }
    // L'heure en tête de l'id : l'ordre des noms est celui de la création.
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    let id = format!("c{ms:013x}{}", &random_hex()[..4]);
    // Un index vide : chaque fichier du dossier est relu tel quel (pas les infos de l'index de l'utilisateur, faites
    // peut-être avec une autre conversion des fins de ligne). Les fichiers protégés ne sont jamais ajoutés, donc
    // jamais copiés dans les objets de git : la liste est filtrée avant `git add`.
    // ponytail: tout est rehaché à chaque demande ; partir d'une copie de l'index si c'est trop lent sur un gros dépôt.
    let index = TempFile::new();
    let files = unprotected_others(dir, &index.0)?;
    if !files.is_empty() {
        let list = TempFile::new();
        fs::write(&list.0, files.join("\0")).map_err(|e| e.to_string())?;
        let from = format!("--pathspec-from-file={}", list.0.display());
        git(dir, Some(&index.0), &["--literal-pathspecs", "add", &from, "--pathspec-file-nul"])?;
    }
    let tree = git(dir, Some(&index.0), &["write-tree"])?;
    let head = git(dir, None, &["rev-parse", "--verify", "-q", "HEAD"]).unwrap_or_default();
    let mut args = vec!["commit-tree", "--no-gpg-sign", tree.trim(), "-m", "Nel Code : point de restauration avant une demande"];
    if !head.trim().is_empty() {
        args.extend(["-p", head.trim()]);
    }
    let commit = git(dir, None, &args)?;
    let refs = refs_of(dir)?;
    git(dir, None, &["update-ref", &format!("{refs}{id}"), commit.trim()])?;
    // Seulement les KEEP derniers points de ce dossier (for-each-ref les rend triés par nom, donc par date).
    let all = git(dir, None, &["for-each-ref", "--format=%(refname)", &refs])?;
    let all: Vec<&str> = all.lines().filter(|l| !l.is_empty()).collect();
    for old in &all[..all.len().saturating_sub(KEEP)] {
        if let Err(e) = git(dir, None, &["update-ref", "-d", old]) {
            crate::log::error(&format!("point de restauration ancien non supprimé : {e}"));
        }
    }
    Ok(Some(id))
}

/// Remet le dossier `dir` dans l'état du point `id` : les fichiers du point reprennent leur contenu, ceux créés depuis
/// (ni ignorés, ni protégés) sont supprimés. Les fichiers ignorés et protégés, l'index et HEAD de l'utilisateur ne
/// changent pas.
pub fn restore(dir: &str, id: &str) -> Result<()> {
    valid_id(id)?;
    let dir = Path::new(dir);
    let missing = || "ce point de restauration n'existe plus dans le dépôt (trop ancien : seuls les 20 derniers sont gardés, ou dossier de travail déplacé)".to_string();
    let refs = refs_of(dir).map_err(|_| missing())?;
    let tree = git(dir, None, &["rev-parse", "--verify", "-q", &format!("{refs}{id}^{{tree}}")]).map_err(|_| missing())?;
    let index = TempFile::new();
    git(dir, Some(&index.0), &["read-tree", tree.trim()])?;
    // Lancé dans `dir`, checkout-index -a n'écrit que les fichiers sous `dir`.
    git(dir, Some(&index.0), &["checkout-index", "-a", "-f"])?;
    // Ce qui n'est pas dans le point (ni ignoré, ni protégé) : créé depuis. Seulement des fichiers, un par un.
    for rel in unprotected_others(dir, &index.0)? {
        if let Err(e) = fs::remove_file(dir.join(&rel)) {
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
    fn fichiers_proteges_et_limite() {
        let d = tmp();
        let g = |args: &[&str]| git(&d, None, args).unwrap();
        g(&["init", "-q"]);
        // Protégés, pas ignorés par .gitignore : jamais dans un point (ni dans les objets de git), jamais touchés.
        fs::write(d.join(".env"), "SECRET=1\n").unwrap();
        fs::create_dir_all(d.join("cles")).unwrap();
        fs::write(d.join("cles/server.pem"), "PEM").unwrap();
        fs::write(d.join("a.txt"), "a\n").unwrap();
        let dir = d.to_str().unwrap();
        let id = create(dir).unwrap().unwrap();
        let refs = refs_of(&d).unwrap();
        assert_eq!(g(&["ls-tree", "-r", "--name-only", &format!("{refs}{id}")]), "a.txt\n");
        assert!(g(&["count-objects", "-v"]).lines().any(|l| l == "count: 3"), "a.txt, l'arbre et le commit : rien d'autre");
        fs::write(d.join(".env"), "SECRET=2\n").unwrap();
        fs::write(d.join("cles/neuve.key"), "KEY").unwrap();
        fs::write(d.join("a.txt"), "agent\n").unwrap();
        restore(dir, &id).unwrap();
        assert_eq!((read(&d, "a.txt"), read(&d, ".env"), read(&d, "cles/server.pem")), ("a\n".into(), "SECRET=2\n".into(), "PEM".into()));
        assert!(d.join("cles/neuve.key").exists(), "un fichier protégé créé depuis n'est pas supprimé");
        // Seulement les 20 derniers points du dossier ; un sous-dossier a les siens.
        let ids: Vec<String> = (0..21).map(|_| create(dir).unwrap().unwrap()).collect();
        assert_eq!(g(&["for-each-ref", "--format=%(refname)", &refs]).lines().count(), KEEP);
        assert!(restore(dir, &id).unwrap_err().contains("n'existe plus"), "le plus ancien est supprimé");
        assert!(restore(dir, &ids[0]).unwrap_err().contains("n'existe plus"));
        restore(dir, &ids[20]).unwrap();
        fs::create_dir_all(d.join("sous")).unwrap();
        create(d.join("sous").to_str().unwrap()).unwrap().unwrap();
        assert_eq!(g(&["for-each-ref", "--format=%(refname)", &refs]).lines().count(), KEEP, "les points du sous-dossier sont à part");
        assert_eq!(g(&["for-each-ref", "--format=%(refname)", "refs/nelcode/"]).lines().count(), KEEP + 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn dossier_sans_git() {
        let d = tmp();
        assert_eq!(create(d.to_str().unwrap()), Ok(None));
        let _ = fs::remove_dir_all(&d);
    }
}
