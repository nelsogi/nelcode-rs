# Changelog

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), et le projet [Semantic Versioning](https://semver.org/lang/fr/).

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

[0.1.0]: https://github.com/nelsogi/nelcode-rs/releases/tag/v0.1.0
