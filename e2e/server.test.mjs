// Le serveur local compatible avec l'API OpenAI : désactivé par défaut, activé dans les réglages, clé obligatoire,
// /v1/models, /v1/chat/completions avec et sans streaming (SSE), seulement sur 127.0.0.1, indicateur dans la barre
// d'état. Les requêtes viennent de Node (fetch), comme celles d'un client tel que Continue.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { launch } from './harness.mjs';

const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}/v1`;
const SECRET = 'Question secrète du serveur';
let A, KEY;

const call = (route, { key = KEY, body, method = body ? 'POST' : 'GET' } = {}) =>
  fetch(BASE + route, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body && (typeof body === 'string' ? body : JSON.stringify(body)) });
const reachable = (url) => fetch(url).then(() => true, () => false);

/** Ouvre les réglages, change la section Serveur local avec `edit(section)` (code évalué dans la page), enregistre. */
async function serverSettings(edit) {
  await A.ev(`T.key(',', { ctrlKey: true }, document)`);
  await A.waitFor(`T.dialog()?.querySelector('.server .key')?.value`, 10_000, 'section Serveur local');
  await A.ev(`(() => { const sec = T.dialog().querySelector('.server'); ${edit}; T.button('Enregistrer', T.dialog()); return true; })()`);
}

before(async () => {
  A = await launch({ settings: { serverPort: PORT } });
  await A.importAs('mini');
  await A.waitFor(`S.model.name === 'mini' && !S.model.loading`, 120_000, 'chargement de mini');
});

after(async () => A?.close());

test('désactivé par défaut : rien n\'écoute, rien dans la barre d\'état', async () => {
  assert.equal((await A.ev(`window.__TAURI__.core.invoke('server_status')`)).port, null);
  assert.equal(A.readJson('settings.json').serverEnabled ?? false, false);
  assert.equal(await reachable(BASE + '/models'), false);
  assert.doesNotMatch(await A.ev(`document.getElementById('status').textContent`), /API/);
});

test('activé dans les réglages : clé générée et affichée, port réglé, indicateur dans la barre d\'état', async () => {
  await A.ev(`T.key(',', { ctrlKey: true }, document)`);
  await A.waitFor(`T.dialog()?.querySelector('.server .key')?.value`, 10_000);
  KEY = await A.ev(`T.dialog().querySelector('.server .key').value`);
  assert.match(KEY, /^nc-[0-9a-f]{64}$/);
  assert.match(await A.ev(`T.dialog().querySelector('.server').textContent`), new RegExp(`arrêté[\\s\\S]*http://127\\.0\\.0\\.1:${PORT}/v1`));
  await A.ev(`T.key('Escape', {}, document)`);
  await serverSettings(`sec.querySelector('input[type=checkbox]').click()`);
  await A.waitFor(`S.server.port === ${PORT}`, 10_000, 'serveur actif');
  assert.match(await A.ev(`document.getElementById('status').textContent`), new RegExp(`API :${PORT}`));
  const s = A.readJson('settings.json');
  assert.deepEqual([s.serverEnabled, s.serverPort, s.serverKey], [true, PORT, KEY]);
});

test('clé d\'accès obligatoire', async () => {
  for (const key of [null, 'nc-fausse']) {
    const r = await call('/models', { key });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.type, 'invalid_api_key');
  }
  const r = await call('/models');
  assert.equal(r.status, 200);
  const list = await r.json();
  assert.equal(list.object, 'list');
  assert.deepEqual(list.data.map((m) => [m.id, m.object]), [['mini', 'model']]);
});

test('POST /v1/chat/completions sans streaming', async () => {
  const r = await call('/chat/completions', { body: { model: 'mini', max_tokens: 20, temperature: 0, messages: [{ role: 'system', content: 'Réponds en français.' }, { role: 'user', content: SECRET }] } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  const c = await r.json();
  assert.equal(c.object, 'chat.completion');
  assert.equal(c.model, 'mini');
  assert.equal(c.choices[0].message.role, 'assistant');
  assert.ok(c.choices[0].message.content.length > 0);
  assert.ok(['stop', 'length'].includes(c.choices[0].finish_reason));
  assert.ok(c.usage.completion_tokens > 0 && c.usage.completion_tokens <= 20);
  assert.equal(c.usage.total_tokens, c.usage.prompt_tokens + c.usage.completion_tokens);
  // Température 0 : glouton, la même réponse deux fois.
  const again = await (await call('/chat/completions', { body: { model: 'mini', max_tokens: 20, temperature: 0, messages: [{ role: 'system', content: 'Réponds en français.' }, { role: 'user', content: SECRET }] } })).json();
  assert.equal(again.choices[0].message.content, c.choices[0].message.content);
});

test('POST /v1/chat/completions en streaming (SSE)', async () => {
  const r = await call('/chat/completions', { body: { model: 'mini', stream: true, max_tokens: 24, messages: [{ role: 'user', content: 'Bonjour !' }, { role: 'assistant', content: 'Salut.' }, { role: 'user', content: [{ type: 'text', text: 'Comment vas-tu ?' }] }] } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const events = (await r.text()).split('\n\n').filter(Boolean).map((e) => e.replace(/^data: /, ''));
  assert.equal(events.at(-1), '[DONE]');
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
  assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk' && c.model === 'mini' && c.id === chunks[0].id));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  const text = chunks.map((c) => c.choices[0].delta.content ?? '').join('');
  assert.ok(text.length > 0);
  assert.ok(chunks.length > 3, 'plusieurs morceaux');
  assert.ok(['stop', 'length'].includes(chunks.at(-1).choices[0].finish_reason));
  assert.ok(chunks.slice(0, -1).every((c) => c.choices[0].finish_reason === null));
});

test('erreurs au format OpenAI', async () => {
  const cases = [
    [call('/inconnu'), 404],
    [call('/chat/completions', { body: '{ pas du json' }), 400],
    [call('/chat/completions', { body: { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] } }), 400],
    [call('/chat/completions', { body: { model: 'mini' } }), 400],
    [call('/models', { method: 'DELETE' }), 405],
  ];
  for (const [req, status] of cases) {
    const r = await req;
    assert.equal(r.status, status);
    // En anglais, comme l'API OpenAI : pas d'accents, pas de « : » à la française.
    const message = (await r.json()).error.message;
    assert.match(message, /^[\x20-\x7e]+$/, message);
    assert.doesNotMatch(message, / :/, message);
  }
  assert.match((await (await call('/inconnu')).json()).error.message, /^unknown path \/v1\/inconnu/);
  assert.match((await (await call('/models', { key: null })).json()).error.message, /^missing or incorrect access key/);
  // Un modèle inconnu : celui chargé dans Nel Code répond.
  const r = await call('/chat/completions', { body: { model: 'gpt-4o', max_tokens: 4, messages: [{ role: 'user', content: 'Salut' }] } });
  assert.equal((await r.json()).model, 'mini');
});

test('seulement sur 127.0.0.1', async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal);
  if (!lan) return t.skip('aucune adresse réseau autre que 127.0.0.1');
  assert.equal(await reachable(`http://${lan.address}:${PORT}/v1/models`), false, `${lan.address}:${PORT} ne doit pas répondre`);
  assert.equal(await reachable(BASE + '/models'), true);
});

test('nouvelle clé : l\'ancienne est refusée', async () => {
  await A.ev(`T.key(',', { ctrlKey: true }, document)`);
  await A.waitFor(`T.dialog()?.querySelector('.server .key')?.value`, 10_000);
  await A.ev(`T.button('Nouvelle clé', T.dialog().querySelector('.server'))`);
  await A.waitFor(`T.dialog().querySelector('.server .key').value !== ${JSON.stringify(KEY)}`, 5_000, 'nouvelle clé affichée');
  const fresh = await A.ev(`T.dialog().querySelector('.server .key').value`);
  await A.ev(`T.key('Escape', {}, document)`);
  assert.equal((await call('/models')).status, 401);
  KEY = fresh;
  assert.equal((await call('/models')).status, 200);
});

test('désactivé : le port est fermé, l\'indicateur disparaît ; le journal ne contient pas les messages', async () => {
  await serverSettings(`sec.querySelector('input[type=checkbox]').click()`);
  await A.waitFor(`S.server.port === null`, 10_000, 'serveur arrêté');
  assert.equal(await reachable(BASE + '/models'), false);
  assert.doesNotMatch(await A.ev(`document.getElementById('status').textContent`), /API/);
  assert.equal(A.readJson('settings.json').serverEnabled, false);
  const logs = fs.readdirSync(path.join(A.home, 'logs')).map((f) => fs.readFileSync(path.join(A.home, 'logs', f), 'utf8')).join('');
  assert.match(logs, /serveur local démarré sur 127\.0\.0\.1/);
  assert.ok(!logs.includes(SECRET));
});
