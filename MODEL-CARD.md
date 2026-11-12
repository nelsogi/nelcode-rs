# Carte du modèle : minichat-v3b

Petit modèle de langage en français, entraîné de zéro avec [MiniChat](https://github.com/nelsogi/MiniChat),
pour discuter dans Nel Code. Fichier : `minichat-v3b.nelmodel` (format 2, voir [NELMODEL-FORMAT.md](NELMODEL-FORMAT.md)).

## En bref

| | |
|---|---|
| Paramètres | 27 746 816 (~28 M) |
| Architecture | Transformer décodeur « Modern » : RMSNorm, RoPE, attention causale, SwiGLU, weight tying |
| Taille | 8 blocs, 8 têtes, vecteurs de 512, SwiGLU 1408 |
| Contexte | 256 tokens (dont 80 gardés pour la réponse dans Nel Code) |
| Tokenizer | BPE, 4000 tokens (dont 4 spéciaux), appris sur les données d'entraînement |
| Entraînement | 4416 pas, loss de vérification 1,698 ; exporté le 11.11.2026 |
| Langue | français uniquement |
| Licence des poids | **CC BY-NC-SA 4.0 proposée, usage non commercial** (voir plus bas) |

## Données d'entraînement

Vérifiées le 11.11.2026 sur les cartes Hugging Face. Ce n'est pas un avis juridique.

### Pré-entraînement (`texte.txt`, 1,47 Go)

| Source | Ce qui a été pris | Licence |
|---|---|---|
| [wikimedia/wikipedia](https://huggingface.co/datasets/wikimedia/wikipedia) | `20231101.fr`, partie 1 sur 17 (fichier identique à l'octet) | CC BY-SA 3.0 et GFDL |
| [HuggingFaceFW/fineweb-2](https://huggingface.co/datasets/HuggingFaceFW/fineweb-2) | `fra_Latn`, un fichier de 63 Mo (même schéma, mais pas de version publiée de cette taille retrouvée) | ODC-By 1.0, plus les conditions d'utilisation de Common Crawl |
| [iproskurina/TinyStories-French](https://huggingface.co/datasets/iproskurina/TinyStories-French) | les 1000 histoires | **aucune licence déclarée** ; traduction de [TinyStories](https://huggingface.co/datasets/roneneldan/TinyStories) (CDLA-Sharing-1.0) |

### Fine-tuning (dialogues, ~135 000 conversations)

D'après le README et le commit `171f09d` de MiniChat. Le fichier de dialogues lui-même n'est pas sur ce PC : **à confirmer**.

| Source | Licence |
|---|---|
| [OpenAssistant/oasst2](https://huggingface.co/datasets/OpenAssistant/oasst2) | Apache 2.0 |
| [jpacifico/French-Alpaca-dataset-Instruct-110K](https://huggingface.co/datasets/jpacifico/French-Alpaca-dataset-Instruct-110K) | Apache 2.0 ; généré par GPT-3.5-turbo, l'auteur demande à être crédité |
| [angeluriot/french_instruct](https://huggingface.co/datasets/angeluriot/french_instruct) | MIT déclarée, mais agrège des sources aux licences propres (ci-dessous) |

MiniChat a écarté de French Instruct les sources Logic Inference, Evol Instruct, Grade School Math et le style « human ».
Restent, avec leur licence :

| Source dans French Instruct | Licence |
|---|---|
| Human ChatGPT Comparison Corpus (HC3) | CC BY-SA 4.0 |
| Stanford Alpaca | **CC BY-NC 4.0** |
| WikiHow FR (multilingual-wikihow-qa-16k) | **CC BY-NC 3.0** |
| Dolly | CC BY-SA 3.0 |
| ShareGPT FR (ShareGPT52K) | CC0 |
| LIMA | **CC BY-NC-SA** (ou la licence plus stricte de ses sources) |
| Aya Dataset FR | Apache 2.0 |
| Open Assistant (oasst1) | Apache 2.0 |
| ENS Sup Dataset | Apache 2.0 |
| GT Doremiti Instructions | CC BY 4.0 |

Le filtre « style human » ne dit pas si toutes les conversations WikiHow ont été écartées : par prudence, elles sont comptées.

### Ce qui en découle

- **Usage non commercial** : Stanford Alpaca, WikiHow et LIMA sont sous licence NC. Les poids sont donc proposés
  sous **CC BY-NC-SA 4.0** (non commercial, attribution, partage dans les mêmes conditions, ce qui couvre aussi
  le BY-SA de Wikipédia, HC3 et Dolly).
- **Attribution** : citer les sources ci-dessus en redistribuant le modèle.
- Une partie des dialogues a été générée ou traduite par ChatGPT ; les conditions d'OpenAI visent ceux qui ont produit ces textes.
- La licence MIT du dépôt couvre le **code** seulement, pas ce modèle.

## Limites

- **Très petit modèle** (28 M de paramètres, 256 tokens de contexte) : il oublie vite la conversation et se répète.
- **Il invente des faits**, avec assurance. Exemple réel : « Et celle de l'Italie ? » → « La capitale de la France est Paris. »
  Ne jamais s'y fier pour une information.
- **Français seulement** : les autres langues donnent du texte incohérent ; les caractères absents de son alphabet (emoji…) sont ignorés.
- Il reprend les tournures et biais de ses données (Wikipédia, web, réponses de type ChatGPT : « En tant qu'IA… »).
- Pas d'alignement de sécurité : il peut produire du texte faux, inapproprié ou blessant.

## Usage prévu

Apprentissage et démonstration : voir comment marche un petit modèle génératif, en local, sur CPU. Pas pour la production,
le conseil (médical, juridique…) ni un usage commercial.
