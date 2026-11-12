# Nel Code

Discuter avec les petits modèles de langage entraînés par [MiniChat](https://github.com/nelsogi/MiniChat), **sur ton PC, sans connexion**.

Nel Code est une application Windows (Tauri v2) qui fait tourner les modèles `.nelmodel` sur le processeur, avec un moteur écrit
en Rust ([Candle](https://github.com/huggingface/candle)). C'est la version Rust de [Nel Code](https://github.com/nelsogi/NelCode)
(C#, TorchSharp), dont elle reprend les conversations et les réglages.

![Une conversation dans Nel Code](docs/conversation.png)

> Les modèles MiniChat sont **très petits** (~28 M de paramètres) : ils répondent en français, mais se trompent souvent et
> inventent des faits, comme sur la capture ci-dessus. Nel Code sert à apprendre et à expérimenter, pas à s'informer.
> Voir la [carte du modèle](MODEL-CARD.md).

## Installation

1. Télécharge `Nel Code_0.4.0_x64-setup.exe` dans les [Releases](https://github.com/nelsogi/nelcode-rs/releases).
2. Lance-le. L'installateur n'est **pas signé** : si Windows SmartScreen affiche « Windows a protégé votre ordinateur »,
   clique sur « Informations complémentaires », puis « Exécuter quand même ».
3. Il faut **WebView2** (déjà présent sur Windows 10 et 11 à jour). S'il manque, l'installateur l'installe tout seul
   (une connexion internet est alors nécessaire).

Windows 10 ou 11, 64 bits. Pas besoin de carte graphique ; avec une carte NVIDIA, le [pack GPU](#calcul-sur-gpu-nvidia)
accélère les réponses.

## Utilisation

### Importer un modèle

Nel Code n'est livré avec aucun modèle. Télécharge `minichat-v3b.nelmodel` dans la release
[models](https://github.com/nelsogi/nelcode-rs/releases/tag/models) (usage non commercial, voir la [carte du modèle](MODEL-CARD.md)),
ou exporte le tien depuis MiniChat avec `/export`. Puis :

- **glisse le fichier `.nelmodel` dans la fenêtre**, ou
- clique sur **＋** à côté de « Modèles », ou tape `/import`, ou `Ctrl+I`, ou
- double-clique sur le fichier dans l'Explorateur.

Nel Code vérifie le fichier (archive zip, fichiers présents, version du format), affiche ses infos et demande sous quel nom
l'installer. Le modèle est extrait et chargé pour essai avant d'apparaître dans la liste ; un modèle du même nom n'est remplacé
qu'une fois le nouveau vérifié.

![Import d'un modèle](docs/import.png)

Le format est décrit dans [NELMODEL-FORMAT.md](NELMODEL-FORMAT.md).

### Discuter

Écris un message et appuie sur Entrée. La réponse s'affiche au fil des tokens ; **Stop** (ou Échap) l'arrête.
Sous chaque message : **Copier**, **Modifier** (la conversation repart de ce message), **Régénérer** (la nouvelle réponse
s'ajoute comme une version : ‹ 1/2 › pour passer de l'une à l'autre).

Le modèle ne voit que ses 256 derniers tokens : la barre sous la saisie montre combien le prochain message en utilisera,
et les échanges qu'il ne voit plus sont grisés.

Chaque conversation a son **dossier de travail** (en haut à droite) : l'export s'y ouvre, et `/import <fichier>` y cherche
les chemins relatifs.

### Commandes

Tape `/` dans la saisie : les commandes s'affichent, `↑` `↓` pour choisir, `Tab` pour compléter.

![Suggestions des commandes](docs/commandes.png)

| Commande | Effet |
|---|---|
| `/new` | Nouvelle conversation |
| `/model <nom>` | Charger un modèle installé |
| `/models` | Lister les modèles installés |
| `/import [fichier]` | Importer un `.nelmodel` |
| `/temp <0.1 à 2>` | Température : bas = sage, haut = créatif |
| `/topk <n>` | Tirage parmi les K tokens les plus probables (0 = sans limite) |
| `/topp <0.05 à 1>` | Tirage parmi les tokens qui font cette part des chances |
| `/max <16 à 128>` | Longueur maximale d'une réponse, en tokens |
| `/rename [titre]` | Renommer la conversation |
| `/export [md\|txt]` | Exporter la conversation |
| `/dir` | Changer le dossier de travail |
| `/open` | Ouvrir le dossier de travail dans l'Explorateur |
| `/delete` | Supprimer la conversation |
| `/settings` | Réglages de génération |
| `/info` | Modèle, réglages, dossiers |
| `/help` | Liste des commandes et des raccourcis |

Sans valeur, `/temp`, `/topk`, `/topp` et `/max` affichent le réglage actuel.

Dans les **Réglages** (Ctrl+,), la **pénalité de répétition** (1 à 2, 1,15 par défaut) rend moins probables les tokens
des 64 derniers : le modèle tourne moins en boucle. 1 la désactive ; trop haute, il évite même les mots utiles.

### Raccourcis

| Touche | Effet |
|---|---|
| `Entrée` / `Maj+Entrée` | Envoyer / nouvelle ligne |
| `Échap` | Arrêter la réponse, fermer une fenêtre |
| `Ctrl+K` | Palette : actions, conversations, modèles |
| `Ctrl+N` | Nouvelle conversation |
| `Ctrl+I` | Importer un modèle |
| `Ctrl+,` | Réglages |
| `F2` | Renommer la conversation |

![La palette Ctrl+K](docs/palette.png)

### Mises à jour

À partir de la 0.3.0, Nel Code se met à jour tout seul. Au démarrage (au plus une fois par jour), il regarde s'il y a
une nouvelle version dans les [Releases](https://github.com/nelsogi/nelcode-rs/releases) : si oui, un bandeau
« Nel Code X.Y.Z est disponible » montre les notes de version. **Installer** télécharge la mise à jour, l'installe et
relance Nel Code ; **Plus tard** la laisse de côté jusqu'au prochain démarrage. Si une réponse est en train de s'écrire,
l'installation attend qu'elle soit finie.

- **Rechercher des mises à jour** : dans la palette Ctrl+K, ou dans les Réglages ;
- la vérification automatique se désactive dans les Réglages (« Rechercher les mises à jour au démarrage ») ;
- les mises à jour sont **signées** : Nel Code refuse un fichier dont la signature ne correspond pas à sa clé publique ;
- sans connexion, rien ne bloque : une notification le dit, et Nel Code fonctionne normalement.

Les conversations, réglages et modèles (`%APPDATA%\NelCode`) ne sont pas touchés par une mise à jour.
Depuis la 0.1.0 ou la 0.2.0, il faut installer la 0.3.0 à la main une fois.

### Calcul sur GPU NVIDIA

Nel Code calcule sur le processeur. Avec une carte NVIDIA (Turing ou plus récente : GTX 16xx, RTX 20xx, 30xx, 40xx…,
pilote **576.02** ou plus récent), il peut calculer sur le GPU :

1. **Réglages → Calcul** : la carte et le pilote détectés s'affichent (avec un lien vers les pilotes NVIDIA si le tien est
   trop ancien) ;
2. **Installer le pack GPU (593 Mo)** : les bibliothèques CUDA de NVIDIA, téléchargées une fois dans `%APPDATA%\NelCode\gpu`.
   L'espace disque et l'empreinte SHA-256 sont vérifiés avant l'installation ; Annuler, ou une erreur, ne laisse rien ;
3. le modèle est rechargé sur le GPU : la barre d'état affiche `GPU · <ta carte>`.

**Automatique** (par défaut) prend le GPU s'il est disponible, sinon le CPU, sans erreur ; **CPU** et **GPU** forcent le
choix. **Retirer le pack GPU** l'efface (au prochain démarrage s'il est en cours d'utilisation). L'installateur de Nel Code
ne contient aucune bibliothèque CUDA : elles ne viennent que du pack, et ne sont chargées que depuis son dossier.

**Tester la vitesse** (Réglages, palette Ctrl+K) mesure le modèle chargé sur CPU puis sur GPU : chargement, temps du
prompt, tokens/s sur 200 tokens. Les résultats sont gardés par modèle. Sur une NVIDIA T400 : 348 tokens/s, contre
134 sur le processeur.

### En cas de problème

Nel Code tient un journal dans `%APPDATA%\NelCode\logs` (un fichier par jour, 7 jours gardés) : démarrage, modèles,
erreurs, mises à jour, GPU, jamais le texte des conversations. **Copier un rapport de bug** (Réglages, palette Ctrl+K)
copie la version, Windows, le modèle actif et les 50 dernières lignes du journal : à coller dans une
[issue](https://github.com/nelsogi/nelcode-rs/issues).

### Où sont les données

Dans `%APPDATA%\NelCode`, comme pour Nel Code C# : les deux versions partagent les modèles (`models\`), les conversations
(`sessions\`, un fichier JSON chacune) et `settings.json`. Les modèles installés par la version C# (poids `weights.dat`)
se chargent aussi.

## Compiler depuis les sources

Il faut :

- [Rust](https://rustup.rs/) (stable) et les **outils de build C++ de Visual Studio** (« Développement Desktop en C++ ») ;
- la CLI Tauri : `cargo install tauri-cli --version "^2" --locked`.

```powershell
git clone https://github.com/nelsogi/nelcode-rs
cd nelcode-rs

# Les tests comparent le moteur aux sorties de référence du modèle de test (pas dans le dépôt : 222 Mo)
gh release download models --pattern "minichat-v3b.nelmodel" --dir test-models
cargo test --workspace

# L'application, en développement
cargo run -p nel-desktop

# L'installateur : target\release\bundle\nsis\Nel Code_<version>_x64-setup.exe
cd nel-desktop
cargo tauri build
```

`cargo tauri build` signe aussi la mise à jour, et demande donc la clé privée (`TAURI_SIGNING_PRIVATE_KEY`). Sans elle,
construire l'installateur sans les fichiers de mise à jour :
`cargo tauri build --config '{\"bundle\":{\"createUpdaterArtifacts\":false}}'`.

Le dossier `test-models` peut être remplacé par la variable `NELMODEL` (chemin du `.nelmodel` de test).

### Tests de l'interface

L'application de développement est lancée avec des dossiers de données et WebView2 temporaires (rien ne touche à
`%APPDATA%\NelCode`), puis pilotée par le port de débogage de WebView2 ([Node](https://nodejs.org) 22 ou plus récent) :

```powershell
cargo build -p nel-desktop
node --test --test-reporter=spec "e2e/*.test.mjs"
```

`e2e/nelcode.test.mjs` couvre le démarrage, l'import, une réponse, Stop, Régénérer et les versions, Modifier, le
changement de modèle, la recherche, renommer et supprimer, les réglages, la transparence, la comparaison et le vote, le
test de vitesse et le rapport de bug. `e2e/gpu.test.mjs` (pack GPU, calcul sur GPU) est ignoré sans carte NVIDIA, sans
CUDA ou sans pack. `E2E_VERBOSE=1` affiche la sortie de l'application.

### Avec CUDA

Il faut en plus le [CUDA Toolkit 12.9](https://developer.nvidia.com/cuda-12-9-1-download-archive) et MSVC **v143**
(Visual Studio 2022, ou le composant « MSVC v143 » de Visual Studio 2026 : nvcc 12.9 refuse MSVC 14.5x). Depuis une
« Developer PowerShell » MSVC 14.44 (`vcvars64.bat -vcvars_ver=14.44`) :

```powershell
$env:CUDA_COMPUTE_CAP = "75"   # Turing et plus récent ; sans GPU dans la machine, obligatoire
cargo build --release -p nel-desktop --features cuda
cargo test --release -p nel-engine --features cuda   # reference.json aussi sur GPU, à 1e-3

# Les tests de l'interface sur GPU, avec le pack construit en local
cargo build -p nel-desktop --features cuda --target-dir target\cuda
.\make-gpu-pack.ps1
$env:NELCODE_EXE = "target\cuda\debug\nel-desktop.exe"; node --test --test-reporter=spec e2e/gpu.test.mjs
```

Les DLL CUDA sont chargées en différé (`nel-desktop/build.rs`) : Nel Code démarre sans elles, et les charge depuis le
pack, par chemin complet, avant le premier calcul sur GPU.

`make-gpu-pack.ps1` construit le pack : uniquement les DLL dont Candle a besoin (liste `PACK_DLLS` de
`nel-engine/src/gpu.rs`), prises dans le CUDA Toolkit, chacune vérifiée dans la liste des fichiers redistribuables du
CUDA EULA (Attachment A), plus l'avis de licence de NVIDIA. Il écrit la taille et l'empreinte SHA-256 dans
`nel-desktop/src/gpu.rs` ; `-Publish` l'envoie dans la release `gpu-pack-cuda12` (pre-release), sans jamais remplacer un
pack déjà publié.

Pour discuter en ligne de commande, sans l'interface :

```powershell
cargo run --release -p nel-engine --bin nel-chat -- test-models\minichat-v3b.nelmodel
```

### Organisation

| Dossier | Contenu |
|---|---|
| `nel-engine/` | La bibliothèque : tokenizer BPE, réseau MiniGpt, cache KV, génération, GPU (`gpu.rs`) ; tests contre `reference.json` ; `nel-chat` |
| `nel-desktop/` | L'application Tauri : `src/` (commandes, fichiers, import, journal, pack GPU), `ui/` (HTML, CSS, JS sans framework) |
| `e2e/` | Les tests de l'interface (Node, port de débogage de WebView2) |
| `docs/` | Captures d'écran |

Une release se fait en poussant un tag `v<version>` (la version de `nel-desktop/Cargo.toml`) : GitHub Actions lance les tests,
construit l'installateur et crée une release **brouillon** (voir `.github/workflows/release.yml`).

Le pack GPU est une release à part (`gpu-pack-cuda12`, pre-release, jamais « latest ») : il ne change qu'avec la version
de CUDA, et son empreinte est écrite dans le code de l'application.

## Licence

Le code est sous licence [MIT](LICENSE). Les modèles ont leur propre licence : celle de `minichat-v3b` est dans sa
[carte](MODEL-CARD.md) (usage non commercial).

Le pack GPU contient des bibliothèques du NVIDIA CUDA Toolkit, redistribuées sans modification selon le
[CUDA EULA](https://docs.nvidia.com/cuda/eula/index.html) ; l'avis de licence de NVIDIA est dans le pack
(`NVIDIA-LICENSE.txt`).

Les icônes de l'interface (`nel-desktop/ui/icons.js`) sont tirées de [Lucide](https://lucide.dev), sous licence
[ISC](https://github.com/lucide-icons/lucide/blob/main/LICENSE) : © Lucide Contributors (2022), © Cole Bemis (2013-2022, Feather).
