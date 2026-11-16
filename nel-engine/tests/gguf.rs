//! Modèles GGUF. Modèle : variable GGUF, sinon test-models/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf (absent : tests
//! ignorés). Le tokenizer.json officiel de Qwen2.5-Coder (test-models/qwen-tokenizer.json), s'il est là, sert de référence
//! au tokenizer reconstruit depuis le .gguf.

use std::path::PathBuf;
use std::sync::OnceLock;

use nel_engine::gguf::{ChatFormat, GgufModel, inspect};
use nel_engine::{ChatModel, Device, Rng, Sampling};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-models")
}

fn path() -> PathBuf {
    std::env::var_os("GGUF").map(PathBuf::from).unwrap_or_else(|| dir().join("qwen2.5-coder-0.5b-instruct-q4_k_m.gguf"))
}

fn model() -> Option<&'static GgufModel> {
    static M: OnceLock<Option<GgufModel>> = OnceLock::new();
    M.get_or_init(|| {
        if !path().is_file() {
            eprintln!("{} absent : tests GGUF ignorés", path().display());
            return None;
        }
        Some(GgufModel::load(&path(), &Device::Cpu, 8192).expect("chargement du .gguf"))
    })
    .as_ref()
}

#[test]
fn formats_de_chat() {
    let qwen = "{{- '<|im_start|>system\\nYou are Qwen, created by Alibaba Cloud. You are a helpful assistant.<|im_end|>\\n' }}";
    assert_eq!(
        ChatFormat::detect(Some(qwen), |_| false).unwrap(),
        ChatFormat::ChatMl { system: Some("You are Qwen, created by Alibaba Cloud. You are a helpful assistant.".into()) }
    );
    assert_eq!(ChatFormat::detect(Some("{{ '<|im_start|>' + m.role }}"), |_| false).unwrap(), ChatFormat::ChatMl { system: None });
    assert_eq!(ChatFormat::detect(Some("<|start_header_id|>"), |_| false).unwrap(), ChatFormat::Llama3);
    assert_eq!(ChatFormat::detect(None, |t| t == "<|im_start|>").unwrap(), ChatFormat::ChatMl { system: None });
    assert!(ChatFormat::detect(Some("[INST]"), |_| false).is_err());
}

#[test]
fn infos_du_gguf() {
    if model().is_none() {
        return;
    }
    let i = inspect(&path()).unwrap();
    assert_eq!((i.architecture.as_str(), i.chat_format.as_str(), i.context_length), ("qwen2", "ChatML", 32768));
    assert!((400_000_000..700_000_000).contains(&i.parameters), "{}", i.parameters);
    assert!(inspect(&dir().join("minichat-v3b.nelmodel")).is_err());
}

#[test]
fn tokenizer_identique_au_tokenizer_json() {
    let Some(m) = model() else { return };
    let official = dir().join("qwen-tokenizer.json");
    if !official.is_file() {
        return eprintln!("{} absent : comparaison ignorée", official.display());
    }
    let reference = tokenizers::Tokenizer::from_file(official).unwrap();
    let texts = [
        "Bonjour, ça va ? L'été est là… 2026 !",
        "fn main() {\n    println!(\"{}\", 1 + 22 + 333);\n}\n\n\n",
        "def add(a, b):\n\treturn a+b  # somme\r\n",
        "<|im_start|>user\nSalut<|im_end|>\n<|im_start|>assistant\n",
        "émoji 🦀 中文 العربية   espaces   \u{00e9}",
        "const x = {\"key\": [1, 2.5, -3e10]};",
    ];
    for t in texts {
        let want = reference.encode_fast(t, false).unwrap().get_ids().to_vec();
        assert_eq!(m.encode(t), want, "{t:?}");
        assert_eq!(m.decode(&want), t);
    }
}

#[test]
fn prompt_de_chat_qwen() {
    let Some(m) = model() else { return };
    let (ids, kept) = m.chat(&[("Salut".into(), "Bonjour !".into())], "  Et toi ?  ");
    assert_eq!(kept, 1);
    assert_eq!(
        m.decode(&ids),
        "<|im_start|>system\nYou are Qwen, created by Alibaba Cloud. You are a helpful assistant.<|im_end|>\n\
         <|im_start|>user\nSalut<|im_end|>\n<|im_start|>assistant\nBonjour !<|im_end|>\n\
         <|im_start|>user\nEt toi ?<|im_end|>\n<|im_start|>assistant\n"
    );
    assert_eq!(m.context_size(), 8192);
    // Un contexte limité : les anciens tours ne tiennent plus.
    let small = GgufModel::load(&path(), &Device::Cpu, 300).unwrap();
    assert_eq!(small.context_size(), 300);
    let long = "mot ".repeat(100);
    let history = vec![(long.clone(), long.clone()); 3];
    let (ids, kept) = small.chat(&history, "Et toi ?");
    assert_eq!(kept, 0);
    assert!(ids.len() < 300);
}

#[test]
fn reponse_gloutonne_qui_s_arrete() {
    let Some(m) = model() else { return };
    let (prompt, _) = m.chat(&[], "Write a Python function add(a, b) that returns a + b. Only the code.");
    let mut seen = 0;
    let out = m.stream(&prompt, 200, &Sampling::GREEDY, &mut Rng(0), true, true, &mut |_, c| {
        seen += 1;
        c.len() == 5
    });
    let out = out.unwrap();
    let text = m.decode(&out.iter().map(|(id, _)| *id).collect::<Vec<_>>());
    assert!(text.contains("def add(a, b)"), "{text}");
    assert!(out.len() < 200, "la réponse s'arrête au token de fin de tour");
    assert!(!text.contains("<|im_end|>"));
    assert_eq!(seen, out.len());
    // Même graine, mêmes réglages : même texte ; la pénalité de répétition change la suite.
    let again = m.stream(&prompt, 20, &Sampling::GREEDY, &mut Rng(0), true, false, &mut |_, _| true).unwrap();
    assert_eq!(again, out.iter().take(20).map(|(id, _)| (*id, vec![])).collect::<Vec<_>>());
    let sampled = Sampling { temperature: 0.7, top_k: 20, top_p: 0.9, repetition_penalty: 1.1 };
    let a = m.stream(&prompt, 30, &sampled, &mut Rng(7), true, false, &mut |_, _| true).unwrap();
    let b = m.stream(&prompt, 30, &sampled, &mut Rng(7), true, false, &mut |_, _| true).unwrap();
    assert_eq!(a, b);
}

#[test]
fn contexte_plein() {
    // Le prompt passe par morceaux, et au-delà du contexte la génération repart des 3/4 : pas d'erreur.
    let Some(_) = model() else { return };
    let m = GgufModel::load(&path(), &Device::Cpu, 1100).unwrap();
    let prompt = m.encode(&"une phrase de remplissage, ".repeat(300))[..1095].to_vec();
    let out = m.stream(&prompt, 10, &Sampling::GREEDY, &mut Rng(0), false, false, &mut |_, _| true).unwrap();
    assert_eq!(out.len(), 10);
}
