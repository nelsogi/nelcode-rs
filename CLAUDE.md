# Nel Code (nelcode-rs)

Application de bureau Windows, Linux et macOS expérimentaux (Tauri, Rust + interface HTML/JS sans framework, en français et en anglais) pour discuter avec des modèles
locaux (`.nelmodel`, GGUF) ou distants (API OpenAI), avec un mode Agent. Projet solo, en français (code, commentaires,
CHANGELOG, README, messages de commit).

## Architecture

Workspace Cargo : `nel-engine` (bibliothèque) + `nel-desktop` (application). Tests d'interface dans `e2e/` (Node).

### nel-engine/src
- `lib.rs` : `ChatModel` (interface commune), génération (`generate_loop`), chargement d'un `.nelmodel` (NELMODEL-FORMAT.md)
- `model.rs` : réseau MiniGpt (RMSNorm, RoPE, attention, SwiGLU), cache KV
- `tokenizer.rs` : tokenizer BPE de MiniChat
- `gguf.rs` : modèles GGUF quantifiés (Qwen2, Llama) avec Candle, tokenizer reconstruit des métadonnées
- `gpu.rs` : GPU NVIDIA (feature `cuda`), chargement des DLL par chemin complet
- `bin/nel-chat.rs` : chat en ligne de commande ; `tests/` : `reference.rs` (sorties de référence), `gguf.rs`

### nel-desktop/src (Rust)
- `main.rs` : fenêtre Tauri, commandes exposées à l'interface, génération, mises à jour
- `store.rs` : fichiers de données `%APPDATA%\NelCode\{models,sessions,settings.json}` (partagés avec la version C#)
- `remote.rs` : fournisseurs distants compatibles OpenAI (SSE) ; module `creds` : clés dans le trousseau (crate keyring :
  Gestionnaire d'identification, cible inchangée sous Windows ; trousseau macOS ; Secret Service)
- `server.rs` : serveur local compatible OpenAI (127.0.0.1 seulement, clé d'accès obligatoire, désactivé par défaut)
- `agent.rs` : mode Agent (outils lecture/recherche/écriture dans un `Sandbox`, fichiers protégés, NELCODE.md, plan,
  explorateurs `spawn_explorer` en lecture seule)
- `worker.rs` : travailleurs `spawn_worker` / `revise_worker` du mode Agent (portée exclusive, brouillon en mémoire,
  revue groupée, Stop qui jette les brouillons)
- `mcp.rs` : client MCP (stdio dans un Job Object, Streamable HTTP ; mcp.json global et .nelcode/mcp.json avec accord
  par empreinte ; secrets dans le Gestionnaire d'identification ; mcp-state.json : accords, « toujours », outils)
- `command.rs` : outil `run_command` (sans shell, délai, variables secrètes retirées)
- `process.rs` : lancement sans fenêtre dans un Job Object (Windows) ou un groupe de processus (Linux, macOS), kill,
  interruption (Ctrl+C / SIGINT)
- `os.rs` : ce qui dépend du système (dossier de données, personnel, PATH, ouvrir, disque, heure, version), règles
  testables pour les trois systèmes
- `checkpoint.rs` : points de restauration git de l'Agent (refs/nelcode/checkpoints, 20 par dossier)
- `claude_agent.rs` : conversation « Claude Agent » : lance l'exécutable `claude` installé et affiche son flux stream-json
- `catalog.rs` : catalogue de modèles Hugging Face (révision fixe, SHA-256 vérifié)
- `gpu.rs`, `delayload.rs` : pack GPU téléchargé à la demande, chargement différé des DLL CUDA (Windows seulement)
- `log.rs` : journal quotidien (7 jours), jamais le texte des conversations
- `usage.rs` : suivi `usage.jsonl` (tokens, coût estimé, table de prix, budget, regroupement à 90 jours), jamais le texte
- `i18n.rs` : catalogues `ui/i18n/{fr,en}.json` inclus (commande `i18n_catalog`), messages codés `t!("clé", p = v)`,
  rendu anglais (journal) et français (ce qui part au modèle : `i18n::french`)
- `window.rs` : taille, position et état agrandi de la fenêtre (clé `windowState`), contrôle contre les écrans actuels
- `images.rs` : images des messages (réduites, réencodées sans métadonnées, fichiers `sessions\{id}\img-*`, content
  OpenAI en data URL, estimation des tokens, détection des modèles qui voient les images)

### nel-desktop/ui (modules ES, `js/main.js` charge le reste)
`i18n.js` (`t('clé', params)`, pluriels, `num`/`date`, `tr()` des messages codés) · `util.js` (appels Rust, DOM, fenêtres) · `state.js` (état partagé `S`, `UI`) · `conversation.js` (conversations,
génération, saisie) · `markdown.js` (rendu Markdown des réponses : jetons → DOM, liens) · `agent.js` (mode Agent, étapes, plan, confirmations) · `files.js` (panneau Fichiers, diff) ·
`projects.js` · `providers.js` (modèles distants) · `catalog.js` · `settings-page.js` (page Réglages : catégories, recherche, enregistrement automatique, export) · `settings.js` · `mcp.js` (Réglages → MCP, accords, fenêtre de la puce) · `usage.js` (page Suivi, budget, prix) · `images.js` (images des messages) · `onboarding.js` · `palette.js`
(Ctrl+K). Aussi `index.html`, `style.css`, `icons.js`, `vendor/` (markdown-it, copié tel quel).

### e2e/
`harness.mjs` lance l'exe debug avec dossiers de données temporaires et le pilote par le port de débogage WebView2.
Fichiers : `nelcode`, `ux`, `settings` (page Réglages), `i18n` (catalogues, clés, textes en dur, deux langues), `window` (état de la fenêtre), `agent`, `explorer`, `workers`, `markdown`, `remote`, `server`, `usage`, `images`, `context`, `mcp` (faux serveur `fake-mcp/server.mjs`), `claude` (faux `claude` : `fake-claude/main.rs` + `*.jsonl`),
`gguf` et `gpu` (ignorés sans modèle / sans carte NVIDIA).

## Tests

**Utiliser `.\scripts\test.ps1`** (cargo test --workspace -q, puis les e2e) : il n'affiche qu'un résumé (réussis,
échecs, ignorés) et le détail des seuls tests qui échouent. Ne pas lancer `cargo test` ou `node --test` à la main
pour tout vérifier : la sortie complète coûte cher en tokens.
- `.\scripts\test.ps1 -SansE2e` : cargo seulement ; `-Fichier agent` : un seul `e2e/agent.test.mjs`
- Un seul test Rust : `cargo test -p nel-desktop -q <nom>` ; `E2E_VERBOSE=1` affiche la sortie de l'application
- Les e2e se lancent l'un après l'autre (une seule fenêtre de Nel Code à la fois) et utilisent `target/debug/nel-desktop.exe`
- Modèles de test dans `test-models/` (hors dépôt, voir README « Tests ») ; variables `NELMODEL`, `GGUF`

## Règles du projet

- **Sécurité de l'agent** : tout passe par `Sandbox` (chemins normalisés, `..`, absolus et liens refusés) ; fichiers
  protégés (`.env`, `*.pem`, `.git/`… + motifs des réglages) lus ou écrits seulement après confirmation à chaque fois,
  « Accepter tout » n'y change rien ; commandes sans shell, confirmées sauf liste autorisée (programmes par leur nom
  seulement) ; git des points de restauration sans fsmonitor, hooks ni filtres du dépôt ; `claude` sans les réglages du
  projet sauf choix explicite ; une seule liste de variables secrètes (`command::hidden_var`) ; redirections des
  fournisseurs et de MCP seulement vers la même origine ; clés (serveur local compris) jamais dans `settings.json`,
  jamais dans le journal ni dans les tests (clés de test à part) ; l'interface n'appelle jamais le réseau (CSP inchangée).
  Ne jamais affaiblir une de ces protections sans demande explicite.
- **Traductions** : aucun texte de l'interface en dur. JS : `t('clé', { params })` (pluriel : objet `{ one, other }` et
  paramètre `n`), clé dans `fr.json` ET `en.json` ; HTML : `data-i18n*` ; Rust : `t!("rs.…", p = v)` pour ce que voit
  l'utilisateur, `i18n::french()` pour ce qui part au modèle, journal en anglais (texte anglais ou `i18n::english`).
  Ce qui part au modèle (prompts, descriptions d'outils, résultats) n'est pas traduit (`// i18n-ignore` côté JS).
  `e2e/i18n.test.mjs` vérifie tout cela.
- **Jamais le nom « Claude Code » dans l'interface** (textes, boutons, messages). Écrire « Claude Agent » ou « claude ».
- **Pas de connexion Claude.ai** : on utilise l'exécutable `claude` déjà connecté sur le PC, ou une clé API Anthropic.
- **CHANGELOG à jour** : chaque nouveauté ou correction va dans `CHANGELOG.md` ; README mis à jour si l'usage change.
- **Un test par nouveauté** : test unitaire Rust et/ou e2e. Pas de commit avec un test qui échoue.
- **Version actuelle 1.2.0** : les nouveautés vont dans la section [Non publié] du CHANGELOG. La version (Cargo.toml,
  CLAUDE.md) ne change qu'au moment d'une publication, où [Non publié] devient [X.Y.Z] avec la date. Ni tag ni release
  tant que demandé.
- **Git** : commiter directement sur `master` (pas de branche) ; ne pas pousser sans demande. Messages au format
  `non publié : sujet` (`X.Y.Z : sujet` pour le commit d'une publication).

## Compact instructions

Au compactage, garder : la liste des fichiers modifiés (chemins), les décisions prises et leur raison, les tests qui
échouent (nom + message d'erreur), la tâche en cours et la prochaine étape. Oublier : sorties complètes de cargo/node,
contenus de fichiers déjà relus, tentatives abandonnées.
