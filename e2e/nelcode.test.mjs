// Tests de l'interface de Nel Code : l'application (debug) est lancée avec un dossier de données et un dossier
// WebView2 temporaires, puis pilotée par le port de débogage de WebView2 (voir harness.mjs).
//
//   cargo build -p nel-desktop
//   node --test --test-reporter=spec e2e/
//
// Modèle : variable NELMODEL, sinon test-models/minichat-v3b.nelmodel. Exécutable : NELCODE_EXE, sinon
// target/debug/nel-desktop.exe. Les tests se suivent : chacun part de l'état laissé par le précédent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { launch } from './harness.mjs';

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
