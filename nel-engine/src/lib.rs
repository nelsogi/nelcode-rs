//! nel-engine : charge un `.nelmodel` (version 2, voir NELMODEL-FORMAT.md) et le fait parler avec Candle, sur CPU,
//! ou sur GPU NVIDIA avec la feature `cuda` (voir `gpu`).

pub mod gpu;
mod model;
mod tokenizer;

use std::io::Read;
use std::path::Path;

pub use candle_core::Device;
pub use model::{Config, KvCache, MiniGpt};
pub use tokenizer::Tokenizer;

pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn err(msg: impl Into<String>) -> Error {
    msg.into().into()
}

/// Dernière version du format que l'on sait lire.
pub const FORMAT_VERSION: u64 = 2;
/// Longueur maximale d'une réponse, en tokens (et place gardée pour elle dans le prompt).
pub const MAX_ANSWER_TOKENS: usize = 80;

/// Lit un fichier à la racine de l'archive `.nelmodel`.
pub fn read_entry(path: &Path, name: &str) -> Result<Vec<u8>> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path)?).map_err(|e| err(format!("{} : zip invalide ({e})", path.display())))?;
    let mut file = zip.by_name(name).map_err(|_| err(format!("{name} manque dans {}", path.display())))?;
    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[derive(Clone, Debug)]
pub struct Sampling {
    /// ≤ 0 : glouton (le token de logit maximal).
    pub temperature: f32,
    /// 0 : pas de limite.
    pub top_k: usize,
    /// 1 : pas de limite.
    pub top_p: f32,
    /// Pénalité de répétition (`apply_repetition_penalty`) sur les `REPETITION_WINDOW` derniers tokens. 1 : désactivée.
    pub repetition_penalty: f32,
}

impl Sampling {
    pub const GREEDY: Sampling = Sampling { temperature: 0.0, top_k: 0, top_p: 1.0, repetition_penalty: 1.0 };
}

impl Default for Sampling {
    /// Les réglages par défaut de Nel Code.
    fn default() -> Self {
        Sampling { temperature: 0.8, top_k: 20, top_p: 0.9, repetition_penalty: 1.15 }
    }
}

/// Petit générateur pseudo-aléatoire (splitmix64) : même graine = même texte.
pub struct Rng(pub u64);

impl Rng {
    pub fn next_f32(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        ((z ^ (z >> 31)) >> 40) as f32 / (1u64 << 24) as f32
    }
}

pub fn softmax(logits: &[f32]) -> Vec<f32> {
    let max = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let exp: Vec<f32> = logits.iter().map(|l| (l - max).exp()).collect();
    let sum: f32 = exp.iter().sum();
    exp.into_iter().map(|e| e / sum).collect()
}

/// Comme SampleTopKTopP de MiniChat : softmax(logits / température), puis top-k, puis top-p
/// (un token est gardé tant que ceux avant lui ne font pas encore top_p : le premier l'est toujours).
pub fn sample(logits: &[f32], s: &Sampling, rng: &mut Rng) -> u32 {
    if s.temperature <= 0.0 {
        // Premier maximum, comme argmax.
        return logits.iter().enumerate().fold(0, |best, (i, &l)| if l > logits[best] { i } else { best }) as u32;
    }
    let probs = softmax(&logits.iter().map(|l| l / s.temperature).collect::<Vec<_>>());
    let mut order: Vec<usize> = (0..probs.len()).collect();
    order.sort_by(|&a, &b| probs[b].total_cmp(&probs[a]));
    let mut kept = Vec::new();
    let mut before = 0.0;
    for (rank, &id) in order.iter().enumerate() {
        if (s.top_k > 0 && rank >= s.top_k) || before >= s.top_p {
            break;
        }
        kept.push(id);
        before += probs[id];
    }
    let total: f32 = kept.iter().map(|&i| probs[i]).sum();
    let mut r = rng.next_f32() * total;
    for &id in &kept {
        r -= probs[id];
        if r < 0.0 {
            return id as u32;
        }
    }
    *kept.last().unwrap() as u32
}

/// La pénalité de répétition regarde les tokens de cette fenêtre (prompt compris).
pub const REPETITION_WINDOW: usize = 64;

/// Pénalité de répétition (comme CTRL / Hugging Face) : chaque token présent dans `recent` voit son logit divisé
/// par `penalty` s'il est positif, multiplié s'il est négatif (moins probable dans les deux cas). Une seule fois par
/// token, même s'il revient plusieurs fois. `penalty` = 1 : rien ne change (les logits ne sont pas touchés).
pub fn apply_repetition_penalty(logits: &mut [f32], recent: &[u32], penalty: f32) {
    if penalty == 1.0 || !penalty.is_finite() || penalty <= 0.0 {
        return;
    }
    let mut seen = vec![false; logits.len()];
    for &id in recent {
        let Some(l) = logits.get_mut(id as usize) else { continue };
        if !std::mem::replace(&mut seen[id as usize], true) {
            *l = if *l > 0.0 { *l / penalty } else { *l * penalty };
        }
    }
}

/// Mode transparence : combien de choix sont rendus pour chaque token écrit.
pub const TOP_CHOICES: usize = 5;

/// Les `TOP_CHOICES` tokens les plus probables (id, probabilité), du plus probable au moins probable :
/// softmax(logits / température), avant top-k/top-p. Température ≤ 0 (glouton) : comptée comme 1.
/// `generate_with_choices` les calcule sur les logits après la pénalité de répétition.
pub fn top_choices(logits: &[f32], temperature: f32) -> Vec<(u32, f32)> {
    let t = if temperature > 0.0 { temperature } else { 1.0 };
    let probs = softmax(&logits.iter().map(|l| l / t).collect::<Vec<_>>());
    let mut order: Vec<usize> = (0..probs.len()).collect();
    order.sort_by(|&a, &b| probs[b].total_cmp(&probs[a]));
    order.into_iter().take(TOP_CHOICES).map(|i| (i as u32, probs[i])).collect()
}

pub struct NelModel {
    pub model: MiniGpt,
    pub tokenizer: Tokenizer,
    pub info: serde_json::Value,
}

impl NelModel {
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        Self::load_on(path, &Device::Cpu)
    }

    pub fn load_on(path: impl AsRef<Path>, device: &Device) -> Result<Self> {
        let path = path.as_ref();
        let info: serde_json::Value = serde_json::from_slice(&read_entry(path, "model-info.json")?)?;
        match info["formatVersion"].as_u64() {
            None => return Err(err("model-info.json : formatVersion manque")),
            Some(v) if v > FORMAT_VERSION => return Err(err(format!("format version {v} trop récent : mets nel-engine à jour"))),
            Some(v) if v < 2 => return Err(err("format version 1 : pas de model.safetensors, ré-exporte le modèle")),
            _ => {}
        }
        let config: Config = serde_json::from_slice(&read_entry(path, "config.json")?)?;
        let tokenizer = Tokenizer::from_json(std::str::from_utf8(&read_entry(path, "tokenizer.json")?)?, config.vocab_size)?;
        let weights = candle_core::safetensors::load_buffer(&read_entry(path, "model.safetensors")?, &Device::Cpu)?;
        Ok(Self { model: MiniGpt::new(config, weights, device)?, tokenizer, info })
    }

    /// Les logits après `ids` (un seul passage, sans cache gardé).
    pub fn logits(&self, ids: &[u32]) -> Result<Vec<f32>> {
        Ok(self.model.forward(ids, &mut self.model.new_cache())?.to_vec1()?)
    }

    /// Écrit jusqu'à `max_new` tokens après `prompt`, avec le cache KV. `on_token` reçoit chaque token
    /// (renvoie false pour arrêter). Avec `stop_on_special`, le premier token spécial arrête tout, sans être
    /// donné ni rendu. Rend les tokens écrits.
    pub fn generate(
        &self,
        prompt: &[u32],
        max_new: usize,
        sampling: &Sampling,
        rng: &mut Rng,
        stop_on_special: bool,
        mut on_token: impl FnMut(u32) -> bool,
    ) -> Result<Vec<u32>> {
        let out = self.generate_with_choices(prompt, max_new, sampling, rng, stop_on_special, false, |id, _| on_token(id))?;
        Ok(out.into_iter().map(|(id, _)| id).collect())
    }

    /// Comme `generate`. Avec `transparency`, chaque token écrit vient avec ses `TOP_CHOICES` choix les plus
    /// probables (`top_choices`), donnés à `on_token` et rendus ; sans, la liste est vide.
    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    pub fn generate_with_choices(
        &self,
        prompt: &[u32],
        max_new: usize,
        sampling: &Sampling,
        rng: &mut Rng,
        stop_on_special: bool,
        transparency: bool,
        mut on_token: impl FnMut(u32, &[(u32, f32)]) -> bool,
    ) -> Result<Vec<(u32, Vec<(u32, f32)>)>> {
        let block = self.model.config.block_size;
        let mut ids = prompt.to_vec();
        let mut cache = self.model.new_cache();
        let mut pending = ids.len();
        let mut written = Vec::new();
        for _ in 0..max_new {
            // Contexte plein : comme MiniChat, on repart des 3/4 × BlockSize derniers tokens, positions depuis 0.
            if cache.len + pending > block {
                cache.reset();
                pending = ids.len().min((block * 3 / 4).max(1));
            }
            let mut logits: Vec<f32> = self.model.forward(&ids[ids.len() - pending..], &mut cache)?.to_vec1()?;
            // La pénalité vient avant tout le reste : température, top-k/top-p, et les choix de la transparence.
            apply_repetition_penalty(&mut logits, &ids[ids.len().saturating_sub(REPETITION_WINDOW)..], sampling.repetition_penalty);
            let next = sample(&logits, sampling, rng);
            if stop_on_special && self.tokenizer.is_special(next) {
                break;
            }
            let choices = if transparency { top_choices(&logits, sampling.temperature) } else { Vec::new() };
            ids.push(next);
            pending = 1;
            let go_on = on_token(next, &choices);
            written.push((next, choices));
            if !go_on {
                break;
            }
        }
        Ok(written)
    }

    /// Le prompt de chat (NELMODEL-FORMAT.md, « Le prompt de chat ») : `<|doc|>`, les tours précédents qui
    /// tiennent (du plus récent au plus ancien, jamais coupés), puis le message.
    pub fn chat_prompt(&self, history: &[(String, String)], message: &str) -> Vec<u32> {
        let t = &self.tokenizer;
        let doc = t.encode("<|doc|>");
        let msg = t.encode(&format!("<|user|>{}<|end|><|assistant|>", message.trim()));
        let budget = self.model.config.block_size.saturating_sub(MAX_ANSWER_TOKENS);
        let mut used = doc.len() + msg.len();
        let mut turns = Vec::new();
        for (q, a) in history.iter().rev() {
            let ids = t.encode(&format!("<|user|>{}<|end|><|assistant|>{}<|end|>", q.trim(), a.trim()));
            if used + ids.len() > budget {
                break;
            }
            used += ids.len();
            turns.push(ids);
        }
        doc.into_iter().chain(turns.into_iter().rev().flatten()).chain(msg).collect()
    }
}
