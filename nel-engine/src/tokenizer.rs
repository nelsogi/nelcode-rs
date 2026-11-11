//! Tokenizer BPE de MiniChat (NELMODEL-FORMAT.md, « tokenizer.json »).
//! Les textes des tokens sont en unités UTF-16, comme en C#.

use std::collections::HashMap;

use regex::Regex;
use serde::Deserialize;

use crate::{Result, err};

#[derive(Deserialize)]
struct Json {
    #[serde(rename = "Alphabet")]
    alphabet: String,
    #[serde(rename = "Merges")]
    merges: Vec<[u32; 2]>,
    #[serde(rename = "Special")]
    special: Vec<String>,
}

pub struct Tokenizer {
    texts: Vec<Vec<u16>>,             // id -> texte (UTF-16)
    alphabet: HashMap<u16, u32>,      // unité UTF-16 -> id
    merges: HashMap<(u32, u32), u32>, // paire -> rang
    merge_pairs: Vec<(u32, u32)>,
    base: u32,                        // A = taille de l'alphabet
    specials: Vec<(String, u32)>,     // triés du plus long au plus court
    first_special: u32,
    pre: Regex,
}

// Le pré-découpage .NET : `\s` .NET = [\f\n\r\t\v\x85\p{Z}], et les catégories s'appliquent aux unités
// UTF-16 (un caractère hors du plan de base est une moitié « Cs » : il tombe dans la ponctuation).
const PRE: &str = r"\n| ?[[\p{L}\p{M}]&&[\x00-\x{FFFF}]]+| ?[\p{N}&&[\x00-\x{FFFF}]]+| ?[^\f\n\r\t\v\x85\p{Z}[[\p{L}\p{M}\p{N}]&&[\x00-\x{FFFF}]]]+|[\f\r\t\v\x85\p{Z}]+";

impl Tokenizer {
    pub fn from_json(json: &str, vocab_size: usize) -> Result<Self> {
        let j: Json = serde_json::from_str(json).map_err(|e| err(format!("tokenizer.json : {e}")))?;
        if j.special.is_empty() {
            return Err(err("tokenizer.json : « Special » est obligatoire"));
        }
        let units: Vec<u16> = j.alphabet.encode_utf16().collect();
        let base = units.len() as u32;
        let mut texts: Vec<Vec<u16>> = units.iter().map(|&u| vec![u]).collect();
        let mut merges = HashMap::new();
        for (r, &[a, b]) in j.merges.iter().enumerate() {
            let id = base + r as u32;
            if a >= id || b >= id {
                return Err(err(format!("tokenizer.json : fusion {r} invalide")));
            }
            texts.push([texts[a as usize].as_slice(), texts[b as usize].as_slice()].concat());
            merges.insert((a, b), r as u32);
        }
        let first_special = texts.len() as u32;
        let mut specials: Vec<(String, u32)> = j.special.iter().enumerate().map(|(i, s)| (s.clone(), first_special + i as u32)).collect();
        texts.extend(j.special.iter().map(|s| s.encode_utf16().collect()));
        if texts.len() != vocab_size {
            return Err(err(format!("tokenizer : {} tokens, VocabSize = {vocab_size}", texts.len())));
        }
        specials.sort_by_key(|(s, _)| std::cmp::Reverse(s.len()));
        Ok(Self {
            alphabet: units.iter().enumerate().map(|(i, &u)| (u, i as u32)).collect(),
            texts,
            merges,
            merge_pairs: j.merges.iter().map(|&[a, b]| (a, b)).collect(),
            base,
            specials,
            first_special,
            pre: Regex::new(PRE).unwrap(),
        })
    }

    pub fn vocab_size(&self) -> usize {
        self.texts.len()
    }

    pub fn is_special(&self, id: u32) -> bool {
        id >= self.first_special
    }

    /// L'id d'un token spécial (`"<|end|>"`...).
    pub fn special(&self, name: &str) -> Option<u32> {
        self.specials.iter().find(|(s, _)| s == name).map(|&(_, id)| id)
    }

    pub fn encode(&self, text: &str) -> Vec<u32> {
        let mut ids = Vec::new();
        let (mut start, mut i) = (0, 0);
        while i < text.len() {
            // ponytail: recherche naïve O(texte × spéciaux), 4 spéciaux suffisent largement.
            if let Some((s, id)) = self.specials.iter().find(|(s, _)| text[i..].starts_with(s.as_str())) {
                self.encode_plain(&text[start..i], &mut ids);
                ids.push(*id);
                i += s.len();
                start = i;
            } else {
                i += text[i..].chars().next().unwrap().len_utf8();
            }
        }
        self.encode_plain(&text[start..], &mut ids);
        ids
    }

    fn encode_plain(&self, text: &str, out: &mut Vec<u32>) {
        for m in self.pre.find_iter(text) {
            let mut word: Vec<u32> = m.as_str().encode_utf16().filter_map(|u| self.alphabet.get(&u).copied()).collect();
            while word.len() >= 2 {
                let Some(r) = word.windows(2).filter_map(|w| self.merges.get(&(w[0], w[1]))).min().copied() else { break };
                let (a, b) = self.merge_pairs[r as usize];
                let mut merged = Vec::with_capacity(word.len());
                let mut j = 0;
                while j < word.len() {
                    if j + 1 < word.len() && word[j] == a && word[j + 1] == b {
                        merged.push(self.base + r);
                        j += 2;
                    } else {
                        merged.push(word[j]);
                        j += 1;
                    }
                }
                word = merged;
            }
            out.extend(word);
        }
    }

    pub fn decode(&self, ids: &[u32]) -> String {
        let units: Vec<u16> = ids.iter().flat_map(|&id| self.texts[id as usize].iter().copied()).collect();
        String::from_utf16_lossy(&units)
    }
}
