# Changelog

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), et le projet [Semantic Versioning](https://semver.org/lang/fr/).

## [1.0.0] - 2026-11-20

Première version stable. La 0.9.0 n'a jamais été publiée : tout ce qui a changé depuis la 0.8.0 est détaillé ici.

### En bref : Nel Code depuis la 0.1.0

- **Modèles locaux, sans connexion** : les `.nelmodel` de MiniChat (0.1.0) et les modèles ouverts **GGUF** Qwen2 et
  Llama (0.5.0), importés par glisser-déposer ou depuis un **catalogue** vérifié par SHA-256 ; **GPU NVIDIA** avec un
  pack téléchargé à la demande (0.4.1) ; pénalité de répétition, test de vitesse.
- **Conversations** : réponse au fil des tokens, Stop, Régénérer, Modifier, export, commandes `/`, palette Ctrl+K,
  **mode transparence** et **mode comparaison** avec classement (0.2.0), fichiers `@`, blocs de code coloriés, projets,
  commandes personnalisées, **images** dans les messages (réduites, sans métadonnées), **résumé automatique** du
  contexte et `/compact`.
- **Modèles distants** compatibles OpenAI (llama.cpp, Ollama, LM Studio…, 0.7.0) et **fournisseur Claude** ; clés dans
  le trousseau du système, jamais dans un fichier.
- **Serveur local** compatible OpenAI, désactivé par défaut, sur 127.0.0.1 et avec une clé d'accès (0.6.0).
- **Mode Agent** (0.8.0) : lecture, recherche, écriture avec diff et accord, annulation, **commandes** sans shell,
  **plan**, **NELCODE.md**, **fichiers protégés**, **points de restauration git**, **explorateurs** en lecture seule et
  **client MCP** (stdio et Streamable HTTP).
- **Claude Agent** : conversation menée par l'outil `claude` d'Anthropic installé sur le PC, avec une clé API.
- **Suivi** des tokens et du coût estimé, budget mensuel ; journal sans le texte des conversations.
- **Mises à jour automatiques** signées (0.3.0) ; **Windows**, et **Linux** et **macOS** en expérimental.

### Sécurité (relecture complète de la 1.0.0)

Toutes les protections ont été relues dans le code (bac à sable, explorateurs, MCP, Claude Agent, serveur local,
fournisseurs, images, points de restauration, mises à jour, imports). Corrigé :

- **Points de restauration git : plus aucun programme du dépôt lancé** (grave). git tourne dans le dossier de travail
  avec la configuration du dépôt : un `.git/config` piégé (dépôt reçu en archive, ou modifié par l'agent avec
  « Accepter tout ») faisait lancer un programme au début de chaque demande Agent, sans rien demander, par
  `core.fsmonitor`, les hooks `reference-transaction` et `post-index-change`, ou un filtre `clean`/`smudge`. Nel Code
  passe maintenant `core.fsmonitor=false`, un `core.hooksPath` vide et neutralise les filtres définis par le dépôt (ceux
  de l'utilisateur, comme git-lfs, restent). Test : un dépôt avec les quatre pièges, point puis restauration, rien ne
  tourne.
- **Claude Agent : les réglages du projet ne sont plus lus par défaut** (grave). En `-p`, `claude` ne demande pas si le
  dossier est de confiance : le `.claude/settings.json` d'un dépôt cloné pouvait lancer des commandes (hooks),
  autoriser Bash sans accord, activer ses serveurs MCP ou envoyer la clé API ailleurs (`env.ANTHROPIC_BASE_URL`).
  Nel Code lance `claude --setting-sources user` ; **Réglages → Claude Agent → Lire les réglages du projet** (désactivé
  par défaut) les remet, pour des projets de confiance. Tests unitaire et de l'interface.
- **Mode Agent : écrire un fichier protégé demande une confirmation à chaque fois** (moyen). `write_file` et
  `edit_file` ne tenaient pas compte des fichiers protégés : avec « Accepter tout », l'agent écrivait `.git/config`,
  `.git/hooks/…` ou `.env` sans question, et les erreurs d'`edit_file` (« passage introuvable », « N fois ») disaient au
  modèle ce que contenait `.env` sans qu'il soit lu. Maintenant : confirmation à chaque fois (bouton « Autoriser
  l'écriture », jamais « Accepter tout ») et, pour une modification, le fichier n'est lu qu'après l'accord. Tests de
  l'interface.
- **Commandes autorisées sans confirmation : seulement un programme donné par son nom** (moyen). « git status » dans la
  liste autorisait aussi « outils/git.exe status », un programme du projet. Un programme donné par un chemin demande
  maintenant toujours Lancer / Refuser. Test unitaire.
- **Fournisseurs et serveurs MCP distants : jamais de redirection vers un autre hôte** (faible). reqwest suivait une
  redirection ailleurs en ne retirant que `Authorization` : la clé `x-api-key` (fournisseur Claude) ou un en-tête secret
  de MCP partait vers l'autre hôte. Une redirection n'est plus suivie que vers la même origine (schéma, hôte, port) ;
  sinon la requête s'arrête avec un message clair. Test : un serveur qui redirige vers un autre hôte et un autre port,
  rien n'y arrive.
- **Une seule liste de variables secrètes** (faible), partagée par les commandes de l'agent, les serveurs MCP et Claude
  Agent : `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PWD`, `AUTH`, `CREDENTIAL`, `PRIVATE` n'importe où dans le
  nom, et les préfixes `ANTHROPIC_` et `OPENAI_`. Avant, une commande de l'agent recevait encore `DB_PASSWORD`. Test
  unitaire (la même réponse pour les trois).
- **Clé du serveur local dans le trousseau** (faible), plus dans `settings.json` ; celle d'une version d'avant y est
  déplacée au démarrage, puis retirée du fichier, et reste acceptée. Tests de l'interface.
- **Flux SSE de MCP borné** (faible) : des octets qui ne sont pas de l'UTF-8 valide restaient en attente sans limite
  (mémoire). Ils sont maintenant remplacés par « � », et le tampon ne dépasse jamais 8 Mo, quoi qu'envoie le serveur.
  Test unitaire.
- Les noms réservés de Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…`COM9`, `LPT1`…`LPT9`, avec ou sans extension) et
  les noms qui finissent par un point ou une espace sont refusés (lecture, recherche, écriture, `@`). Une espace finale
  n'est plus effacée silencieusement avant la vérification.
- Linux et macOS : dans les chemins de l'agent, `\` reste un séparateur (sinon `..\x` y serait un nom de fichier et non
  une remontée) ; les shells et lanceurs de ces systèmes (`sh`, `zsh`, `fish`, `open`, `xdg-open`, `osascript`…) et les
  scripts `.sh` sont refusés par `run_command` ; les fichiers protégés le restent quelle que soit la casse ; l'accord
  d'un serveur MCP de projet tient compte de la casse du dossier hors Windows (« Projet » et « projet » sont deux
  dossiers sous Linux).

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
  tuent la commande et tous ses processus enfants (Job Object). Les variables d'environnement secrètes (KEY, TOKEN,
  PASSWORD… : la liste de la section Sécurité) ne sont pas transmises. Le journal ne note que le nom du programme.
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
- **Résumé automatique du contexte** (modèles distants, fournisseur Claude, GGUF ; pas les `.nelmodel` ni Claude Agent) :
  au-delà de **80 %** du contexte du modèle (réglable : Réglages → Résumé automatique, 0 = jamais), les anciens échanges
  sont résumés par le modèle actif (décisions, fichiers modifiés, plan en cours, erreurs non résolues) ; les 4 derniers
  échanges restent tels quels. Seul ce qui est envoyé au modèle change : les messages d'origine restent dans la
  conversation sauvegardée, grisés, avec un bloc repliable « Résumé des échanges précédents » à leur place, et la barre de
  contexte indique « · résumé ». Un deuxième résumé reprend le premier ; modifier ou régénérer un message déjà résumé
  retire le résumé. **`/compact [consigne]`** résume à la main (`/compact garde surtout les tests`).
- Mode Agent et résumé : les anciens résultats d'outils (contenu des fichiers lus, sorties de commandes) ne sont repris
  dans le résumé qu'en une ligne (« fichier lu : src/Player.cs, 120 lignes ») ; dans une même demande, quand le contexte
  dépasse le seuil, les résultats d'outils d'avant le dernier tour sont remplacés de la même façon.
- **Commandes personnalisées** : les `.md` de `.nelcode/commands/` (dossier de travail, lus par le bac à sable) et de
  `%APPDATA%\NelCode\commands` (globales) deviennent des commandes `/nom` ; `description:` en front matter facultatif,
  `$ARGUMENTS` remplacé par le texte tapé après la commande. Suggestions `/` et palette Ctrl+K avec description et origine
  (projet ou globale) ; le projet remplace une globale du même nom, jamais une commande intégrée. Une commande n'est qu'un
  texte envoyé au modèle : elle ne lance rien et ne contourne aucune validation du mode Agent. **`/commands`** les liste
  et crée un modèle de fichier (jamais par-dessus un fichier existant).
- Tests : lecture du front matter, noms, priorité, création sans écraser, réduction des résultats d'outils (unitaires) ;
  résumé automatique, réglage, `/compact`, étapes de l'agent, exclusions, commandes personnalisées (`e2e/context.test.mjs`).

- **Interface** :
  - **projets** : sélecteur des projets récents en haut de la barre latérale, conversations du projet affiché, ou toutes
    regroupées par projet ; une nouvelle conversation se range dans le projet affiché ;
  - **panneau Fichiers** repliable à droite (Ctrl+Maj+E) : arborescence du dossier de travail, badges A / M sur les
    fichiers créés ou modifiés par l'agent, aperçu colorié (fichier protégé sur confirmation), diff de la session ;
  - **assistant du premier lancement** en 3 étapes (bienvenue et couleur, modèle, dossier de travail) ;
  - **notifications discrètes** (en bas à droite, quatre au plus, croix, durée selon le genre), **aide des raccourcis**
    avec « ? », **taille du texte** réglable (80 à 150 %, Ctrl+= / Ctrl+- / Ctrl+0) ;
  - tests de l'interface : `e2e/ux.test.mjs`.
- **Suivi de l'utilisation** :
  - chaque réponse (chat, mode Agent, Claude Agent, serveur local) ajoute une ligne à `%APPDATA%\NelCode\usage.jsonl` :
    date, projet (dossier de travail), fournisseur, modèle, tokens d'entrée et de sortie, durée, tokens/s, type, coût
    estimé — jamais le texte des messages. Tokens : champ `usage` des réponses (`stream_options.include_usage` en
    streaming ; estimés à 4 caractères par token si le serveur ne le donne pas), tokenizer du modèle pour les modèles de
    ce PC, événement `result` (tokens, cache compris, et `total_cost_usd`) pour Claude Agent ; en mode Agent, les tokens
    d'entrée de chaque tour s'additionnent ;
  - **coûts estimés** avec une table de prix par modèle (dollars par million de tokens d'entrée et de sortie),
    modifiable dans **Réglages → Suivi**, préremplie avec les prix des modèles Claude de la page officielle des tarifs
    d'Anthropic (vérifiés le 19 novembre 2026, date affichée) ; un nom couvre ses variantes datées ; 0 pour les modèles de
    ce PC et ceux sans prix ;
  - **page Suivi** (icône de la barre latérale, `/suivi`, palette Ctrl+K) : totaux du jour, de la semaine et du mois,
    graphiques en barres SVG (faits à la main) par jour, par fournisseur, par modèle et par projet (tokens ou coût, 7, 30
    ou 90 jours), temps de réponse moyen et tokens/s par modèle, export CSV ;
  - **budget mensuel** facultatif (fournisseurs payants) : avertissement discret à 80 %, et à 100 % une confirmation
    avant chaque nouvelle demande payante (désactivable) ;
  - **tokens et coût estimé de la conversation** dans son en-tête (gardés avec elle) ;
  - les lignes de plus de 90 jours sont **regroupées par jour** au démarrage : le fichier ne grossit pas sans fin ;
  - tests unitaires (prix, table nettoyée, ligne sans texte, regroupement, CSV, tokens de Claude Agent) et de l'interface
    (`e2e/usage.test.mjs`, et Claude Agent dans `e2e/claude.test.mjs`).
- **Images dans les messages** (modèles distants qui voient les images, fournisseur Claude compris, en chat et en mode
  Agent) :
  - ajout par **Ctrl+V**, glisser-déposer sur la fenêtre ou le bouton image de la saisie ; PNG, JPEG, WebP et GIF (sa
    première image), **5 au plus** par message ; miniatures au-dessus de la saisie, avec une croix pour retirer ;
  - **préparées par la partie Rust** : plus grand côté ramené à **1 568 px** (réglable : Réglages → Images, 512 à
    4 096), orientation EXIF appliquée, puis réencodage (JPEG pour les photos, PNG pour les captures, les GIF et la
    transparence) **sans aucune métadonnée** (EXIF, position GPS, profils, textes), avant l'envoi et l'enregistrement ;
  - envoyées au **format OpenAI** (`content` en tableau, images d'abord, `image_url` en data URL base64) ; les images de
    l'historique repartent avec lui tant qu'elles tiennent dans le contexte ;
  - **modèles qui voient les images** : détectés quand c'est possible (modèles Claude ; `capabilities` d'Ollama par
    `/api/show` ; `modalities` de llama.cpp par `/props`), une fois par modèle et à nouveau après « Tester » ; réglage
    manuel par modèle dans **Réglages → Fournisseurs → Images** (automatique, voit, ne voit pas). Pour un modèle qui ne
    les voit pas (ou dont on ne sait rien), pour les `.nelmodel`, les GGUF de ce PC et Claude Agent, le bouton est
    désactivé et explique pourquoi ;
  - **enregistrées en fichiers** dans le dossier de la conversation (`sessions\<id>\img-….jpg|png`, jamais en base64
    dans le JSON : le message garde nom, taille et estimation), affichées dans l'historique (clic : agrandie),
    supprimées avec la conversation ; un dossier d'images sans conversation est retiré au démarrage ;
  - **contexte** : la barre ajoute une estimation des tokens de chaque image (environ largeur × hauteur / 750, marquée
    « estimation », détail dans l'infobulle), et les tokens d'entrée estimés (sans `usage` du serveur) comptent l'image,
    pas son base64 ; le résumé automatique et `/compact` remplacent les anciennes images par « [image : nom] » ;
  - la CSP ne change pas (images : seulement `self` et `data:`) ;
  - tests unitaires (redimensionnement, métadonnées retirées et orientation, formats refusés, GIF, noms de fichiers,
    estimation, dossier de la conversation) et de l'interface (`e2e/images.test.mjs`, le faux serveur vérifie le contenu
    reçu).
- Mode Agent, **explorateurs** (sous-agents) : outil `spawn_explorer(task)` de l'agent principal. Un explorateur a sa
  propre conversation et **seulement les outils de lecture** (`list_files`, `read_file`, `search`) : jamais d'écriture,
  de commande, de plan ni d'autre explorateur (refusés même si son modèle les demande). Il rend un **résumé** (6 000
  caractères au plus) à l'agent ; son texte ne va jamais dans la réponse.
  - **Fichiers protégés** : refusés aux explorateurs (ils ne peuvent pas demander de confirmation), lecture comme
    recherche ; le résumé rendu à l'agent les liste et lui dit qu'il peut les lire lui-même, avec ta confirmation.
  - **Limites réglables** (Réglages) : explorateurs en même temps (2 par défaut : beaucoup de serveurs, comme Ollama,
    traitent les requêtes l'une après l'autre), par demande (5 ; 0 : pas d'explorateurs, ni l'outil ni ses consignes),
    tours par explorateur (6 ; au dernier, il doit conclure, sinon l'agent reçoit la liste de ce qu'il a fait).
    **Modèle des explorateurs** : le même que l'agent, ou un autre plus léger (s'il n'existe plus, celui de l'agent).
  - Plusieurs `spawn_explorer` d'un même tour tournent **en parallèle**. Interface : une étape « Explorateur : … » avec
    ses propres étapes regroupées en dessous (comme les sous-agents de Claude Agent), son état (en attente, en cours,
    arrêtée, erreur), sa durée et ses tokens, mis à jour à chaque tour. **Stop** arrête tout, explorateurs en cours et
    en attente compris.
  - **Suivi** : une ligne `subagent` par explorateur dans `usage.jsonl` (son modèle, ses tokens, son coût), comptée dans
    le budget du mois et dans l'en-tête de la conversation.
  - Le message système dit à l'agent quand lancer des explorateurs (grand projet, recherche à plusieurs endroits) et
    quand s'en passer (petite tâche, fichier déjà connu).
  - Tests : outils et consignes, réglages (unitaires) ; parallélisme, regroupement, limites, refus d'écriture et des
    fichiers protégés, Stop, modèle des explorateurs, suivi et budget (`e2e/explorer.test.mjs`, faux serveur à outils).
- **Client MCP** (Model Context Protocol) : les outils de serveurs MCP sont proposés au modèle en mode Agent, nommés
  `mcp__serveur__outil`. Implémentation minimale du protocole 2025-06-18 (le SDK Rust officiel, rmcp 3, négocie un
  protocole sans `initialize` et lance ses processus lui-même, sans Job Object) : `initialize`, `tools/list` (par
  pages), `tools/call`, `notifications/tools/list_changed` (liste relue avant le tour suivant), `ping`, annulation.
  - **Transports** : stdio (un programme lancé sans fenêtre, cherché dans le PATH avec .exe, .cmd, .bat) et
    Streamable HTTP (réponse JSON ou SSE, session `Mcp-Session-Id`, flux de notifications). **Délais maximaux**
    réglables : démarrage (lancement, poignée de main et liste, 30 s) et appel d'outil (60 s, puis
    `notifications/cancelled`).
  - Un processus stdio et **tous ses enfants** sont dans un Job Object : arrêtés à la fermeture de la conversation
    (une autre ouverte, ou supprimée), à la fermeture de l'application, quand le serveur est désactivé pour la
    conversation ou que son accord est retiré. Son **stderr** va dans `logs\mcp\<serveur>.log`.
  - **Configuration** : serveurs globaux (`%APPDATA%\NelCode\mcp.json`) et serveurs de projet (`.nelcode/mcp.json` du
    dossier de travail), au format `mcpServers` de Claude Desktop. **Import** de la configuration de Claude Desktop ou
    d'un `.mcp.json`, chaque serveur vérifié (nom, transport, commande ou adresse, en-têtes ; ancien SSE refusé ; nom
    déjà pris refusé).
  - **Serveur de projet** : il ne démarre **jamais** sans ton accord. La première fois, Nel Code montre la commande
    exacte (programme trouvé), les arguments et le dossier (ou l'adresse), avec Autoriser / Refuser ; la réponse est
    gardée pour ce dossier et cette configuration précise (empreinte SHA-256) : si elle change, l'accord est redemandé.
  - **Secrets** : les valeurs des variables (`secretEnv`) et des en-têtes (`secretHeaders`) sont dans le Gestionnaire
    d'identification, jamais dans `mcp.json` (à l'import aussi). Un processus MCP ne reçoit **pas** les variables
    secrètes de Nel Code (KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, AUTH, `ANTHROPIC_*`, `OPENAI_*`).
  - **Validation** : chaque appel montre le serveur, l'outil et ses arguments, avec Autoriser / Toujours autoriser cet
    outil / Refuser (« toujours » est gardé pour ce serveur et cette configuration). Les **explorateurs n'y ont pas
    accès**. Les résultats sont **limités** (20 000 octets) et rendus au modèle encadrés comme des **données**, jamais
    des instructions ; le message système le rappelle.
  - **Contexte** : les définitions d'outils (de Nel Code et des serveurs activés) comptent dans la barre de contexte du
    mode Agent. La puce **MCP** de l'en-tête active ou désactive chaque serveur pour la conversation.
  - **Page MCP** (Réglages → Ouvrir la page MCP, ou `/mcp`) : état de chaque serveur, outils, erreurs, journal,
    Redémarrer, Tester, ajout d'un serveur global, valeurs secrètes, activer / désactiver, supprimer, accords des
    serveurs du projet. Les appels MCP s'affichent comme des étapes de l'agent.
  - Pas dans cette version : OAuth pour les serveurs distants (en-têtes fixes seulement), ressources et prompts MCP.
  - Tests : configuration, empreinte, noms d'outils et limites, résultats encadrés, variables, SSE, programmes du
    projet (unitaires) ; poignée de main, appel, refus, « toujours », liste changée, délai, explorateurs, serveurs
    désactivés et contexte, HTTP, secrets, page MCP, arrêt avec la conversation et l'application, serveur de projet non
    autorisé puis nouvel accord, import (`e2e/mcp.test.mjs`, faux serveur MCP en Node `e2e/fake-mcp/server.mjs`).
- **Linux et macOS (expérimental)** : Nel Code se compile et se publie aussi pour Linux (AppImage et `.deb`, x86_64,
  glibc 2.35 ou plus récente) et macOS (binaire universel Intel et Apple Silicon, `.app` et `.dmg` non signés).
  - Clés API (fournisseurs, MCP, Claude Agent) dans le trousseau de chaque système, par la crate `keyring` :
    Gestionnaire d'identification sous Windows (les mêmes identifiants qu'avant), trousseau de macOS, Secret Service
    sous Linux.
  - Processus (commandes de l'agent, serveurs MCP stdio, `claude`) : Job Object sous Windows, groupe de processus sous
    Linux et macOS (Stop, le délai et la fermeture tuent aussi les enfants ; sous Linux, ils s'arrêtent avec Nel Code).
    Stop de Claude Agent : SIGINT au groupe hors Windows.
  - Dossiers de données standards : `~/Library/Application Support/NelCode` (macOS), `$XDG_DATA_HOME/nelcode` ou
    `~/.local/share/nelcode` (Linux) ; sous Windows, `%APPDATA%\NelCode` comme avant.
  - Programmes cherchés dans le PATH selon le système (extensions `.exe`, `.cmd`… sous Windows ; droit d'exécution
    ailleurs) ; sous Linux et macOS, `~/.local/bin`, `/usr/local/bin` et Homebrew sont ajoutés au PATH s'ils manquent
    (une appli lancée depuis le Finder n'a qu'un PATH minimal). `claude` est aussi cherché dans `~/.local/bin` et
    `~/.claude/local`. Configuration de Claude Desktop (import MCP) à sa place sur chaque système.
  - Ouvrir un dossier ou une adresse : Explorateur, Finder ou `xdg-open` ; textes de l'interface selon le système
    (trousseau, gestionnaire de fichiers) ; rapport de bug avec la version du système.
  - Le pack GPU (CUDA, chargement différé des DLL) reste propre à Windows : la feature `cuda` refuse de compiler
    ailleurs, où le calcul se fait sur le processeur.
  - Mises à jour : `latest.json` couvre les trois systèmes (installateur NSIS, AppImage, `.app.tar.gz` universel). Un
    Nel Code installé par le `.deb` ne cherche pas de mise à jour (à la main ; « Rechercher des mises à jour » le dit).
  - Workflow de release : release brouillon créée une fois, puis Windows (tests cargo et de l'interface, installateur
    avec CUDA), Linux sur ubuntu-22.04 (cargo test avec un trousseau GNOME Keyring, AppImage et `.deb`, test de
    démarrage de l'AppImage sous xvfb, installation du `.deb`) et macOS (cargo test, binaire universel) ; `latest.json`
    composé à la fin (`scripts/updater-json.sh`), test de démarrage `scripts/linux-startup-test.sh`. Lancé à la main
    (Actions → Release → Run workflow) : mêmes compilations et tests, paquets gardés 14 jours comme artefacts du
    workflow, sans release ni `latest.json`. Le job `updater-test` vérifie `updater-json.sh` avec de faux fichiers
    (`UPDATER_DIR`) : JSON affiché et contrôlé, échec si un paquet manque.
  - README : installation sur chaque système, ouvrir l'appli non signée sous macOS, tester sous WSL2.
  - Tests unitaires : dossiers de données, configuration de Claude Desktop, noms de programmes et PATH (règles des trois
    systèmes testées partout), droit d'exécution, mises à jour selon le paquet, version du système, espace disque et
    heure locale, groupe de processus (kill, drop, SIGINT), commandes sous Linux/macOS (environnement, délai et Stop
    qui tuent les enfants), trousseau (et, sous Windows, lecture des clés rangées par les versions d'avant), où
    chercher `claude`, bac à sable avec liens symboliques Unix et casse des noms.

### Modifié

- **Version 1.0.0**. README : liste des fonctions, section **Sécurité** (ce qui est protégé, ce qui ne l'est pas,
  signaler une faille), **limites connues**, nouvelles captures d'écran (conversation, mode Agent, Suivi, import,
  commandes, palette), et un **README en anglais** (`README.en.md`). Les captures se refont avec
  `node scripts/captures.mjs` (l'application de développement pilotée comme pour les tests de l'interface).
- Serveur local : les messages d'erreur sont **en anglais**, comme ceux de l'API OpenAI (« missing or incorrect access
  key », « unknown path… », « invalid JSON… ») : les clients et les outils les attendent ainsi.
- Suivi : les colonnes de l'**export CSV** sont en anglais (`date;project;provider;model;kind;input_tokens;
  output_tokens;duration_s;tokens_per_s;estimated_cost_usd;responses`), pour les outils qui le relisent.
- Les modèles de **NELCODE.md** et de **commande personnalisée** viennent de l'interface, dans sa langue (la partie Rust
  écrit le texte reçu, toujours sans écraser un fichier existant).

- `app.js` (1870 lignes) est découpé en modules ES (`nel-desktop/ui/js/` : utilitaires, état, conversation, agent,
  réglages, catalogue, fournisseurs, palette, et les nouveaux projets, fichiers, premier lancement), sans changer le
  comportement : tous les tests de l'interface passent toujours.

### Corrigé

- Images, Linux et macOS : le nom affiché d'une image donnée avec un chemin Windows (`C:\photos\vacances.png`) gardait
  tout le chemin ; seul le nom du fichier est gardé, quel que soit le séparateur. Un test des commandes sous Unix ne
  dépend plus de l'environnement du runner, et le test de démarrage sous Linux (`scripts/linux-startup-test.sh`) ne se
  tue plus lui-même en arrêtant Nel Code (il échouait avec le code 143 alors que Nel Code avait bien démarré).
- Mode Agent : les boutons d'une étape (Accepter, Refuser, Lancer, Autoriser…) sont **grisés dès le premier clic** ; un
  double clic envoyait deux décisions (la seconde en erreur). Ils redeviennent cliquables si la décision échoue.
- Claude Agent : un message de sous-agent ne double plus le texte de l'agent principal ni ne le coupe en étape ; les
  variables `ANTHROPIC_*` et `CLAUDE_CODE_USE_*` du PC ne sont plus transmises (la clé ne part que vers Anthropic) ; un
  dossier voisin au nom plus long n'est plus pris pour le dossier de travail ; la raison d'une modification refusée
  s'affiche avec son diff.
- **Réglages perdus** quand deux écritures de `settings.json` se croisaient (par exemple la clé du serveur local créée
  à l'ouverture des Réglages pendant le réglage « Voit les images » ou la détection d'un modèle) : une lecture pouvait
  tomber sur le fichier vidé par l'écriture en cours, repartir de rien et réécrire les réglages **sans les
  fournisseurs**. Chaque modification lit, change et réécrit maintenant le fichier sous un même verrou, l'écriture
  remplace le fichier d'un coup (fichier temporaire renommé), et un `settings.json` illisible n'est plus jamais écrasé
  (il est mis de côté dans `settings.illisible.json`). C'était la cause des échecs intermittents des tests des images.
- Le journal donne la durée de la préparation de chaque image (réglages, décodage, réduction, encodage, enregistrement).
- Fin d'une réponse : l'état « en cours » n'est levé qu'une fois la réponse enregistrée et affichée (avant, il l'était
  avant l'enregistrement, et la réponse ou son coût apparaissaient un instant plus tard ; deux tests de l'interface
  échouaient parfois pour cette raison).
- Démarrage : la conversation de départ n'est créée qu'une fois les modèles, le modèle actif et les fournisseurs lus,
  juste avant le premier affichage (avant, un test de l'interface pouvait lire la barre d'état encore vide).
- Les tests de l'interface n'utilisent plus les vraies clés du Gestionnaire d'identification (espace à part pour les
  tests), et l'effacement d'un dossier de test bloqué n'attend plus 4 minutes.

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
