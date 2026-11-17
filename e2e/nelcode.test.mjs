// Tests de l'interface de Nel Code : l'application (debug) est lancée avec un dossier de données et un dossier
// WebView2 temporaires, puis pilotée par le port de débogage de WebView2 (voir harness.mjs).
//
//   cargo build -p nel-desktop
//   node --test --test-concurrency=1 --test-reporter=spec e2e/   (une fenêtre de Nel Code à la fois)
//
// Modèle : variable NELMODEL, sinon test-models/minichat-v3b.nelmodel. Exécutable : NELCODE_EXE, sinon
// target/debug/nel-desktop.exe. Les tests se suivent : chacun part de l'état laissé par le précédent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT, launch, sleep } from './harness.mjs';

const QUESTION = 'Bonjour, qui es-tu ?';
let HOME, ev, waitFor, ask, importAs, readJson, close;

before(async () => {
  ({ home: HOME, ev, waitFor, ask, importAs, readJson, close } = await launch());
});

after(async () => close?.());

test('démarrage', async () => {
  assert.equal(await ev(`document.getElementById('title').textContent`), 'Nouvelle conversation');
  assert.equal(await ev(`document.getElementById('empty').hidden`), false);
  assert.match(await ev(`document.getElementById('status').textContent`), /aucun modèle chargé/);
  assert.match(await ev(`S.info.version`), /^\d+\.\d+\.\d+$/);
  const log = fs.readdirSync(path.join(HOME, 'logs')).find((f) => /^nelcode-\d{4}-\d\d-\d\d\.log$/.test(f));
  assert.match(fs.readFileSync(path.join(HOME, 'logs', log), 'utf8'), /démarrage de Nel Code/);
});

test('import d\'un .nelmodel (deux fois, sous deux noms)', async () => {
  await importAs('mini-a');
  // Premier modèle installé : chargé tout de suite.
  await waitFor(`S.model.name === 'mini-a' && !S.model.loading`, 120_000, 'chargement de mini-a');
  assert.match(await ev(`document.getElementById('status').textContent`), /mini-a · CPU/);
  await importAs('mini-b');
  assert.deepEqual(await ev(`S.models.map((m) => m.name).sort()`), ['mini-a', 'mini-b']);
  assert.equal(await ev(`S.model.name`), 'mini-a');   // le second n'est pas chargé à sa place
});

test('envoyer un message et recevoir une réponse', async () => {
  await ask(QUESTION);
  const msgs = await ev(`S.current.messages.map((m) => [m.role, m.content])`);
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], ['user', QUESTION]);
  assert.equal(msgs[1][0], 'assistant');
  assert.ok(msgs[1][1].length > 0);
  assert.equal(await ev(`document.querySelectorAll('#messages .msg').length`), 2);
  assert.ok(fs.readdirSync(path.join(HOME, 'sessions')).length === 1, 'la conversation est enregistrée');
});

test('Stop (Échap) pendant une réponse', async () => {
  await ev(`T.submit('/max 128')`);
  await waitFor(`S.settings.maxReplyTokens === 128`);
  await ev(`T.submit('Raconte-moi une longue histoire.')`);
  await waitFor('!!S.gen', 10_000);
  await ev(`T.key('Escape', {}, document)`);
  await waitFor('!S.gen', 60_000);
  assert.match(await ev(`S.lastSpeed`), /arrêtée/);
  await ev(`T.submit('/max 32')`);
  await waitFor(`S.settings.maxReplyTokens === 32`);
});

test('Régénérer et versions', async () => {
  const n = await ev(`S.current.messages.length`);
  const last = n - 1;
  assert.equal(await ev(`S.current.messages[${last}].role`), 'assistant');
  await ev(`T.button('Régénérer', [...document.querySelectorAll('#messages .msg.assistant')].pop())`);
  await waitFor('!!S.gen', 10_000);
  await waitFor('!S.gen', 120_000);
  assert.equal(await ev(`S.current.messages[${last}].versions.length`), 2);
  assert.equal(await ev(`document.querySelector('#messages .versions').textContent`), '2/2');
  await ev(`document.querySelector('#messages .versions button').click()`);   // version précédente
  await waitFor(`document.querySelector('#messages .versions').textContent === '1/2'`);
  assert.equal(await ev(`S.current.messages[${last}].content`), await ev(`S.current.messages[${last}].versions[0]`));
});

test('Modifier un message (la suite est retirée)', async () => {
  await ev(`T.button('Modifier', document.querySelector('#messages .msg.user'))`);
  await waitFor(`document.querySelector('#messages .edit-box')`);
  await ev(`(() => { const ta = document.querySelector('#messages .edit-box'); ta.value = 'Salut !'; T.key('Enter', {}, ta); return true; })()`);
  await waitFor('!!S.gen', 10_000);
  await waitFor('!S.gen', 120_000);
  const msgs = await ev(`S.current.messages.map((m) => m.content)`);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0], 'Salut !');
});

test('changer de modèle', async () => {
  await ev(`[...document.querySelectorAll('#models li')].find((li) => li.textContent.includes('mini-b')).click()`);
  await waitFor(`S.model.name === 'mini-b' && !S.model.loading`, 120_000);
  assert.match(await ev(`document.getElementById('status').textContent`), /mini-b/);
  assert.ok(await ev(`[...document.querySelectorAll('#models li.active')].some((li) => li.textContent.includes('mini-b'))`));
  assert.equal(readJson('settings.json').lastModel, 'mini-b');
});

test('recherche dans les conversations', async () => {
  await ev(`T.key('n', { ctrlKey: true }, document)`);   // une deuxième conversation
  await ask('Quelle est la capitale de la France ?');
  const search = async (q) => ev(`(() => { const s = document.getElementById('search'); s.value = ${JSON.stringify(q)}; s.dispatchEvent(new Event('input')); return [...document.querySelectorAll('#sessions li')].map((li) => li.textContent); })()`);
  const hits = await search('capitale');
  assert.equal(hits.length, 1);
  assert.match(hits[0], /capitale/);
  assert.equal((await search('Salut')).length, 1);
  assert.deepEqual(await search('zzzz introuvable'), ['Aucun résultat.']);
  assert.equal((await search('')).length, 2);
});

test('renommer une conversation (F2)', async () => {
  await ev(`T.key('F2', {}, document)`);
  await waitFor(`T.dialog()?.querySelector('input')`);
  await ev(`(() => { const i = T.dialog().querySelector('input'); i.value = 'Conversation e2e'; T.key('Enter', {}, i); return true; })()`);
  await waitFor(`document.getElementById('title').textContent === 'Conversation e2e'`);
  const file = await ev(`S.current.id`);
  assert.equal(readJson(path.join('sessions', file + '.json')).title, 'Conversation e2e');
  assert.ok(await ev(`[...document.querySelectorAll('#sessions li')].some((li) => li.textContent.includes('Conversation e2e'))`));
});

test('supprimer une conversation', async () => {
  const id = await ev(`S.current.id`);
  await ev(`T.submit('/delete')`);
  await waitFor(`T.dialog()?.textContent.includes('Supprimer la conversation')`);
  await ev(`T.button('Supprimer', T.dialog())`);
  await waitFor(`S.sessions.length === 1`);
  assert.ok(!fs.existsSync(path.join(HOME, 'sessions', id + '.json')));
  assert.equal(await ev(`document.getElementById('title').textContent`), 'Nouvelle conversation');
});

test('réglages (dont la pénalité de répétition et la section Calcul)', async () => {
  await ev(`T.key(',', { ctrlKey: true }, document)`);
  await waitFor(`T.dialog()?.querySelector('input[type=range]')`);
  assert.ok(await ev(`T.dialog().textContent.includes('Pénalité de répétition') && T.dialog().textContent.includes('Calcul') && T.dialog().textContent.includes('Tester la vitesse')`));
  await ev(`(() => { const r = T.dialog().querySelectorAll('input[type=range]'); T.setValue(r[0], '1.2'); T.setValue(r[4], '1.3'); return true; })()`);
  await ev(`T.button('Enregistrer', T.dialog())`);
  await waitFor(`S.settings.temperature === 1.2`);
  const s = readJson('settings.json');
  assert.equal(s.temperature, 1.2);
  assert.equal(s.repetitionPenalty, 1.3);
  assert.equal(s.device, 'auto');
  await ev(`T.submit('/temp 0.1')`);
  await waitFor(`S.settings.temperature === 0.1`);
});

test('mode transparence', async () => {
  await ev(`document.getElementById('transp-btn').click()`);
  await waitFor(`S.settings.transparency === true`);
  await ask('Dis-moi une phrase.');
  const toks = await ev(`[...document.querySelectorAll('#messages .msg.assistant')].pop().querySelectorAll('.tok').length`);
  assert.ok(toks > 0, 'les tokens de la réponse sont survolables');
  await ev(`[...document.querySelectorAll('#messages .tok')].pop().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  assert.equal(await ev(`document.getElementById('tip').hidden`), false);
  assert.ok((await ev(`document.querySelectorAll('#tip .row').length`)) >= 5);
  assert.ok(await ev(`S.current.messages.at(-1).tokens.every(([, choices]) => choices.length === 5)`));
  await ev(`document.getElementById('transp-btn').click()`);
  await waitFor(`S.settings.transparency === false`);
});

test('mode comparaison et vote', async () => {
  await ev(`T.key('N', { ctrlKey: true, shiftKey: true }, document)`);
  await waitFor(`T.dialog()?.querySelectorAll('select').length === 2`);
  await ev(`(() => { const [a, b] = T.dialog().querySelectorAll('select'); T.setValue(a, 'mini-a'); T.setValue(b, 'mini-b'); return T.button('Comparer', T.dialog()); })()`);
  await waitFor(`S.current.compare?.b === 'mini-b'`);
  await ask(QUESTION);
  assert.equal(await ev(`document.querySelectorAll('#messages .msg.compare').length`), 1);
  const m = await ev(`S.current.messages.at(-1)`);
  assert.equal(m.model, 'mini-a');
  assert.equal(m.compare.model, 'mini-b');
  // Les boutons de vote sont réactivés juste après la fin de la réponse (une fois la conversation enregistrée).
  await waitFor(`[...document.querySelectorAll('#messages .msg.compare button')].some((b) => b.textContent.includes('A est meilleur') && !b.disabled)`, 10_000, 'boutons de vote');
  await ev(`T.button('A est meilleur', document.querySelector('#messages .msg.compare'))`);
  await waitFor(`S.current.messages.at(-1).vote === 'a'`);
  const votes = readJson('arena.json').votes;
  assert.equal(votes.length, 1);
  assert.deepEqual([votes[0].a, votes[0].b, votes[0].winner], ['mini-a', 'mini-b', 'a']);
  await ev(`document.getElementById('arena-btn').click()`);
  await waitFor(`T.dialog()?.querySelector('table.board')`);
  assert.match(await ev(`T.dialog().querySelector('table.board tr:nth-child(2)').textContent`), /mini-a/);   // le gagnant en tête
  await ev(`T.key('Escape', {}, document)`);
});

test('test de vitesse', async () => {
  await ev(`runBenchmark()`);
  await waitFor(`!S.bench && T.dialog()?.textContent.includes('Test de vitesse')`, 300_000, 'fin du test de vitesse');
  const b = readJson('benchmarks.json')['mini-b'].cpu;
  assert.equal(b.device, 'CPU');
  assert.ok(b.tokensPerSecond > 0 && b.loadSeconds > 0 && b.promptTokens > 0);
  await ev(`T.key('Escape', {}, document)`);
});

test('rapport de bug et journal (jamais le texte des conversations)', async () => {
  const report = await ev(`window.__TAURI__.core.invoke('bug_report')`);
  assert.match(report, /^Nel Code \d+\.\d+\.\d+/);
  assert.match(report, /Windows : /);
  assert.match(report, /Modèle actif : mini-b \(CPU\)/);
  assert.match(report, /modèle « mini-a » chargé en [\d.]+ s/);
  const lines = report.split('Journal')[1].trim().split('\n').slice(1);
  assert.ok(lines.length > 5 && lines.length <= 50);
  for (const secret of [QUESTION, 'Salut !', 'capitale', 'longue histoire']) assert.ok(!report.includes(secret), `« ${secret} » dans le rapport`);
  const logs = fs.readdirSync(path.join(HOME, 'logs')).map((f) => fs.readFileSync(path.join(HOME, 'logs', f), 'utf8')).join('');
  for (const secret of [QUESTION, 'Salut !', 'capitale', 'longue histoire']) assert.ok(!logs.includes(secret), `« ${secret} » dans le journal`);
});

test('blocs de code : coloration (C#, Rust, Python, JS, HTML, CSS, JSON) et Copier, sans innerHTML', async () => {
  // [code, mots-clés, chaînes, commentaires] attendus.
  const samples = {
    csharp: ['public class A { string s = "x"; } // c', ['public', 'class', 'string'], ['"x"'], ['// c']],
    rust: ['fn main() { let n = 42; } // c', ['fn', 'let'], [], ['// c']],
    python: ['def f():\n    return "a"  # c', ['def', 'return'], ['"a"'], ['# c']],
    js: ['const x = `t`; if (x) return null;', ['const', 'if', 'return', 'null'], ['`t`'], []],
    html: ['<div class="a">hi<!-- c --></div>', ['<div', '>', '</div'], ['"a"'], ['<!-- c -->']],
    css: ['.a { color: #fff; } /* c */', [], [], ['/* c */']],
    json: ['{"a": [1, true, "b"]}', ['true'], ['"b"'], []],
  };
  const fence = '`'.repeat(3);
  const content = 'Voici :\n' + Object.entries(samples).map(([lang, [code]]) => `${fence}${lang}\n${code}\n${fence}`).join('\n') + '\nFin.';
  await ev(`(() => { S.current.messages.push({ role: 'user', content: 'Du code ?' }, { role: 'assistant', content: ${JSON.stringify(content)} }); renderMessages(); return true; })()`);
  const msg = `[...document.querySelectorAll('#messages .msg.assistant')].pop()`;
  assert.equal(await ev(`${msg}.querySelectorAll('.code-block').length`), 7);
  for (const [k, [code, kw, str, com]] of Object.values(samples).entries()) {
    const block = `${msg}.querySelectorAll('.code-block')[${k}]`;
    assert.equal(await ev(`${block}.querySelector('code').textContent`), code, 'le texte du code est intact');
    const spans = await ev(`Object.fromEntries(['kw', 'str', 'com'].map((c) => [c, [...${block}.querySelectorAll('.hl-' + c)].map((s) => s.textContent)]))`);
    for (const w of kw) assert.ok(spans.kw.includes(w), `${code} : mot-clé ${w}`);
    for (const w of str) assert.ok(spans.str.includes(w), `${code} : chaîne ${w}`);
    for (const w of com) assert.ok(spans.com.includes(w), `${code} : commentaire ${w}`);
  }
  assert.deepEqual(await ev(`[...${msg}.querySelectorAll('.code-head span')].map((s) => s.textContent)`), ['C#', 'Rust', 'Python', 'JavaScript', 'HTML', 'CSS', 'JSON']);
  assert.match(await ev(`${msg}.querySelector('.body').textContent`), /^Voici :/);
  await ev(`navigator.clipboard.writeText = async (t) => { window.__copied = t; }; ${msg}.querySelectorAll('.code-block .copy')[1].click(); true`);
  await waitFor(`window.__copied === ${JSON.stringify(samples.rust[0])}`, 5_000, 'code copié');
  assert.match(await ev(`${msg}.querySelectorAll('.code-block .copy')[1].textContent`), /Copié/);
  // Rendu sans innerHTML ; la CSP de la fenêtre n'a pas changé.
  assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/.test(fs.readFileSync(path.join(ROOT, 'nel-desktop', 'ui', 'app.js'), 'utf8')));
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'nel-desktop', 'tauri.conf.json'), 'utf8'));
  assert.equal(conf.app.security.csp, "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost");
  await ev(`S.current.messages.splice(-2); renderMessages(); true`);
});

test('@ : fichiers du dossier de travail ajoutés au message, en lecture seule', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nelcode-files-'));
  const outside = dir + '-dehors.txt';
  const files = {
    'src/main.rs': 'fn main() {\n    println!("bonjour");\n}\n',
    'gros.txt': 'x'.repeat(150_000),
    'long.py': 'print("une ligne de code")\n'.repeat(40),
    'node_modules/ignore.js': 'x',
    '.git/HEAD': 'x',
  };
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  fs.writeFileSync(outside, 'secret');
  const snapshot = () => Object.keys(files).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8'), fs.statSync(path.join(dir, f)).mtimeMs]);
  const before = snapshot();
  const fence = '`'.repeat(3);
  try {
    await ev(`T.key('n', { ctrlKey: true }, document)`);
    await ev(`S.current.workingDirectory = ${JSON.stringify(dir)}; renderHeader(); true`);
    // Suggestions : les fichiers du dossier (sans node_modules ni dossiers cachés).
    await ev(`T.type('Explique @mai')`);
    await waitFor(`[...document.querySelectorAll('#suggest .cmd')].some((c) => c.textContent === '@src/main.rs')`, 10_000, 'suggestion @src/main.rs');
    assert.deepEqual(await ev(`F.list`), ['gros.txt', 'long.py', 'src/main.rs']);
    await waitFor(`!document.getElementById('suggest').hidden`, 5_000, 'suggestions ouvertes');
    await ev(`T.key('Tab', {}, document.getElementById('input'))`);
    assert.equal(await ev(`document.getElementById('input').value`), 'Explique @src/main.rs ');
    await waitFor(`S.context && S.context.tokens > 20`, 10_000, 'la barre de contexte compte le fichier');
    await ev(`T.key('Enter', {}, document.getElementById('input'))`);
    await waitFor('!!S.gen', 10_000);
    await waitFor('!S.gen', 120_000);
    const sent = await ev(`S.current.messages[0].content`);
    assert.ok(sent.startsWith('Explique @src/main.rs'));
    assert.ok(sent.includes(`src/main.rs :\n${fence}rust\nfn main() {\n    println!("bonjour");\n}\n${fence}`), sent);
    assert.equal(await ev(`document.querySelector('#messages .msg.user .code-block')?.dataset.lang`), 'rust');

    // Trop gros, hors du dossier, absent : refusé, rien n'est envoyé, le message reste dans la saisie.
    for (const [line, error] of [['Lis @gros.txt', 'trop gros'], [`Lis @../${path.basename(outside)}`, "n'est pas un fichier du dossier de travail"], ['Lis @absent.txt', 'introuvable']]) {
      await ev(`T.submit(${JSON.stringify(line)})`);
      await waitFor(`T.toasts().includes(${JSON.stringify(error)})`, 10_000, error);
      assert.equal(await ev(`S.current.messages.length`), 2);
      assert.equal(await ev(`document.getElementById('input').value`), line);
    }
    // Plus long que le contexte du modèle (256 tokens) : barre pleine, avertissement avant l'envoi.
    await ev(`T.type('Regarde @long.py')`);
    await waitFor(`document.getElementById('context-fill').className === 'full'`, 10_000, 'barre de contexte pleine');
    await ev(`T.key('Enter', {}, document.getElementById('input'))`);
    await waitFor(`T.dialog()?.textContent.includes('dépasse le contexte')`, 10_000, 'avertissement');
    await ev(`T.button('Envoyer quand même', T.dialog())`);
    await waitFor('!!S.gen', 10_000);
    await waitFor('!S.gen', 120_000);
    assert.ok((await ev(`S.current.messages[2].content`)).includes(`long.py :\n${fence}python\n`));
    assert.deepEqual(snapshot(), before, 'aucun fichier modifié');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('@ : fichiers protégés lus seulement après confirmation ; noms réservés de Windows refusés', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nelcode-protege-'));
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=abc-123');
  fs.mkdirSync(path.join(dir, 'certs'));
  fs.writeFileSync(path.join(dir, 'certs', 'server.pem'), 'cle '.repeat(500));
  try {
    await ev(`T.key('n', { ctrlKey: true }, document)`);
    await ev(`S.current.workingDirectory = ${JSON.stringify(dir)}; renderHeader(); true`);
    // La barre de contexte ne lit pas un fichier protégé (2 000 caractères ne sont pas comptés).
    await ev(`T.type('Lis @certs/server.pem')`);
    await waitFor(`S.context && S.context.tokens > 0`, 10_000);
    await sleep(500);
    assert.ok((await ev(`S.context.tokens`)) < 40, 'contenu protégé non lu pour la barre de contexte');
    // Envoi : confirmation explicite ; Annuler n'envoie rien et garde le message.
    await ev(`T.submit('Lis @.env')`);
    await waitFor(`T.dialog()?.textContent.includes('Fichier protégé')`, 10_000, 'confirmation');
    assert.match(await ev(`T.dialog().textContent`), /« \.env » est protégé \(\.env\)/);
    await ev(`T.button('Annuler', T.dialog())`);
    await waitFor(`T.toasts().includes("« .env » n'a pas été lu")`, 5_000);
    assert.equal(await ev(`S.current.messages.length`), 0);
    assert.equal(await ev(`document.getElementById('input').value`), 'Lis @.env');
    // Confirmé : le fichier est ajouté au message.
    await ev(`T.submit('Lis @.env')`);
    await waitFor(`T.dialog()?.textContent.includes('Fichier protégé')`, 10_000);
    await ev(`T.button('Lire et envoyer', T.dialog())`);
    await waitFor('!!S.gen', 10_000);
    await waitFor('!S.gen', 120_000);
    assert.ok((await ev(`S.current.messages[0].content`)).includes('TOKEN=abc-123'));
    // Noms réservés de Windows, ou finissant par un point : refusés, rien n'est envoyé.
    for (const [line, error] of [['Lis @NUL', 'nom réservé de Windows'], ['Lis @con.txt', 'nom réservé de Windows'], ['Lis @certs.', 'finir par un point ou une espace']]) {
      await ev(`document.getElementById('toasts').replaceChildren(); T.submit(${JSON.stringify(line)})`);
      await waitFor(`T.toasts().includes(${JSON.stringify(error)})`, 5_000, line);
      assert.equal(await ev(`S.current.messages.length`), 2);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
