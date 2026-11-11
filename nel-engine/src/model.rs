//! MiniGpt « Modern » (NELMODEL-FORMAT.md, « Le réseau ») : RMSNorm, RoPE, attention causale, SwiGLU,
//! weight tying. Avec cache KV.

use std::collections::HashMap;

use candle_core::{DType, Device, Tensor};
use candle_nn::ops::{rms_norm, softmax_last_dim};
use candle_nn::rotary_emb::rope;
use serde::Deserialize;

use crate::{Result, err};

const EPS: f32 = 1e-5;
const THETA: f64 = 10_000.0;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "PascalCase")]
pub struct Config {
    pub vocab_size: usize,
    pub block_size: usize,
    pub embed_dim: usize,
    pub heads: usize,
    pub layers: usize,
    #[serde(default)]
    pub architecture: Option<String>,
}

impl Config {
    pub fn swiglu_hidden(&self) -> usize {
        (8 * self.embed_dim / 3 + 63) / 64 * 64
    }
}

struct Block {
    norm1: Tensor,
    qkv: Tensor,
    proj: Tensor,
    norm2: Tensor,
    gate: Tensor,
    up: Tensor,
    down: Tensor,
}

pub struct MiniGpt {
    pub config: Config,
    emb: Tensor,
    blocks: Vec<Block>,
    final_norm: Tensor,
    cos: Tensor, // [BlockSize, HeadDim/2]
    sin: Tensor,
}

/// Les K et V déjà calculés, par bloc ([1, H, len, HeadDim]).
pub struct KvCache {
    kv: Vec<Option<(Tensor, Tensor)>>,
    pub len: usize,
}

impl KvCache {
    pub fn reset(&mut self) {
        self.kv.iter_mut().for_each(|e| *e = None);
        self.len = 0;
    }
}

fn linear(x: &Tensor, w: &Tensor) -> candle_core::Result<Tensor> {
    x.matmul(&w.t()?)
}

impl MiniGpt {
    /// Chargement strict : un poids manquant, en trop ou de mauvaise forme est une erreur.
    pub fn new(config: Config, mut w: HashMap<String, Tensor>) -> Result<Self> {
        let arch = config.architecture.as_deref().unwrap_or("Classic");
        if arch != "Modern" {
            return Err(err(format!("architecture « {arch} » non prise en charge (seulement Modern)")));
        }
        let (v, d, hid) = (config.vocab_size, config.embed_dim, config.swiglu_hidden());
        if d % config.heads != 0 {
            return Err(err("EmbedDim n'est pas divisible par Heads"));
        }
        let mut take = |name: String, shape: &[usize]| -> Result<Tensor> {
            let t = w.remove(&name).ok_or_else(|| err(format!("poids manquant : {name}")))?;
            if t.dims() != shape || t.dtype() != DType::F32 {
                return Err(err(format!("{name} : {:?} {:?}, attendu F32 {shape:?}", t.dtype(), t.dims())));
            }
            Ok(t)
        };
        let emb = take("_tokenEmbedding.weight".into(), &[v, d])?;
        let blocks = (0..config.layers)
            .map(|n| {
                let p = format!("_blocks.{n}.");
                Ok(Block {
                    norm1: take(format!("{p}_norm1.weight"), &[d])?,
                    qkv: take(format!("{p}_attention._qkv.weight"), &[3 * d, d])?,
                    proj: take(format!("{p}_attention._projection.weight"), &[d, d])?,
                    norm2: take(format!("{p}_norm2.weight"), &[d])?,
                    gate: take(format!("{p}_feedForward._gate.weight"), &[hid, d])?,
                    up: take(format!("{p}_feedForward._up.weight"), &[hid, d])?,
                    down: take(format!("{p}_feedForward._down.weight"), &[d, hid])?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let final_norm = take("_finalNorm.weight".into(), &[d])?;
        if let Some(extra) = w.keys().next() {
            return Err(err(format!("poids en trop : {extra}")));
        }

        // Comme Rope.cs de MiniChat : vitesse_i = exp(2i × (-ln θ / D)), angle = p × vitesse_i, en f32.
        let hd = d / config.heads;
        let k = (-THETA.ln() / hd as f64) as f32;
        let speeds: Vec<f32> = (0..hd / 2).map(|i| (2.0 * i as f32 * k).exp()).collect();
        let angles: Vec<f32> = (0..config.block_size).flat_map(|p| speeds.iter().map(move |s| p as f32 * s)).collect();
        let shape = (config.block_size, hd / 2);
        let cos = Tensor::from_vec(angles.iter().map(|a| a.cos()).collect::<Vec<_>>(), shape, &Device::Cpu)?;
        let sin = Tensor::from_vec(angles.iter().map(|a| a.sin()).collect::<Vec<_>>(), shape, &Device::Cpu)?;

        Ok(Self { config, emb, blocks, final_norm, cos, sin })
    }

    pub fn new_cache(&self) -> KvCache {
        KvCache { kv: vec![None; self.config.layers], len: 0 }
    }

    /// Fait passer `ids` après ce qui est déjà dans `cache` ; rend les logits de la dernière position ([V]).
    pub fn forward(&self, ids: &[u32], cache: &mut KvCache) -> Result<Tensor> {
        let (t, start) = (ids.len(), cache.len);
        if t == 0 || start + t > self.config.block_size {
            return Err(err(format!("contexte de {} tokens (max {})", start + t, self.config.block_size)));
        }
        let (d, h) = (self.config.embed_dim, self.config.heads);
        let hd = d / h;
        let cos = self.cos.narrow(0, start, t)?.contiguous()?;
        let sin = self.sin.narrow(0, start, t)?.contiguous()?;
        let total = start + t;
        let mask = (t > 1)
            .then(|| {
                let m: Vec<f32> =
                    (0..t).flat_map(|i| (0..total).map(move |j| if j <= start + i { 0.0 } else { f32::NEG_INFINITY })).collect();
                Tensor::from_vec(m, (t, total), &Device::Cpu)
            })
            .transpose()?;

        let mut x = self.emb.index_select(&Tensor::new(ids, &Device::Cpu)?, 0)?; // [t, d]
        for (b, slot) in self.blocks.iter().zip(cache.kv.iter_mut()) {
            // Attention
            let qkv = linear(&rms_norm(&x, &b.norm1, EPS)?, &b.qkv)?; // [t, 3d]
            let heads = |i: usize| qkv.narrow(1, i * d, d)?.reshape((t, h, hd))?.transpose(0, 1)?.contiguous()?.unsqueeze(0);
            let q = rope(&heads(0)?, &cos, &sin)?;
            let mut k = rope(&heads(1)?, &cos, &sin)?;
            let mut v = heads(2)?;
            if let Some((pk, pv)) = slot.take() {
                k = Tensor::cat(&[&pk, &k], 2)?;
                v = Tensor::cat(&[&pv, &v], 2)?;
            }
            let mut att = (q.matmul(&k.t()?)? / (hd as f64).sqrt())?; // [1, h, t, total]
            if let Some(m) = &mask {
                att = att.broadcast_add(m)?;
            }
            let y = softmax_last_dim(&att)?.matmul(&v)?; // [1, h, t, hd]
            *slot = Some((k, v));
            let y = y.squeeze(0)?.transpose(0, 1)?.reshape((t, d))?;
            x = (x + linear(&y, &b.proj)?)?;

            // SwiGLU
            let n = rms_norm(&x, &b.norm2, EPS)?;
            let f = (linear(&n, &b.gate)?.silu()? * linear(&n, &b.up)?)?;
            x = (x + linear(&f, &b.down)?)?;
        }
        cache.len = total;
        let last = x.narrow(0, t - 1, 1)?;
        Ok(linear(&rms_norm(&last, &self.final_norm, EPS)?, &self.emb)?.squeeze(0)?)
    }
}
