# Format .nelmodel (version 2)

Un fichier `.nelmodel` contient un modèle prêt à discuter, exporté par MiniChat (`/export`) et installé dans
Nel Code avec `/import <fichier.nelmodel> [nom]`.

La version 2 ajoute ce qu'il faut pour faire tourner le modèle **sans TorchSharp** (Python, Rust,
JavaScript...) : les poids au format safetensors, la description exacte du tokenizer et du réseau (ce
document), et des sorties de référence pour vérifier une autre implémentation. Les fichiers de la version 1
sont toujours là, identiques : Nel Code (C#, TorchSharp) charge le modèle exactement comme avant.

## Contenu

Une archive **zip**, avec ces six fichiers **à la racine** (pas dans un sous-dossier) :

| Fichier | Contenu | Depuis |
|---|---|---|
| `config.json` | la forme du réseau (`ModelConfig` de MiniChat) | v1 |
| `tokenizer.json` | le tokenizer BPE | v1 |
| `weights.dat` | les poids, format TorchSharp (`module.save`) : ce que charge Nel Code | v1 |
| `model-info.json` | la description du modèle | v1 |
| `model.safetensors` | les mêmes poids, format safetensors, float32 | v2 |
| `reference.json` | ids et sorties de référence du modèle | v2 |

Les six sont toujours écrits par MiniChat. Pour **charger** le modèle, Nel Code n'a besoin que des quatre de la
version 1 ; une autre implémentation utilise `model.safetensors` à la place de `weights.dat`. Il n'y a **pas
d'état d'optimiseur** (`optimizer.dat`) : un `.nelmodel` sert à générer, pas à reprendre un entraînement. Les
autres fichiers éventuels de l'archive sont ignorés.

À l'export, MiniChat relit l'archive : `model.safetensors` contient les mêmes valeurs que `weights.dat` (à l'octet
près), et `tokenizer.json` redonne les ids de `reference.json`.

### config.json

```json
{
  "VocabSize": 4000,
  "BlockSize": 256,
  "EmbedDim": 512,
  "Heads": 8,
  "Layers": 8,
  "Dropout": 0.1,
  "Architecture": "Modern"
}
```

| Clé | Rôle |
|---|---|
| `VocabSize` | nombre de tokens (`V`) |
| `BlockSize` | contexte maximum, en tokens (`T`) : le modèle ne voit jamais plus de `BlockSize` tokens |
| `EmbedDim` | taille des vecteurs (`d`) |
| `Heads` | têtes d'attention (`H`) ; `HeadDim = EmbedDim / Heads` (64 pour toutes les tailles de MiniChat) |
| `Layers` | blocs Transformer (`L`) |
| `Dropout` | entraînement seulement : sans effet en génération |
| `Architecture` | `"Modern"` (RoPE, RMSNorm, SwiGLU) ou `"Classic"` (comme GPT-2). Clé absente : `Classic` |

Largeur cachée du SwiGLU (Modern) : `SwiGluHidden = ((8 × EmbedDim / 3) + 63) / 64 × 64`, divisions entières
(512 → 1408, 640 → 1728, 768 → 2048). Elle n'est pas écrite dans `config.json` ; c'est aussi la forme de
`_gate.weight` dans les poids.

### tokenizer.json

```json
{
  "Alphabet": "\n !"#$%&'()*+,-./0123…",
  "Merges": [[1, 69], [70, 84], …],
  "Special": ["<|doc|>", "<|user|>", "<|assistant|>", "<|end|>"]
}
```

Un objet JSON en UTF-8, sur une seule ligne, avec trois clés (les caractères non ASCII et quelques symboles
sont écrits en `\uXXXX` : un lecteur JSON normal les décode) :

- `Alphabet` (texte) : les caractères de base. Le caractère n° i de `Alphabet` est le token d'id `i`
  (ids `0` à `A - 1`, `A` = longueur de `Alphabet`). Ils sont triés par code, sans doublon.
  **Attention** : MiniChat (C#) compte en **unités UTF-16**, pas en points de code. Un caractère hors du plan
  multilingue de base (un emoji...) fait deux unités (une paire de substitution) ; s'il est dans l'alphabet, ce
  sont ses deux moitiés qui y sont, chacune avec son id. Les alphabets actuels n'en ont pas (DataBuilder nettoie
  le texte), mais une implémentation qui travaille en points de code doit le savoir.
- `Merges` (tableau de paires d'entiers) : `Merges[i] = [gauche, droite]` est la fusion n° i. Elle remplace
  les tokens `gauche` puis `droite` côte à côte par le token d'id `A + i`, dont le texte est
  `texte(gauche) + texte(droite)`. `gauche` et `droite` sont des ids plus petits que `A + i`. L'ordre compte :
  c'est le rang de la fusion (n° petit = apprise tôt = appliquée d'abord).
- `Special` (tableau de textes) : les tokens spéciaux, ids juste après les fusions (`A + M + j`, `M` = nombre de
  fusions). **Obligatoire** : sans lui, le modèle ne connaît pas le format de conversation et Nel Code le refuse.

Le nombre total de tokens `A + M + nombre de Special` est égal à `VocabSize` de `config.json`.

#### Tokens spéciaux

| Token | Id (si 4 tokens spéciaux) | Rôle |
|---|---|---|
| `<|doc|>` | `V - 4` | un nouveau document commence : début de chaque texte de l'entraînement, de chaque conversation |
| `<|user|>` | `V - 3` | début d'un message de l'utilisateur |
| `<|assistant|>` | `V - 2` | début d'une réponse de l'IA |
| `<|end|>` | `V - 1` | fin d'un message : la génération s'arrête là |

Lire les ids dans `Special` (l'ordre du tableau), pas dans ce tableau-ci : avec 4000 tokens, `<|doc|>` = 3996,
`<|user|>` = 3997, `<|assistant|>` = 3998, `<|end|>` = 3999.

#### Encodage (texte → ids)

1. **Tokens spéciaux.** On cherche dans le texte les tokens spéciaux écrits en toutes lettres (`<|end|>`...),
   de gauche à droite, sans chevauchement ; à une même position, le plus long d'abord. Chacun donne son id, et
   n'est jamais découpé ni fusionné. Le texte entre deux tokens spéciaux est encodé avec les étapes 2 à 4.
   (Un utilisateur qui tape `<|end|>` dans son message produit donc le token spécial : c'est le comportement de MiniChat.)
2. **Pré-découpage en mots**, avec cette expression régulière (syntaxe .NET), appliquée de gauche à droite,
   chaque correspondance prenant la première alternative qui marche :

   ```
   \n| ?[\p{L}\p{M}]+| ?\p{N}+| ?[^\s\p{L}\p{M}\p{N}]+|[^\S\n]+
   ```

   | Alternative | Prend | Exemple |
   |---|---|---|
   | `\n` | un retour à la ligne, toujours seul | `"\n"` |
   | ` ?[\p{L}\p{M}]+` | des lettres (et accents combinants), avec au plus une espace devant | `" bonjour"`, `"été"` |
   | ` ?\p{N}+` | des chiffres (et autres nombres Unicode : `²`, `½`), avec au plus une espace devant | `" 2024"` |
   | ` ?[^\s\p{L}\p{M}\p{N}]+` | ponctuation et symboles, avec au plus une espace devant | `" !"`, `"…"`, `" «"` |
   | `[^\S\n]+` | les autres espaces (tous les blancs sauf `\n`), d'un bloc | `"   "`, `"\t"` |

   - Seule l'espace U+0020 peut se coller devant un mot : une tabulation ou une espace insécable forme son
     propre morceau.
   - Pas de « regarder devant » comme GPT-2 : trois espaces puis un mot donnent `"   "` puis `"avec"` (le mot
     sans espace), pas `"  "` puis `" avec"`.
   - `\s` en .NET = `[\f\n\r\t\v\x85\p{Z}]` ; `\p{L}`, `\p{M}`, `\p{N}` = catégories Unicode générales
     (lettres, marques, nombres). En Python, utiliser le module `regex` (le module `re` ne connaît pas `\p{...}`)
     et définir `\s` comme ci-dessus : le `\s` de Python inclut aussi `\x1c`-`\x1f`.
   - .NET applique les catégories à chaque **unité UTF-16** : une moitié de paire de substitution est de
     catégorie `Cs`, donc un caractère hors du plan de base (emoji, lettre mathématique...) tombe toujours
     dans la ponctuation.
   - Les fins de ligne `\r\n` ont été remplacées par `\n` dans les données d'entraînement : faire de même
     avant d'encoder.
3. **Caractères inconnus.** Dans chaque mot, les caractères absents de `Alphabet` sont **supprimés** (le reste
   du mot est gardé). Un mot qui n'avait que des caractères inconnus ne donne aucun token. Exemple :
   `" —"` donne `" "` si `—` n'est pas dans l'alphabet.
4. **Fusions.** Le mot devient la liste des ids de ses caractères. Tant qu'il reste au moins deux tokens :
   parmi toutes les paires voisines qui sont une fusion, on prend celle de **plus petit rang** `r`, puis on
   remplace **toutes** ses apparitions dans le mot, de gauche à droite, sans chevauchement (`a a a` + fusion
   `(a, a)` → `aa a`), par l'id `A + r`. On s'arrête quand aucune paire voisine n'est une fusion.

Les ids d'un texte = les ids de ses mots et de ses tokens spéciaux, dans l'ordre.

#### Décodage (ids → texte)

Le texte d'un token : son caractère (alphabet), la concaténation de ses deux parties (fusion), ou le token
spécial en toutes lettres. Le texte d'une suite d'ids = la concaténation des textes de ses tokens.

### weights.dat

Les poids du `MiniGpt`, écrits par TorchSharp (`module.save`) : ce que lit Nel Code. Mêmes noms et mêmes
valeurs que dans `model.safetensors` (voir plus bas). Le chargement est strict : un poids manquant, en trop
ou de mauvaise forme est une erreur.

### model.safetensors

Les poids au format [safetensors](https://github.com/huggingface/safetensors), lisibles par exemple avec
`safetensors.numpy.load_file("model.safetensors")` ou `safetensors.torch.load_file(...)` :

- 8 octets : `N`, la taille de l'en-tête (entier non signé 64 bits, little-endian) ;
- `N` octets : l'en-tête JSON (UTF-8), complété d'espaces jusqu'à un multiple de 8 :
  `{"__metadata__": {...}, "<nom>": {"dtype": "F32", "shape": [...], "data_offsets": [début, fin]}, ...}` ;
- le reste : les données. Tous les tenseurs sont en **float32 little-endian**, en ordre de ligne (le dernier
  indice varie le plus vite), à la suite ; `data_offsets` compte en octets depuis le début des données.

`__metadata__` : `{"format": "pt", "nelmodel.formatVersion": "2", "architecture": "Modern"}`.

#### Noms des paramètres

Les noms sont exactement ceux de `state_dict()` de TorchSharp : les noms des champs des modules C# de
MiniChat (avec leur `_`), séparés par des points. `n` = numéro du bloc, de `0` à `Layers - 1`. Une couche
linéaire a ses poids de forme `[sortie, entrée]` et calcule `y = x · Wᵀ (+ b)`.

**Modern** (aucun biais) :

| Nom | Forme | Rôle |
|---|---|---|
| `_tokenEmbedding.weight` | `[V, d]` | embedding des tokens, **et** couche de sortie (weight tying : pas de matrice de sortie à part) |
| `_blocks.n._norm1.weight` | `[d]` | RMSNorm avant l'attention |
| `_blocks.n._attention._qkv.weight` | `[3d, d]` | Q, K et V d'un coup : lignes `0..d-1` = Q, `d..2d-1` = K, `2d..3d-1` = V |
| `_blocks.n._attention._projection.weight` | `[d, d]` | sortie de l'attention |
| `_blocks.n._norm2.weight` | `[d]` | RMSNorm avant le SwiGLU |
| `_blocks.n._feedForward._gate.weight` | `[SwiGluHidden, d]` | SwiGLU, la « vanne » (passe par SiLU) |
| `_blocks.n._feedForward._up.weight` | `[SwiGluHidden, d]` | SwiGLU, la valeur |
| `_blocks.n._feedForward._down.weight` | `[d, SwiGluHidden]` | SwiGLU, retour à `d` |
| `_finalNorm.weight` | `[d]` | RMSNorm finale |

Exemple (small, 4000 tokens) : 1 + 8 × 7 + 1 = 58 tenseurs, 27 746 816 paramètres.

**Classic** (comme GPT-2 ; d'anciens modèles) : `_tokenEmbedding.weight [V, d]`,
`_positionEmbedding.weight [BlockSize, d]`, puis par bloc `_norm1.weight`/`.bias [d]` (LayerNorm),
`_attention._qkv.weight [3d, d]` (sans biais), `_attention._projection.weight [d, d]` et `.bias [d]`,
`_norm2.weight`/`.bias [d]`, `_feedForward._expand.weight [4d, d]` et `.bias [4d]`,
`_feedForward._shrink.weight [d, 4d]` et `.bias [d]` ; enfin `_finalNorm.weight`/`.bias [d]`.

Ne pas compter sur l'ordre des tenseurs dans le fichier : les lire par leur nom.

### Le réseau (calcul d'un passage)

Entrée : `ids`, de longueur `t ≤ BlockSize`. Position `p` = indice dans `ids`, de `0` à `t - 1` (le premier
token du contexte est en position 0). Sortie : `logits` de forme `[t, V]` ; la ligne `p` donne le score de chaque
token pour la position `p + 1`.

**Modern** :

```
x = _tokenEmbedding.weight[ids]                                   # [t, d]
pour chaque bloc n :
    x = x + Attention(RMSNorm(x, _norm1))
    x = x + SwiGLU(RMSNorm(x, _norm2))
logits = RMSNorm(x, _finalNorm) · _tokenEmbedding.weightᵀ          # [t, V]
```

- **RMSNorm** : `y = x / sqrt(moyenne(x²) + eps) × weight`, moyenne sur la dernière dimension (`d`),
  **`eps = 1e-5`**, ajouté sous la racine. Pas de soustraction de la moyenne, pas de biais.
- **Attention** :
  1. `qkv = x · _qkv.weightᵀ` (`[t, 3d]`), découpé en `q`, `k`, `v` (`[t, d]` chacun, dans cet ordre) ;
  2. chacun est découpé en `H` têtes de `HeadDim` : la tête `h` prend les colonnes `h × HeadDim` à
     `(h + 1) × HeadDim - 1` ;
  3. **RoPE** sur `q` et `k` de chaque tête (pas sur `v`), voir plus bas ;
  4. par tête : `scores = q · kᵀ / sqrt(HeadDim)`, masque causal (la position `p` ne voit que les positions
     `≤ p`, les autres à `-∞`), `softmax` sur chaque ligne, `sortie = poids · v` ;
  5. les têtes recollées dans l'ordre (`[t, d]`), puis `· _projection.weightᵀ`.
- **RoPE** (rotation par moitiés, comme LLaMA / GPT-NeoX, pas par paires voisines) : avec `D = HeadDim`,
  **`θ = 10 000`**, pour `i` de `0` à `D/2 - 1` :
  `fréquence_i = θ^(-2i / D)` et `angle(p, i) = p × fréquence_i` (radians). La dimension `i` et la dimension
  `i + D/2` forment une paire, tournée de `angle(p, i)` :

  ```
  a = x[i], b = x[i + D/2]
  x'[i]       = a × cos(angle) - b × sin(angle)
  x'[i + D/2] = b × cos(angle) + a × sin(angle)
  ```

  Autrement dit : `x' = x × cos + rotate_half(x) × sin`, avec `rotate_half(x) = concat(-x[D/2:], x[:D/2])` et
  `cos`, `sin` de chaque angle répétés deux fois (`concat(cos(angles), cos(angles))`). Calcul en float32.
- **SwiGLU** : `sortie = (silu(x · _gate.weightᵀ) × (x · _up.weightᵀ)) · _down.weightᵀ`, avec
  `silu(z) = z × sigmoid(z)` et `×` élément par élément.

**Classic** : `x = _tokenEmbedding.weight[ids] + _positionEmbedding.weight[positions]`, pas de RoPE ; LayerNorm
(`eps = 1e-5`, avec moyenne et biais) au lieu de RMSNorm ; FeedForward
`gelu(x · _expand.weightᵀ + _expand.bias) · _shrink.weightᵀ + _shrink.bias` (GELU exacte, avec `erf`) au lieu de
SwiGLU ; `_projection` a un biais. Le reste est identique.

Le dropout ne sert qu'à l'entraînement : en génération, aucun.

### Le prompt de chat

Le modèle a appris des conversations écrites avec les tokens spéciaux :

```
<|doc|><|user|>Bonjour !<|end|><|assistant|>Bonjour, comment vas-tu ?<|end|><|user|>...
```

Pour un nouveau message, le prompt est :

```
<|doc|>                                                  une seule fois, au début
<|user|>{question}<|end|><|assistant|>{réponse}<|end|>   chaque tour précédent gardé, du plus ancien au plus récent
<|user|>{message}<|end|><|assistant|>                    le message ; le modèle écrit la suite
```

- Les textes sont pris sans espaces ni retours à la ligne au début et à la fin (`Trim()`). Pas d'espace ni de
  retour à la ligne entre les morceaux, pas de `Toi:` / `IA:` (ce ne sont que des noms d'affichage).
- On génère jusqu'à ce que le modèle écrive **un token spécial quel qu'il soit** (`<|end|>` normalement ;
  `<|user|>` voudrait dire qu'il écrit la question suivante), qui n'est pas affiché, ou jusqu'à 80 tokens.
- Tours gardés : on part du plus récent et on remonte, tant que
  `tokens(<|doc|>) + tokens(tours gardés) + tokens(message) ≤ BlockSize - 80`. On ne coupe jamais un tour :
  le premier qui ne tient plus et tous ceux d'avant sont oubliés. Chaque morceau commence et finit par un token
  spécial, donc les tokens des morceaux s'additionnent exactement.
- Tirage par défaut de Nel Code : température 0,8, top-k 20, top-p 0,9 (voir `settings.json`). Pour la
  comparaison avec `reference.json`, utiliser le mode glouton.
- Si le contexte atteint `BlockSize` pendant une réponse, MiniChat garde les `3/4 × BlockSize` derniers tokens,
  renumérotés depuis la position 0.

### reference.json

Ce que MiniChat a calculé avec ce modèle, sur CPU, en float32, **sans** cache KV (toute la séquence repasse
dans le réseau à chaque token). Une autre implémentation doit retrouver exactement les ids, et les probabilités
à environ `1e-4` près.

```json
{
  "note": "...",
  "texts": [
    { "text": "Bonjour, comment vas-tu ?", "ids": [3392, 13, 693, 3066, 14, 280, 259],
      "tokens": ["Bonjour", ",", " comment", " vas", "-", "tu", " ?"] },
    ...
  ],
  "chat": [
    { "message": "Bonjour !",
      "prompt": "<|doc|><|user|>Bonjour !<|end|><|assistant|>",
      "promptIds": [3996, 3997, 3392, 606, 3999, 3998],
      "topTokens": [ { "id": 3392, "token": "Bonjour", "probability": 0.846947 }, ... ],
      "greedyIds": [3392, 606, 1360, ...],
      "greedyText": "Bonjour ! Comment puis-je vous aider aujourd'hui ?<|end|>Bonjour !..." },
    ...
  ]
}
```

- `texts` : 5 textes fixes, choisis pour tester le tokenizer (accents, chiffres, `…` et `«`, retours à la ligne
  et espaces multiples, tabulation, tokens spéciaux, caractères absents de l'alphabet, emoji), avec leurs `ids` et
  le texte de chaque token (`tokens`).
- `chat` : 3 messages (`Bonjour !`, `Qui es-tu ?`, `Quelle est la capitale de la France ?`), chacun le premier
  d'une conversation :
  - `prompt` et `promptIds` : le prompt de chat (voir plus haut) et ses ids ;
  - `topTokens` : les 10 tokens les plus probables juste après le prompt, du plus probable au moins probable :
    `softmax` des logits de la dernière position (température 1), arrondi à 6 décimales ;
  - `greedyIds` / `greedyText` : 30 tokens générés en mode glouton, en ajoutant à chaque pas le token de logit
    maximal. **Exactement 30**, sans s'arrêter aux tokens spéciaux (on y voit `<|end|>` puis la suite) : la
    comparaison porte sur toute la suite. Le premier est `topTokens[0]`.

Deux tokens presque à égalité peuvent s'inverser avec des calculs dans un autre ordre (float32) : si une
implémentation diverge en mode glouton, comparer d'abord `topTokens`.

### model-info.json

```json
{
  "formatVersion": 2,
  "name": "minichat-v3",
  "createdAt": "2026-11-11T14:27:39+01:00",
  "parameters": 27746816,
  "architecture": "Modern",
  "valLoss": 1.698,
  "trainingSteps": 4416,
  "description": "Pré-entraîné sur texte.txt, fine-tuné sur dialogues.txt"
}
```

| Clé | Type | Rôle |
|---|---|---|
| `formatVersion` | entier | **obligatoire**, version de ce format : `2` |
| `name` | texte | nom proposé à l'import (sinon : le nom du fichier sans `.nelmodel`) |
| `createdAt` | date ISO 8601 | date de l'export |
| `parameters` | entier | nombre de paramètres |
| `architecture` | texte | `"Modern"` ou `"Classic"` |
| `valLoss` | nombre | loss de vérification des poids exportés |
| `trainingSteps` | entier | nombre de pas d'entraînement |
| `description` | texte | une phrase libre |

Seul `formatVersion` est obligatoire. Les autres clés sont affichées à l'import, mais ce qui compte pour
charger le modèle reste `config.json` : en cas de désaccord, c'est lui qui fait foi. Seul `parameters` est
contrôlé : s'il ne correspond pas au vrai nombre de paramètres, Nel Code installe le modèle mais affiche un
avertissement.

## Import dans Nel Code

`/import <fichier.nelmodel> [nom] [--replace]` :

1. ouvre le zip (refus s'il n'est pas un zip valide) ;
2. vérifie que `config.json`, `tokenizer.json`, `weights.dat` et `model-info.json` sont présents (refus qui les
   nomme sinon). `model.safetensors` et `reference.json` ne servent pas au chargement : ils peuvent être gardés
   avec le modèle ou ignorés ;
3. lit `formatVersion` : accepte `1` et `2` ; refus si elle manque ou est plus récente que celle que Nel Code
   connaît (« mets Nel Code à jour ») ;
4. affiche les infos de `model-info.json` ;
5. si le nom est déjà pris, demande : remplacer, choisir un autre nom, ou annuler (`--replace` remplace
   sans demander) ;
6. extrait les fichiers dans un dossier temporaire et charge le modèle (`config.json`, `tokenizer.json`,
   `weights.dat`) pour le tester ;
7. si tout va bien, installe le modèle dans `%APPDATA%\NelCode\models\<nom>`. Sinon, rien n'est gardé, et un
   modèle qu'on voulait remplacer reste tel quel ;
8. avertit si `parameters` ne correspond pas au modèle chargé.

Le nom vient de l'argument `[nom]`, sinon de `name`, sinon du nom du fichier. L'ancien modèle n'est supprimé
qu'une fois le nouveau vérifié. Si c'était le modèle actif, il est rechargé.

Pour les tests, `/import` accepte aussi directement un dossier de modèle MiniChat (`config.json`,
`tokenizer.json`, `weights.dat`).

## Versions

| Version | Changement |
|---|---|
| 1 | première version |
| 2 | ajoute `model.safetensors` et `reference.json`, et décrit le tokenizer, le réseau et le prompt (ce document). Les quatre fichiers de la version 1 ne changent pas |

Lire une version 2 avec un lecteur de la version 1 : il suffit d'accepter `formatVersion: 2`, les fichiers
ajoutés sont ignorés. Un Nel Code qui n'accepte que `1` refuse un `.nelmodel` version 2 (étape 3) : il faut le
mettre à jour.

Une nouvelle version n'est nécessaire que si un ancien Nel Code ne peut pas lire correctement le nouveau
contenu. Ajouter une clé facultative à `model-info.json` ne change pas la version.
