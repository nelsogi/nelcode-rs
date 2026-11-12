//! Discuter avec un .nelmodel : `nel-chat <fichier.nelmodel> [--temperature 0.8] [--top-k 20] [--top-p 0.9] [--repetition-penalty 1.15] [--seed N]`
//! Commandes : /reset (oublie la conversation), /quit.

use std::io::{BufRead, Write};

use nel_engine::{MAX_ANSWER_TOKENS, NelModel, Rng, Sampling};

fn main() -> nel_engine::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut path = None;
    let mut s = Sampling::default();
    let mut seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos() as u64;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut val = || it.next().ok_or_else(|| format!("{a} : valeur manquante"));
        match a.as_str() {
            "--temperature" => s.temperature = val()?.parse()?,
            "--top-k" => s.top_k = val()?.parse()?,
            "--top-p" => s.top_p = val()?.parse()?,
            "--repetition-penalty" => s.repetition_penalty = val()?.parse()?,
            "--seed" => seed = val()?.parse()?,
            _ => path = Some(a.clone()),
        }
    }
    let path = path.ok_or("usage : nel-chat <fichier.nelmodel> [--temperature T] [--top-k K] [--top-p P] [--repetition-penalty R] [--seed N]")?;

    let m = NelModel::load(&path)?;
    println!("{} ({} paramètres) — /reset, /quit", m.info["name"].as_str().unwrap_or(&path), m.info["parameters"]);
    let mut rng = Rng(seed);
    let mut history: Vec<(String, String)> = Vec::new();
    let mut stdin = std::io::stdin().lock();
    loop {
        print!("\nToi: ");
        std::io::stdout().flush()?;
        let mut line = String::new();
        if stdin.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let msg = line.trim();
        match msg {
            "" => continue,
            "/quit" => return Ok(()),
            "/reset" => {
                history.clear();
                println!("(conversation oubliée)");
                continue;
            }
            _ => {}
        }
        print!("IA: ");
        let clock = std::time::Instant::now();
        let out = m.generate(&m.chat_prompt(&history, msg), MAX_ANSWER_TOKENS, &s, &mut rng, true, |id| {
            print!("{}", m.tokenizer.decode(&[id]));
            std::io::stdout().flush().is_ok()
        })?;
        println!("\n  [{} tokens, {:.1} tokens/s]", out.len(), out.len() as f64 / clock.elapsed().as_secs_f64());
        history.push((msg.to_string(), m.tokenizer.decode(&out)));
    }
}
