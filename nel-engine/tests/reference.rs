//! Compare nel-engine avec le reference.json du .nelmodel (calculé par MiniChat).
//! Modèle : variable NELMODEL, sinon test-models/minichat-v3b.nelmodel.

use std::path::PathBuf;
use std::sync::OnceLock;

use nel_engine::{NelModel, Rng, Sampling, read_entry, sample, softmax};
use serde_json::Value;

fn path() -> PathBuf {
    std::env::var_os("NELMODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-models/minichat-v3b.nelmodel"))
}

fn model() -> &'static NelModel {
    static M: OnceLock<NelModel> = OnceLock::new();
    M.get_or_init(|| NelModel::load(path()).expect("chargement du modèle"))
}

fn reference() -> Value {
    serde_json::from_slice(&read_entry(&path(), "reference.json").unwrap()).unwrap()
}

fn ids(v: &Value) -> Vec<u32> {
    v.as_array().unwrap().iter().map(|i| i.as_u64().unwrap() as u32).collect()
}

#[test]
fn tokenizer_ids_identiques() {
    let t = &model().tokenizer;
    for case in reference()["texts"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let expected = ids(&case["ids"]);
        assert_eq!(t.encode(text), expected, "texte {text:?}");
        let tokens: Vec<String> = expected.iter().map(|&id| t.decode(&[id])).collect();
        let ref_tokens: Vec<&str> = case["tokens"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
        assert_eq!(tokens, ref_tokens, "texte {text:?}");
    }
}

#[test]
fn prompts_de_chat() {
    let m = model();
    for case in reference()["chat"].as_array().unwrap() {
        let expected = ids(&case["promptIds"]);
        assert_eq!(m.tokenizer.encode(case["prompt"].as_str().unwrap()), expected);
        assert_eq!(m.chat_prompt(&[], case["message"].as_str().unwrap()), expected);
    }
}

#[test]
fn probabilites_a_1e4() {
    let m = model();
    for case in reference()["chat"].as_array().unwrap() {
        let probs = softmax(&m.logits(&ids(&case["promptIds"])).unwrap());
        let mut order: Vec<usize> = (0..probs.len()).collect();
        order.sort_by(|&a, &b| probs[b].total_cmp(&probs[a]));
        for (rank, top) in case["topTokens"].as_array().unwrap().iter().enumerate() {
            let id = top["id"].as_u64().unwrap() as usize;
            let p = top["probability"].as_f64().unwrap() as f32;
            assert_eq!(order[rank], id, "{} : rang {rank}", case["message"]);
            assert!((probs[id] - p).abs() < 1e-4, "{} : token {id}, {} au lieu de {p}", case["message"], probs[id]);
        }
    }
}

#[test]
fn trente_tokens_gloutons_avec_cache_kv() {
    let m = model();
    for case in reference()["chat"].as_array().unwrap() {
        let out = m.generate(&ids(&case["promptIds"]), 30, &Sampling::GREEDY, &mut Rng(0), false, |_| true).unwrap();
        assert_eq!(out, ids(&case["greedyIds"]), "{}", case["message"]);
        assert_eq!(m.tokenizer.decode(&out), case["greedyText"].as_str().unwrap());
    }
}

#[test]
fn top_k_top_p() {
    // a 60 %, b 25 %, c 10 %, d 5 % ; top-k 3 et top-p 0.9 gardent a, b, c ; top-p 0.5 ne garde que a.
    let logits: Vec<f32> = [0.60f32, 0.25, 0.10, 0.05].iter().map(|p| p.ln()).collect();
    let mut rng = Rng(42);
    let wide = Sampling { temperature: 1.0, top_k: 3, top_p: 0.9 };
    let seen: Vec<u32> = (0..2000).map(|_| sample(&logits, &wide, &mut rng)).collect();
    assert!(!seen.contains(&3) && seen.contains(&2));
    let narrow = Sampling { temperature: 1.0, top_k: 0, top_p: 0.5 };
    assert!((0..200).all(|_| sample(&logits, &narrow, &mut rng) == 0));
}

#[test]
fn depasse_block_size() {
    // Le contexte plein repart des 3/4 × BlockSize derniers tokens : la génération continue sans erreur.
    let m = model();
    let block = m.model.config.block_size;
    let prompt = m.tokenizer.encode(&"Bonjour, comment vas-tu ? ".repeat(60))[..block - 5].to_vec();
    let out = m.generate(&prompt, 20, &Sampling::GREEDY, &mut Rng(0), false, |_| true).unwrap();
    assert_eq!(out.len(), 20);
}
