# Changelog

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), et le projet [Semantic Versioning](https://semver.org/lang/fr/).

## [0.4.0] - 2026-11-12

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
