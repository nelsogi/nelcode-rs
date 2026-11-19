// Suivi : usage.jsonl (une ligne par réponse, jamais le texte), coûts estimés avec la table de prix (réglages), tokens et
// coût dans l'en-tête de la conversation, page Suivi (totaux, graphiques SVG, temps de réponse, CSV), budget mensuel
// (avertissement à 80 %, confirmation à 100 %), regroupement par jour des lignes de plus de 90 jours. Un faux serveur
// compatible OpenAI en local, qui renvoie `usage` (aucun vrai fournisseur).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { MODEL, launch, sleep } from './harness.mjs';

let server, A, DIR;
const chats = [];

const sse = (res) => res.writeHead(200, { 'Content-Type': 'text/event-stream' });
const send = (res, delta, usage) => {
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: usage[0], completion_tokens: usage[1], total_tokens: usage[0] + usage[1] } })}\n\ndata: [DONE]\n\n`);
  res.end();
};

// Un peu de délai : la réponse dure assez pour que les tests voient qu'elle est en cours.
async function reply(res, body) {
  sse(res);
  await new Promise((r) => setTimeout(r, 150));
  if (body.model === 'claude-sonnet-5-5') return send(res, { content: 'Réponse payante SECRET-REPONSE.' }, [1000, 500]);
  // Mode Agent : un outil, puis la réponse finale (deux tours : les tokens d'entrée s'additionnent).
  if (!body.messages.some((m) => m.role === 'tool')) return send(res, { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] }, [100, 10]);
  return send(res, { content: 'Fini.' }, [200, 20]);
}

// Une date locale « AAAA-MM-JJTHH:MM:SS » (comme usage.rs).
const p2 = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const old = new Date(Date.now() - 100 * 864e5);
const line = (d, extra) => JSON.stringify({ ts: Math.floor(d / 1000), date: localDate(d), project: 'C:\\ancien', provider: 'local', model: 'vieux', kind: 'chat', input: 10, output: 20, seconds: 2, tps: 10, cost: 0, ...extra });

before(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }, { id: 'outil-gratuit' }] })); }
      const body = JSON.parse(data);
      chats.push(body);
      reply(res, body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nelcode-usage-'));
  fs.writeFileSync(path.join(DIR, 'a.txt'), 'a');
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  A = await launch({
    settings: { providers: [{ id: 'pfaux', name: 'Faux payant', url, models: [{ id: 'claude-sonnet-5-5' }, { id: 'outil-gratuit' }] }] },
    // Deux lignes de plus de 90 jours, le même jour : regroupées au démarrage.
    files: { 'usage.jsonl': [line(old), line(new Date(+old + 1000), { input: 5, output: 5, seconds: 1 }), ''].join('\n') },
  });
  await A.ev(`S.current.workingDirectory = ${JSON.stringify(DIR)}; renderHeader(); true`);
});

after(async () => {
  await A?.close();
  server?.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

const usage = () => fs.readFileSync(path.join(A.home, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
async function waitFile(ok, what) {
  for (let i = 0; i < 50; i++) { if (ok()) return; await sleep(100); }
  assert.fail('délai dépassé : ' + what);
}
async function pick(model) {
  await A.ev(`(() => { [...document.querySelectorAll('#models li.remote')].find((li) => li.dataset.model === ${JSON.stringify(model)}).click(); return true; })()`);
  await A.waitFor(`S.model.remote?.model === ${JSON.stringify(model)}`, 5_000, `choix de ${model}`);
}

test('au démarrage : les lignes de plus de 90 jours sont regroupées par jour', () => {
  const u = usage();
  assert.equal(u.length, 1);
  assert.deepEqual([u[0].date, u[0].n, u[0].input, u[0].output, u[0].seconds, u[0].tps], [localDate(old).slice(0, 10), 2, 15, 25, 3, 8.33]);
});

test('réponse d\'un modèle payant : une ligne sans le texte, coût estimé, tokens et coût dans l\'en-tête', async () => {
  await pick('claude-sonnet-5-5');
  await A.ask('Question SECRET-QUESTION');
  assert.deepEqual(chats.at(-1).stream_options, { include_usage: true }, 'usage demandé en streaming');
  const l = usage().at(-1);
  assert.deepEqual([l.project, l.provider, l.model, l.kind, l.input, l.output], [DIR, 'Faux payant', 'claude-sonnet-5-5', 'chat', 1000, 500]);
  assert.ok(Math.abs(l.cost - 0.007) < 1e-9, `coût ${l.cost} : 1000 × 2 $ + 500 × 10 $ par million`);
  assert.ok(l.seconds > 0 && l.tps > 0 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(l.date));
  const raw = fs.readFileSync(path.join(A.home, 'usage.jsonl'), 'utf8');
  assert.ok(!raw.includes('SECRET'), 'jamais le texte des messages');
  assert.deepEqual(await A.ev(`S.current.usage`), { input: 1000, output: 500, cost: 0.007 });
  const chip = await A.ev(`(() => { const c = document.getElementById('usage-chip'); return c.hidden ? null : c.textContent; })()`);
  assert.match(chip, /^1\D?500 tokens · ≈ 0,0070 \$$/);
  // Gardés avec la conversation.
  const saved = JSON.parse(fs.readFileSync(path.join(A.home, 'sessions', fs.readdirSync(path.join(A.home, 'sessions'))[0]), 'utf8'));
  assert.equal(saved.usage.input, 1000);
});

test('mode Agent : les tokens d\'entrée de chaque tour s\'additionnent, modèle sans prix : 0', async () => {
  await A.ev(`T.key('n', { ctrlKey: true }, document)`);
  await A.ev(`S.current.workingDirectory = ${JSON.stringify(DIR)}; renderHeader(); true`);
  await pick('outil-gratuit');
  await A.ev(`document.getElementById('agent-btn').click()`);
  await A.waitFor(`S.current.agent === true`, 5_000);
  await A.ask('Liste les fichiers');
  const l = usage().at(-1);
  assert.deepEqual([l.kind, l.model, l.input, l.output, l.cost, l.project], ['agent', 'outil-gratuit', 300, 30, 0, DIR]);
  await A.ev(`document.getElementById('agent-btn').click()`);
});

test('budget : avertissement discret à 80 %, confirmation à 100 % (désactivable)', async () => {
  await pick('claude-sonnet-5-5');
  // Budget 0,01 $ (arrondi au centime). Ce mois : 0,007 $ (70 %), plus une ligne payante de 0,002 $ : 90 %.
  await A.ev(`window.__TAURI__.core.invoke('save_settings', { changes: { budgetMonthly: 0.0089 } }).then(() => true)`);
  assert.equal(A.readJson('settings.json').budgetMonthly, 0.01, 'arrondi au centime');
  fs.appendFileSync(path.join(A.home, 'usage.jsonl'), line(new Date(), { provider: 'Faux payant', model: 'claude-sonnet-5-5', cost: 0.002 }) + '\n');
  const before = chats.length;
  await A.ask('Encore');
  assert.equal(chats.length, before + 1, 'à 90 % la demande part');
  await A.waitFor(`T.toasts().includes('Budget du mois')`, 5_000, 'avertissement à 80 %');
  // Maintenant 0,016 $ sur 0,01 $ : confirmation avant chaque demande payante.
  await A.ev(`T.submit('Au-delà du budget')`);
  await A.waitFor(`T.dialog()?.textContent.includes('Budget du mois atteint')`, 5_000, 'confirmation à 100 %');
  await A.ev(`T.button('Annuler', T.dialog())`);
  await A.waitFor(`!T.dialog()`, 5_000);
  assert.equal(chats.length, before + 1, 'refusée : rien n\'est envoyé');
  assert.equal(await A.ev(`document.getElementById('input').value`), 'Au-delà du budget', 'le message revient dans la saisie');
  assert.equal(await A.ev(`S.current.messages.at(-1).role`), 'assistant');
  // Confirmation désactivée : la demande part sans question.
  await A.ev(`window.__TAURI__.core.invoke('save_settings', { changes: { budgetConfirm: false } }).then(() => true)`);
  await A.ev(`T.key('Enter', {}, document.getElementById('input'))`);
  await A.waitFor('!!S.gen', 5_000);
  await A.waitFor('!S.gen', 10_000);
  assert.equal(chats.length, before + 2);
  await A.ev(`window.__TAURI__.core.invoke('save_settings', { changes: { budgetMonthly: 0, budgetConfirm: true } }).then(() => true)`);
});

test('page Suivi : totaux, graphiques par jour, fournisseur, modèle, projet, temps de réponse, CSV', async () => {
  await A.ev(`T.submit('/suivi')`);
  await A.waitFor(`T.dialog()?.querySelector('.usage .tiles')`, 10_000, 'page Suivi');
  const month = await A.ev(`T.dialog().querySelector('[data-period=month]').textContent`);
  assert.match(month, /Ce mois/);
  assert.match(month, /réponses/);
  for (const c of ['by-day', 'by-provider', 'by-model', 'by-project']) assert.ok(await A.ev(`!!T.dialog().querySelector('.${c} svg .bar')`), `graphique ${c}`);
  assert.match(await A.ev(`T.dialog().querySelector('.by-provider').textContent`), /Faux payant/);
  assert.match(await A.ev(`T.dialog().querySelector('.by-model').textContent`), /claude-sonnet-5-5/);
  assert.match(await A.ev(`T.dialog().querySelector('.by-project').textContent`), new RegExp(path.basename(DIR)));
  assert.ok(await A.ev(`!!T.dialog().querySelector('.by-day svg title')`), 'survol : une info-bulle par jour');
  const speed = await A.ev(`[...T.dialog().querySelectorAll('.by-speed tr')].map((r) => r.textContent)`);
  assert.ok(speed.some((r) => r.startsWith('claude-sonnet-5-5') && / s/.test(r)), 'temps moyen par modèle');
  // Coût estimé : le modèle gratuit disparaît du classement par modèle.
  await A.ev(`T.dialog().querySelector('[data-view="metric:cost"]').click()`);
  assert.ok(!(await A.ev(`T.dialog().querySelector('.by-model').textContent`)).includes('outil-gratuit'));
  assert.match(await A.ev(`T.dialog().querySelector('.by-model').textContent`), /≈ 0,0\d+ \$/);
  await A.ev(`T.dialog().querySelector('[data-view="metric:tokens"]').click()`);
  // CSV : séparateur « ; », une ligne par entrée, la ligne regroupée compte ses réponses.
  const csv = await A.ev(`window.__TAURI__.core.invoke('usage_csv')`);
  const rows = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.equal(rows[0], 'date;projet;fournisseur;modèle;type;tokens_entrée;tokens_sortie;durée_s;tokens_par_s;coût_estimé_usd;réponses');
  assert.equal(rows.length, 1 + usage().length);
  assert.ok(rows[1].endsWith(';2'));
  await A.ev(`T.key('Escape', {}, document)`);
  // Le calcul des périodes (lundi → dimanche).
  assert.deepEqual(await A.ev(`USAGE.periods(new Date(2026, 10, 19, 12))`), { today: ['2026-11-19', '2026-11-19'], week: ['2026-11-16', '2026-11-22'], month: ['2026-11-01', '2026-11-30'] });
});

test('réglages : table de prix modifiable, date de vérification affichée, prix par défaut', async () => {
  await A.ev(`T.key(',', { ctrlKey: true }, document)`);
  await A.waitFor(`T.dialog()?.querySelector('.usage-field')`, 10_000);
  assert.match(await A.ev(`T.dialog().querySelector('.prices-checked').textContent`), /vérifiés le 19 novembre 2026 sur la page officielle des tarifs d'Anthropic/);
  const table = `T.dialog().querySelector('textarea.prices')`;
  assert.match(await A.ev(`${table}.value`), /claude-opus-5-5 {2}4 {2}20/);
  await A.ev(`T.setValue(${table}, ${table}.value + '\\nmon-modele  1,5  3')`);
  await A.ev(`T.dialog().querySelector('.buttons .btn.primary').click()`);
  await A.waitFor(`!T.dialog()`, 5_000);
  await waitFile(() => Array.isArray(A.readJson('settings.json').prices), 'table enregistrée');
  const prices = A.readJson('settings.json').prices;
  assert.deepEqual(prices.at(-1), { model: 'mon-modele', input: 1.5, output: 3 });
  // Prix par défaut : la table n'est plus gardée dans les réglages (elle suit celle de Nel Code).
  await A.ev(`T.key(',', { ctrlKey: true }, document)`);
  await A.waitFor(`T.dialog()?.querySelector('.usage-field')`, 10_000);
  await A.ev(`T.button('Prix par défaut', T.dialog().querySelector('.usage-field')); T.dialog().querySelector('.buttons .btn.primary').click()`);
  await A.waitFor(`!T.dialog()`, 5_000);
  await waitFile(() => A.readJson('settings.json').prices === undefined, 'table par défaut');
});

test('modèle de ce PC : tokens comptés avec le tokenizer, coût 0', { skip: !fs.existsSync(MODEL) && 'modèle de test absent' }, async () => {
  await A.importAs('suivi-local');
  await A.ev(`T.submit('/model suivi-local')`);
  await A.waitFor(`S.model.name === 'suivi-local' && !S.model.remote`, 60_000, 'modèle chargé');
  await A.ev(`T.key('n', { ctrlKey: true }, document)`);
  await A.ask('Bonjour');
  const l = usage().at(-1);
  const last = await A.ev(`S.current.messages.at(-1)`);
  assert.deepEqual([l.provider, l.model, l.kind, l.cost], ['local', 'suivi-local', 'chat', 0]);
  assert.ok(l.input > 0 && l.output > 0 && last.role === 'assistant');
});
