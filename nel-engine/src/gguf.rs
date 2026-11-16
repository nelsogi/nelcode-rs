//! Modèles ouverts au format GGUF (llama.cpp), quantifiés, avec Candle : architectures Qwen2 et Llama.
//! Le tokenizer Hugging Face est reconstruit à partir des métadonnées du fichier (BPE « gpt2 » : Qwen2, Llama 3),
//! ou lu dans un `tokenizer.json` posé à côté. Le format de chat vient du modèle (`tokenizer.chat_template`).

use std::collections::HashSet;
use std::fs::File;
use std::path::Path;
use std::sync::Mutex;

use candle_core::quantized::gguf_file::{Content, Value};
use candle_core::{DType, Device, Tensor};
use candle_transformers::models::{quantized_llama, quantized_qwen2};
use serde_json::json;
use tokenizers::Tokenizer;

use crate::{ChatModel, Result, Rng, Sampling, err, generate_loop};

/// Les réponses d'un modèle GGUF : jusqu'à 1024 tokens (le modèle s'arrête de lui-même bien avant, d'habitude).
pub const MAX_REPLY: usize = 1024;
/// Le prompt passe par morceaux de cette taille (l'attention d'un prompt de 8 000 tokens d'un coup ne tiendrait pas en mémoire).
const PREFILL_CHUNK: usize = 512;

/// Les deux formats de chat reconnus dans `tokenizer.chat_template`.
#[derive(Clone, Debug, PartialEq)]
pub enum ChatFormat {
    /// `<|im_start|>user …<|im_end|>` (Qwen), avec le message système par défaut du modèle s'il en a un.
    ChatMl { system: Option<String> },
    /// `<|start_header_id|>user<|end_header_id|> …<|eot_id|>` (Llama 3).
    Llama3,
}

impl ChatFormat {
    pub fn label(&self) -> &'static str {
        match self {
            ChatFormat::ChatMl { .. } => "ChatML",
            ChatFormat::Llama3 => "Llama 3",
        }
    }

    pub fn detect(template: Option<&str>, has_token: impl Fn(&str) -> bool) -> Result<Self> {
        let t = template.unwrap_or_default();
        if t.contains("<|start_header_id|>") || (template.is_none() && has_token("<|start_header_id|>")) {
            return Ok(ChatFormat::Llama3);
        }
        if t.contains("<|im_start|>") || (template.is_none() && has_token("<|im_start|>")) {
            // Le message système par défaut, écrit en dur dans le modèle (Qwen2.5 : « You are Qwen… »).
            let re = regex::Regex::new(r"<\|im_start\|>system\\n([^'\x22<{]+)<\|im_end\|>").unwrap();
            let system = re.captures(t).map(|c| c[1].to_string());
            return Ok(ChatFormat::ChatMl { system });
        }
        Err(err("format de chat inconnu (seulement ChatML et Llama 3)"))
    }

    fn head(&self) -> String {
        match self {
            ChatFormat::ChatMl { system: Some(s) } => format!("<|im_start|>system\n{s}<|im_end|>\n"),
            ChatFormat::ChatMl { system: None } => String::new(),
            ChatFormat::Llama3 => "<|begin_of_text|>".into(),
        }
    }

    fn turn(&self, q: &str, a: &str) -> String {
        match self {
            ChatFormat::ChatMl { .. } => format!("<|im_start|>user\n{q}<|im_end|>\n<|im_start|>assistant\n{a}<|im_end|>\n"),
            ChatFormat::Llama3 => format!(
                "<|start_header_id|>user<|end_header_id|>\n\n{q}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n{a}<|eot_id|>"
            ),
        }
    }

    fn ask(&self, q: &str) -> String {
        match self {
            ChatFormat::ChatMl { .. } => format!("<|im_start|>user\n{q}<|im_end|>\n<|im_start|>assistant\n"),
            ChatFormat::Llama3 => format!("<|start_header_id|>user<|end_header_id|>\n\n{q}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n"),
        }
    }
}

/// Ce qu'on lit dans l'en-tête d'un .gguf, sans charger les poids.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GgufInfo {
    pub name: Option<String>,
    pub architecture: String,
    pub parameters: u64,
    /// Le contexte d'entraînement du modèle (avant la limite de Nel Code).
    pub context_length: usize,
    pub license: Option<String>,
    pub chat_format: String,
    pub tokenizer: String,
}

enum Weights {
    Qwen2(quantized_qwen2::ModelWeights),
    Llama(quantized_llama::ModelWeights),
}

impl Weights {
    fn forward(&mut self, x: &Tensor, pos: usize) -> candle_core::Result<Tensor> {
        match self {
            Weights::Qwen2(m) => m.forward(x, pos),
            Weights::Llama(m) => m.forward(x, pos),
        }
    }
}

pub struct GgufModel {
    weights: Mutex<Weights>,
    pub tokenizer: Tokenizer,
    pub info: GgufInfo,
    format: ChatFormat,
    /// Les tokens spéciaux (fin de tour, fin de texte…) : le premier écrit arrête la réponse.
    special: HashSet<u32>,
    context: usize,
    device: Device,
}

fn md<'a>(c: &'a Content, key: &str) -> Result<&'a Value> {
    c.metadata.get(key).ok_or_else(|| err(format!("métadonnée {key} absente du .gguf")))
}

fn md_str(c: &Content, key: &str) -> Option<String> {
    c.metadata.get(key).and_then(|v| v.to_string().ok()).cloned()
}

/// Les expressions de pré-découpage de llama.cpp (`tokenizer.ggml.pre`), les mêmes que dans les tokenizer.json.
fn pre_regex(pre: &str) -> Option<&'static str> {
    match pre {
        "qwen2" => Some(r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+"),
        "llama3" | "llama-bpe" | "smaug-bpe" => {
            Some(r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+")
        }
        _ => None,
    }
}

/// Le tokenizer Hugging Face du modèle : `tokenizer.json` à côté du .gguf, sinon reconstruit depuis les métadonnées
/// (BPE au niveau des octets, comme le tokenizer.json d'origine de Qwen2 ou de Llama 3).
fn tokenizer_of(c: &Content, beside: Option<&Path>) -> Result<(Tokenizer, &'static str)> {
    if let Some(path) = beside.filter(|p| p.is_file()) {
        return Ok((Tokenizer::from_file(path).map_err(|e| err(format!("tokenizer.json : {e}")))?, "tokenizer.json"));
    }
    let model = md_str(c, "tokenizer.ggml.model").unwrap_or_default();
    if model != "gpt2" {
        return Err(err(format!("tokenizer « {model} » : pose son tokenizer.json à côté du .gguf")));
    }
    let pre = md_str(c, "tokenizer.ggml.pre").unwrap_or_default();
    let regex = pre_regex(&pre).ok_or_else(|| err(format!("pré-découpage « {pre} » inconnu : pose le tokenizer.json du modèle à côté du .gguf")))?;
    let strings = |key: &str| -> Result<Vec<String>> {
        md(c, key)?.to_vec()?.iter().map(|v| Ok(v.to_string()?.clone())).collect()
    };
    let tokens = strings("tokenizer.ggml.tokens")?;
    let merges = strings("tokenizer.ggml.merges")?;
    // Type 3 : token de contrôle (spécial) ; 4 : ajouté par l'utilisateur. Sans types : aucun.
    let types: Vec<i64> = c
        .metadata
        .get("tokenizer.ggml.token_type")
        .and_then(|v| v.to_vec().ok())
        .map(|v| v.iter().map(|t| t.to_i32().map(i64::from).unwrap_or(1)).collect())
        .unwrap_or_default();
    let added: Vec<_> = tokens
        .iter()
        .enumerate()
        .filter(|(i, _)| matches!(types.get(*i), Some(3 | 4)))
        .map(|(i, t)| json!({ "id": i, "content": t, "single_word": false, "lstrip": false, "rstrip": false, "normalized": false, "special": types[i] == 3 }))
        .collect();
    let vocab: serde_json::Map<String, serde_json::Value> = tokens.iter().enumerate().map(|(i, t)| (t.clone(), i.into())).collect();
    let byte_level = json!({ "type": "ByteLevel", "add_prefix_space": false, "trim_offsets": false, "use_regex": false });
    let spec = json!({
        "version": "1.0",
        "added_tokens": added,
        "normalizer": { "type": "NFC" },
        "pre_tokenizer": { "type": "Sequence", "pretokenizers": [
            { "type": "Split", "pattern": { "Regex": regex }, "behavior": "Isolated", "invert": false }, byte_level,
        ] },
        "post_processor": byte_level,
        "decoder": byte_level,
        "model": { "type": "BPE", "vocab": vocab, "merges": merges, "dropout": null, "unk_token": null,
            "continuing_subword_prefix": null, "end_of_word_suffix": null, "fuse_unk": false, "byte_fallback": false, "ignore_merges": false },
    });
    let tok = spec.to_string().parse::<Tokenizer>().map_err(|e| err(format!("tokenizer du .gguf : {e}")))?;
    Ok((tok, "métadonnées du .gguf"))
}

fn read_content(path: &Path) -> Result<(Content, File)> {
    let mut file = File::open(path).map_err(|e| err(format!("{} : {e}", path.display())))?;
    let content = Content::read(&mut file).map_err(|e| err(format!("ce n'est pas un .gguf valide ({e})")))?;
    Ok((content, file))
}

fn inspect_content(c: &Content, beside: Option<&Path>) -> Result<(GgufInfo, Tokenizer, ChatFormat)> {
    let architecture = md_str(c, "general.architecture").unwrap_or_default();
    if architecture != "qwen2" && architecture != "llama" {
        return Err(err(format!("architecture « {architecture} » non prise en charge (seulement qwen2 et llama)")));
    }
    let context_length = md(c, &format!("{architecture}.context_length"))?.to_u32()? as usize;
    let (tokenizer, source) = tokenizer_of(c, beside)?;
    let template = md_str(c, "tokenizer.chat_template");
    let format = ChatFormat::detect(template.as_deref(), |t| tokenizer.token_to_id(t).is_some())?;
    let info = GgufInfo {
        name: md_str(c, "general.name"),
        parameters: c.tensor_infos.values().map(|t| t.shape.elem_count() as u64).sum(),
        context_length,
        license: md_str(c, "general.license"),
        chat_format: format.label().into(),
        tokenizer: source.into(),
        architecture,
    };
    Ok((info, tokenizer, format))
}

/// Les infos d'un .gguf (en-tête, tokenizer, format de chat vérifiés), sans charger les poids.
pub fn inspect(path: &Path) -> Result<GgufInfo> {
    let (c, _) = read_content(path)?;
    Ok(inspect_content(&c, path.parent().map(|d| d.join("tokenizer.json")).as_deref())?.0)
}

impl GgufModel {
    /// Charge `path` sur `device`. Le contexte est le plus petit de celui du modèle et de `context_limit`
    /// (et 4096 pour Llama, la taille des tables RoPE de Candle).
    pub fn load(path: &Path, device: &Device, context_limit: usize) -> Result<Self> {
        let (c, mut file) = read_content(path)?;
        let (info, tokenizer, format) = inspect_content(&c, path.parent().map(|d| d.join("tokenizer.json")).as_deref())?;
        let mut context = info.context_length.min(context_limit.max(256));
        let weights = if info.architecture == "qwen2" {
            Weights::Qwen2(quantized_qwen2::ModelWeights::from_gguf(c, &mut file, device)?)
        } else {
            context = context.min(quantized_llama::MAX_SEQ_LEN);
            Weights::Llama(quantized_llama::ModelWeights::from_gguf(c, &mut file, device)?)
        };
        let special = tokenizer.get_added_tokens_decoder().into_iter().filter(|(_, t)| t.special).map(|(id, _)| id).collect();
        Ok(Self { weights: Mutex::new(weights), tokenizer, info, format, special, context, device: device.clone() })
    }

    pub fn encode(&self, text: &str) -> Vec<u32> {
        self.tokenizer.encode_fast(text, false).map(|e| e.get_ids().to_vec()).unwrap_or_default()
    }

    pub fn is_special(&self, id: u32) -> bool {
        self.special.contains(&id)
    }

    pub fn device(&self) -> &Device {
        &self.device
    }
}

impl ChatModel for GgufModel {
    fn context_size(&self) -> usize {
        self.context
    }

    fn parameters(&self) -> Option<u64> {
        Some(self.info.parameters)
    }

    fn max_reply(&self, _setting: usize) -> usize {
        MAX_REPLY.min(self.context / 2)
    }

    fn chat(&self, history: &[(String, String)], message: &str) -> (Vec<u32>, usize) {
        let f = &self.format;
        let head = self.encode(&f.head());
        let ask = self.encode(&f.ask(message.trim()));
        let budget = self.context.saturating_sub(self.max_reply(0));
        let mut used = head.len() + ask.len();
        let mut turns = Vec::new();
        for (q, a) in history.iter().rev() {
            let ids = self.encode(&f.turn(q.trim(), a.trim()));
            if used + ids.len() > budget {
                break;
            }
            used += ids.len();
            turns.push(ids);
        }
        let kept = turns.len();
        (head.into_iter().chain(turns.into_iter().rev().flatten()).chain(ask).collect(), kept)
    }

    fn decode(&self, ids: &[u32]) -> String {
        self.tokenizer.decode(ids, false).unwrap_or_default()
    }

    fn stream(
        &self,
        prompt: &[u32],
        max_new: usize,
        sampling: &Sampling,
        rng: &mut Rng,
        stop_on_special: bool,
        transparency: bool,
        on_token: &mut dyn FnMut(u32, &[(u32, f32)]) -> bool,
    ) -> Result<Vec<(u32, Vec<(u32, f32)>)>> {
        let mut weights = self.weights.lock().unwrap();
        let forward = |ids: &[u32], pos: usize| -> Result<Vec<f32>> {
            let mut logits = None;
            for (k, chunk) in ids.chunks(PREFILL_CHUNK).enumerate() {
                let x = Tensor::new(chunk, &self.device)?.unsqueeze(0)?;
                logits = Some(weights.forward(&x, pos + k * PREFILL_CHUNK)?);
            }
            Ok(logits.ok_or_else(|| err("prompt vide"))?.squeeze(0)?.to_dtype(DType::F32)?.to_vec1()?)
        };
        let stop = |id| stop_on_special && self.is_special(id);
        generate_loop(prompt, max_new, self.context, sampling, rng, transparency, stop, forward, on_token)
    }
}
