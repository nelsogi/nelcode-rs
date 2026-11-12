# Changelog

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), et le projet [Semantic Versioning](https://semver.org/lang/fr/).

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
