# Changelog

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), et le projet [Semantic Versioning](https://semver.org/lang/fr/).

## [0.9.0] - 2026-11-17

### Ajouté

- **Fichiers protégés** (mode Agent et fichiers `@`) : `.env`, `.env.*`, `.git/`, `*.pem`, `*.key`, `*.pfx`, `id_rsa`,
  `*.kdbx`, `appsettings.*.json`, `secrets.json`, et les motifs de **Réglages → Fichiers protégés** (un par ligne) ne
  sont lus qu'après une confirmation explicite, à chaque fois (« Accepter tout » des écritures ne compte pas pour eux) ;
  `search` ne les parcourt jamais sans confirmation, et dit au modèle combien il en a laissé de côté ; la barre de
  contexte ne les lit pas.
- Tests : chaque motif par défaut et des réglages (tests unitaires), confirmation refusée ou acceptée, « Accepter tout »
  sans effet, recherche refusée puis acceptée, Stop, et les `@` (e2e).
- Mode Agent, **NELCODE.md** : à la racine du dossier de travail, son contenu (20 000 premiers octets) est ajouté au
  message système de chaque demande ; une icône de l'en-tête montre qu'il est pris en compte, et le même bouton crée
  un NELCODE.md modèle (jamais par-dessus un fichier existant).
- Mode Agent, **plan** : outil `update_plan` (tâches à faire, en cours, faites), panneau Plan repliable à droite de la
  conversation, mis à jour en direct et gardé avec la conversation ; le message système encourage un plan pour les
  demandes en plusieurs étapes.
- Mode Agent, **commandes** : outil `run_command` (programme et arguments), lancé sans shell (cmd, PowerShell, bash,
  `.bat`/`.cmd`/`.ps1`, `|`, `>`, `&&` refusés), dans le dossier de travail, sortie limitée et affichée en direct.
  Lancer / Refuser à chaque commande, sauf la liste « Commandes autorisées sans confirmation » des réglages (vide par
  défaut) ; « Accepter tout » ne vaut pas pour elles. Durée maximale réglable (2 min par défaut) ; le délai et Stop
  tuent la commande et tous ses processus enfants (Job Object). Les variables d'environnement contenant KEY, TOKEN ou
  SECRET ne sont pas transmises. Le journal ne note que le nom du programme.
- Tests unitaires (NELCODE.md et sa limite, plans, validation sans shell, liste autorisée, variables cachées, sortie
  limitée, délai et Stop qui tuent les enfants) et de l'interface pour chacun de ces points.
- **Fournisseur Claude** : bouton « Ajouter Claude (Anthropic) » (`https://api.anthropic.com/v1/`, clé dans le
  Gestionnaire d'identification ; liste des modèles par l'API native d'Anthropic, `max_tokens` par défaut). Option par
  fournisseur « Ne pas envoyer temperature/top_p », cochée pour Claude. Le mode Agent marche avec.
- **Claude Agent** : type de conversation mené par l'outil en ligne de commande `claude` d'Anthropic installé sur le PC
  (trouvé dans le PATH, sinon un message avec le lien d'installation), dans le dossier de travail, en
  `-p --output-format stream-json --verbose --include-partial-messages`, puis `--resume`. Texte au fil de l'eau, chaque
  outil en étape dépliable (diff, sortie de commande), plan, coût et durée. Clé API seulement (`ANTHROPIC_API_KEY`
  depuis le Gestionnaire d'identification, pas de connexion à un compte) ; mode de permission (rien d'automatique par
  défaut, ou acceptEdits) et outils autorisés (`--allowedTools`) dans les réglages ; Stop envoie Ctrl+C (SIGINT) puis
  attend la fin propre. Tests avec un faux exécutable qui rejoue des flux enregistrés.
- Claude Agent, **sous-agents** : les étapes et les messages d'un sous-agent (`parent_tool_use_id`) s'affichent dans
  l'étape « Sous-agent : … » qui l'a lancé, avec leur nombre, sur plusieurs niveaux, et le restent à la réouverture ;
  leur texte ne va jamais dans la réponse, et leur plan ne remplace pas celui de l'agent principal.
- Mode Agent, **points de restauration git** : avant chaque demande, si le dossier de travail est dans un dépôt git,
  son état est gardé dans un commit à part (`refs/nelcode/checkpoints/`), sans toucher à l'index, à HEAD, aux branches
  ni au stash. Les fichiers protégés (`.env`, clés…) n'y entrent jamais, même hors de `.gitignore`. Seuls les 20
  derniers points de chaque dossier sont gardés. **Revenir à avant cette demande** remet tous les fichiers du dossier
  dans cet état (les fichiers créés depuis sont supprimés, ceux ignorés par `.gitignore` et les fichiers protégés ne
  sont pas touchés) ; la conversation reste.
- Claude Agent, **choix du modèle** (`--model`) dans Réglages → Claude Agent : alias ou id complet, vide pour celui de
  l'outil (la variable `ANTHROPIC_MODEL` du PC n'est pas transmise).

- **Interface** :
  - **projets** : sélecteur des projets récents en haut de la barre latérale, conversations du projet affiché, ou toutes
    regroupées par projet ; une nouvelle conversation se range dans le projet affiché ;
  - **panneau Fichiers** repliable à droite (Ctrl+Maj+E) : arborescence du dossier de travail, badges A / M sur les
    fichiers créés ou modifiés par l'agent, aperçu colorié (fichier protégé sur confirmation), diff de la session ;
  - **assistant du premier lancement** en 3 étapes (bienvenue et couleur, modèle, dossier de travail) ;
  - **notifications discrètes** (en bas à droite, quatre au plus, croix, durée selon le genre), **aide des raccourcis**
    avec « ? », **taille du texte** réglable (80 à 150 %, Ctrl+= / Ctrl+- / Ctrl+0) ;
  - tests de l'interface : `e2e/ux.test.mjs`.

### Modifié

- `app.js` (1870 lignes) est découpé en modules ES (`nel-desktop/ui/js/` : utilitaires, état, conversation, agent,
  réglages, catalogue, fournisseurs, palette, et les nouveaux projets, fichiers, premier lancement), sans changer le
  comportement : tous les tests de l'interface passent toujours.

### Corrigé

- Claude Agent : un message de sous-agent ne double plus le texte de l'agent principal ni ne le coupe en étape ; les
  variables `ANTHROPIC_*` et `CLAUDE_CODE_USE_*` du PC ne sont plus transmises (la clé ne part que vers Anthropic) ; un
  dossier voisin au nom plus long n'est plus pris pour le dossier de travail ; la raison d'une modification refusée
  s'affiche avec son diff.
- Les tests de l'interface n'utilisent plus les vraies clés du Gestionnaire d'identification (espace à part pour les
  tests), et l'effacement d'un dossier de test bloqué n'attend plus 4 minutes.

### Sécurité

- Les noms réservés de Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…`COM9`, `LPT1`…`LPT9`, avec ou sans extension) et
  les noms qui finissent par un point ou une espace sont refusés (lecture, recherche, écriture, `@`). Une espace finale
  n'est plus effacée silencieusement avant la vérification.

## [0.8.0] - 2026-11-16

### Ajouté

- **Nel Code** : mode **Agent**, pour les modèles distants qui gèrent les outils (tool calling OpenAI : llama.cpp
  `--jinja`, Ollama avec Qwen3…) ; les `.nelmodel` et les GGUF locaux n'y ont pas accès :
  - outils `list_files`, `read_file`, `search`, `write_file`, `edit_file`, limités au dossier de travail (chemins
    normalisés ; `..`, chemins absolus, liens et jonctions qui sortent du dossier, fichiers de plus de 100 Ko refusés) ;
    pas d'exécution de commandes ;
  - la boucle outil → résultat → réponse, avec un nombre maximal de tours réglable (10 par défaut) ;
  - suivi en direct : bloc Réflexion, puis une ligne par étape, dépliable ; Stop à tout moment ;
  - chaque écriture montre un diff (vert / rouge) et attend Accepter, Refuser ou « Accepter tout pour cette demande » ;
    sauvegarde de chaque écriture, Annuler par étape et « Annuler toute la demande » (refusé si le fichier a changé) ;
  - le contenu d'un fichier n'est jamais une instruction pour Nel Code : seul le modèle demande un outil, seul
    l'utilisateur valide une écriture ;
  - tests : `e2e/agent.test.mjs` (faux modèle à outils) et tests unitaires (bac à sable avec jonction, diff, écritures).

### Modifié

- La lecture des fichiers `@` passe par le même bac à sable que l'agent.
- Les tests de l'interface se lancent un fichier après l'autre (`--test-concurrency=1`).

### Corrigé

- Les suggestions (`/`, `@`) ne se ferment plus quand la saisie retrouve le focus aussitôt après l'avoir perdu.

## [0.7.0] - 2026-11-16

### Ajouté

- **Nel Code** : modèles distants, par des serveurs compatibles avec l'API OpenAI (llama.cpp, Ollama, LM Studio…) :
  - section **Fournisseurs** des réglages : nom, adresse, clé facultative ; **Tester** appelle `/v1/models` et liste
    les modèles ; ils apparaissent dans la liste des modèles avec le badge « réseau » et le nom du fournisseur ;
  - **Importer depuis Qwen Code** (`~/.qwen/settings.json`, `modelProviders.openai`) : fournisseurs, réglages de chaque
    modèle (température, top_p, max_tokens, taille du contexte) et clé (`envKey`) ;
  - appels faits par la partie Rust (CSP inchangée), en streaming SSE, délai maximal (2 min sans rien recevoir), Stop
    qui ferme la connexion, messages clairs (serveur injoignable, clé refusée, modèle arrêté ou introuvable) ;
  - **Réflexion** (`reasoning_content`, `reasoning`, `<think>…</think>`) dans un bloc repliable au-dessus de la
    réponse, avec sa durée, jamais renvoyée au modèle ;
  - clés dans le Gestionnaire d'identification de Windows, jamais dans `settings.json` ; avertissement pour une adresse
    `http://` vers une autre machine ;
  - tests : `e2e/remote.test.mjs` (faux serveur local) et tests unitaires (balises `<think>` coupées, adresses,
    contexte, Gestionnaire d'identification, `.env`).

## [0.6.0] - 2026-11-16

### Ajouté

- **Nel Code** : serveur local compatible avec l'API OpenAI, **désactivé par défaut** (Réglages → Serveur local) :
  - `GET /v1/models` et `POST /v1/chat/completions`, avec et sans streaming (SSE) ; erreurs au format OpenAI ;
  - n'écoute que sur `127.0.0.1`, port réglable (8765 par défaut) ; clé d'accès aléatoire générée, affichée et copiable
    dans les réglages, renouvelable (`Authorization: Bearer`) ;
  - indicateur dans la barre d'état (`API :port`, `API · répond…`) ; une réponse à la fois, partagée avec l'interface ;
  - le journal note le démarrage, l'arrêt et chaque réponse (modèle, taille du prompt), jamais le texte des messages ;
  - README : brancher Continue (VS Code) ;
  - tests : `e2e/server.test.mjs`, et les tests unitaires de la conversion des messages et des clés.

## [0.5.0] - 2026-11-16

### Ajouté

- **nel-engine** :
  - `ChatModel`, l'interface commune des modèles (contexte, prompt de chat, décodage, génération), et `generate_loop`, la
    même génération pour tous (température, top-k, top-p, pénalité de répétition, arrêt au token spécial, transparence,
    contexte plein). Les `.nelmodel` (`NelModel`) donnent exactement les mêmes résultats qu'avant ;
  - modèles **GGUF** (`gguf::GgufModel`, Candle quantifié) : architectures Qwen2 et Llama, tokenizer Hugging Face
    reconstruit depuis le fichier (ou `tokenizer.json` à côté), format de chat du modèle (ChatML, Llama 3), prompt passé
    par morceaux, CPU ou GPU. Tests contre Qwen2.5-Coder-0.5B et son `tokenizer.json` officiel.
- **Nel Code** :
  - **catalogue de modèles** : Qwen2.5-Coder-0.5B-Instruct et 1.5B-Instruct (GGUF Q4_K_M, Apache 2.0) ; taille et
    licence affichées, licence acceptée avant le téléchargement ; progression, Annuler, espace disque et SHA-256 (écrit
    dans le code) vérifiés, comme le pack GPU ;
  - import d'un **`.gguf`** par glisser-déposer, ＋ ou `/import` : architecture, paramètres, contexte, format de chat,
    licence déclarée affichés avant l'import ;
  - réglage **« Contexte des modèles GGUF »** (8 192 tokens par défaut) ; la barre de contexte utilise la vraie taille du
    modèle et la place gardée pour la réponse ;
  - **blocs de code** coloriés dans les messages (C#, Rust, Python, JavaScript, HTML, CSS, JSON), avec un bouton Copier ;
    rendus sans `innerHTML`, CSP inchangée ;
  - **`@` fichiers du dossier de travail** : suggestions dans la saisie, fichier ajouté au message dans un bloc de code
    (100 Ko au plus, texte, dans le dossier seulement), avertissement si le message dépasse le contexte. En lecture
    seule : aucun fichier n'est jamais modifié ;
  - tests de l'interface : catalogue, réponse d'un modèle GGUF, contexte réglable, import d'un `.gguf`
    (`e2e/gguf.test.mjs`), blocs de code et fichiers `@` (`e2e/nelcode.test.mjs`).

### Modifié

- Un modèle GGUF écrit jusqu'à 1024 tokens par réponse (le réglage « Longueur max », 16 à 128, reste celui des `.nelmodel`).
- Le texte de chaque token suit le texte décodé jusque-là : un caractère sur plusieurs tokens d'octets n'est envoyé
  qu'une fois complet.
- Le workflow de release télécharge Qwen2.5-Coder-0.5B (empreinte vérifiée) pour les tests GGUF.

## [0.4.1] - 2026-11-12

Première publication de la 0.4 : la 0.4.0 n'a pas été publiée (sa compilation échouait sur GitHub Actions).

### Ajouté

- **nel-engine** :
  - pénalité de répétition (`Sampling::repetition_penalty`, défaut 1,15 ; 1,0 = désactivée, résultat identique à avant) sur
    les 64 derniers tokens, avant température / top-k / top-p ; le mode transparence montre les probabilités après la
    pénalité. `nel-chat --repetition-penalty` ;
  - GPU NVIDIA derrière la feature Cargo `cuda` (Candle, CUDA 12) : `gpu::cuda_device`, `NelModel::load_on`. Les tests
    de `reference.json` passent aussi sur GPU (à 1e-3).
- **Nel Code** :
  - réglage « Pénalité de répétition » (curseur de 1 à 2, avec une explication) ;
  - journal dans `%APPDATA%\NelCode\logs` (un fichier par jour, 7 jours gardés) : démarrage, modèles et durée de
    chargement, erreurs, mises à jour, GPU. Jamais le texte des conversations ;
  - « Copier un rapport de bug » (Réglages, palette Ctrl+K) : version, Windows, modèle actif, GPU, 50 dernières lignes
    du journal ;
  - « Tester la vitesse » (Réglages, palette) : chargement, prompt et tokens/s sur 200 tokens, sur CPU puis sur GPU ;
    résultats gardés par modèle (`benchmarks.json`) et affichés dans un tableau ;
  - section Calcul des Réglages : Automatique / CPU / GPU, carte et pilote détectés (avec un lien si le pilote est trop
    ancien), « Installer le pack GPU » (progression, annulation, espace disque et empreinte SHA-256 vérifiés, rien
    n'est laissé à moitié), « Retirer le pack GPU ». Le périphérique actif est dans la barre d'état ;
  - pack GPU (release `gpu-pack-cuda12`, 593 Mo) : les DLL CUDA redistribuables de NVIDIA, installées à la demande dans
    `%APPDATA%\NelCode\gpu` et chargées uniquement depuis ce dossier, par chemin complet. `make-gpu-pack.ps1` le
    construit à partir du CUDA Toolkit ;
  - tests de l'interface automatiques (`e2e/`, Node) : démarrage, import, réponse, Stop, Régénérer, Modifier, modèles,
    recherche, renommer, supprimer, réglages, transparence, comparaison, test de vitesse, rapport de bug ; et le pack
    GPU de bout en bout quand une carte NVIDIA est là.

### Modifié

- L'installateur est compilé avec CUDA (noyaux de Candle) mais ne contient aucune bibliothèque CUDA : sans carte NVIDIA
  ou sans pack, Nel Code utilise le CPU, sans erreur. 10,9 Mo au lieu de 6,0 Mo.
- Le workflow de release lance les tests de l'interface après `cargo test`, installe le CUDA Toolkit 12.9 et vérifie
  qu'aucune DLL CUDA n'est nécessaire au démarrage.

## [0.3.0] - 2026-11-12

### Ajouté

- **Nel Code** : mises à jour automatiques (tauri-plugin-updater, signées) :
  - vérification discrète au démarrage, au plus une fois par jour (désactivable dans les Réglages) ;
  - bandeau « Nel Code X.Y.Z est disponible » avec les notes de version, « Installer » ou « Plus tard » ;
  - barre de progression du téléchargement, installation en mode passif puis redémarrage. Jamais pendant une réponse :
    l'installation attend qu'elle soit finie ;
  - « Rechercher des mises à jour » dans la palette Ctrl+K et dans les Réglages ;
  - erreurs (pas de connexion, signature invalide) en simple notification, sans bloquer l'application.

### Modifié

- Les releases contiennent `latest.json` et la signature de l'installateur ; leur texte commence par la section du CHANGELOG.

## [0.2.0] - 2026-11-12

### Ajouté

- **nel-engine** : `generate_with_choices` (mode transparence) rend, pour chaque token écrit, les 5 tokens les plus
  probables avec leur probabilité (après la température, avant top-k/top-p). `generate` ne change pas.
- **Nel Code** :
  - mode transparence (bouton « Transparence ») : au survol d'un mot, ses 5 choix avec une barre par probabilité ; fond vert (sûr,
    ≥ 60 %) ou rouge (hésitant, < 30 %). Les probabilités sont gardées avec le message ;
  - mode comparaison (Ctrl+Maj+N) : chaque message part à deux modèles, réponses côte à côte, votes « A / B / égalité »
    dans `arena.json`, et un classement (score Elo, pourcentage de victoires) ;
  - choix de la couleur d'accent dans les Réglages : rouge (par défaut) ou terre cuite (l'ancienne) ;
  - thème clair, suivi de `"theme": "light"` dans settings.json (comme Nel Code C#).

### Modifié

- **Nel Code** :
  - couleur d'accent rouge (`#e5484d`), icônes de l'application comprises ; toutes les couleurs sont des variables CSS,
    et le texte a un contraste d'au moins 4,5:1 (les gris discrets sont un peu plus clairs) ;
  - icônes SVG (Lucide, licence ISC) à la place des emojis et symboles ;
  - les erreurs ont leur icône (cercle, point d'exclamation) et un fond à elles, distincts de l'accent.

## [0.1.0] - 2026-11-11

Première version publique.

### Ajouté

- **nel-engine** : bibliothèque Rust (Candle, CPU) qui charge les `.nelmodel` version 2 : tokenizer BPE identique à MiniChat,
  MiniGpt Modern (RMSNorm, RoPE, attention causale, SwiGLU, weight tying), cache KV, tirage température / top-k / top-p.
  Tests comparés à `reference.json` (ids identiques, probabilités à 1e-4, 30 tokens gloutons). Exécutable `nel-chat`.
- **Nel Code** (application Tauri v2 pour Windows) :
  - conversations : recherche, renommer, exporter (.md, .txt), supprimer, dossier de travail par conversation ;
  - réponse affichée au fil des tokens, Stop et Échap, Copier, Régénérer (versions ‹ 1/2 ›), Modifier ;
  - commandes `/` avec suggestions, palette Ctrl+K, réglages, barre de contexte ;
  - import d'un `.nelmodel` par glisser-déposer, avec vérification du format et extraction sûre ;
  - lit les conversations, réglages et modèles de Nel Code C# (`%APPDATA%\NelCode`), y compris les poids `weights.dat`.
- Installateur Windows (NSIS), qui installe WebView2 s'il manque.
- Workflow GitHub Actions : un tag `v*` lance les tests et crée une release brouillon avec l'installateur.

[0.2.0]: https://github.com/nelsogi/nelcode-rs/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nelsogi/nelcode-rs/releases/tag/v0.1.0
