// Modèles distants : un faux serveur compatible avec l'API OpenAI, en local (aucun vrai fournisseur). Fournisseurs dans
// les réglages (Tester, avertissement http, clé dans le Gestionnaire d'identification), modèles « réseau » dans la liste,
// streaming SSE, Stop, délai maximal, erreurs claires, réflexion (reasoning_content, reasoning, <think>), import depuis
// Qwen Code (dossier ~/.qwen remplacé par NELCODE_QWEN_DIR, lue seulement en debug).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { launch, sleep } from './harness.mjs';

const KEY = 'sk-test-faux-serveur', QWEN_KEY = 'sk-qwen-importee';
const MODELS = ['fake-chat', 'fake-think', 'fake-ollama', 'fake-tags', 'fake-slow', 'fake-hang', 'fake-off'];
let server, PORT, A, QWEN;
const requests = [];   // { url, auth, ua, body }
let slowClosed = false;

const sse = (res) => res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
const chunk = (res, delta, extra = {}) => res.write(`data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`);
const done = (res, tokens) => { res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: tokens, total_tokens: 5 + tokens } })}\n\ndata: [DONE]\n\n`); res.end(); };

async function reply(req, res, body) {
  const pause = (ms) => sleep(ms);
  switch (body.model) {
    case 'fake-chat':
      sse(res);
      for (const t of ['Bon', 'jour', ' !']) { chunk(res, { content: t }); await pause(30); }
      return done(res, 3);
    case 'fake-think':     // llama.cpp : reasoning_content
      sse(res);
      for (const t of ['Je ', 'réfléchis…']) { chunk(res, { reasoning_content: t }); await pause(150); }
      chunk(res, { content: 'Réponse.' });
      return done(res, 4);
    case 'fake-ollama':    // Ollama : reasoning
      sse(res);
      chunk(res, { reasoning: 'Pensée Ollama' });
      await pause(50);
      chunk(res, { content: 'OK Ollama.' });
      return done(res, 2);
    case 'fake-tags':      // balises dans le texte, coupées entre les morceaux
      sse(res);
      for (const t of ['<thi', 'nk>Pensée en ', 'balises</th', 'ink>\n\nVoilà.']) { chunk(res, { content: t }); await pause(20); }
      return done(res, 4);
    case 'fake-slow':      // un token toutes les 200 ms pendant 30 s : pour Stop
      sse(res);
      req.on('close', () => (slowClosed = true));
      for (let i = 0; i < 150 && !res.destroyed; i++) { chunk(res, { content: `mot${i} ` }); await pause(200); }
      return res.end();
    case 'fake-hang':      // ne répond jamais : pour le délai maximal
      return;
    default:               // modèle arrêté : comme Ollama
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `model '${body.model}' not found` } }));
  }
}

before(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      const body = data ? JSON.parse(data) : null;
      requests.push({ url: req.url, auth: req.headers.authorization, ua: req.headers['user-agent'], body });
      if (![`Bearer ${KEY}`, `Bearer ${QWEN_KEY}`].includes(req.headers.authorization)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }));
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') return reply(req, res, body);
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  QWEN = fs.mkdtempSync(path.join(os.tmpdir(), 'nelcode-qwen-'));
  A = await launch({ env: { NELCODE_REMOTE_TIMEOUT_MS: '1500', NELCODE_QWEN_DIR: QWEN } });
});

after(async () => {
  // Les clés de test ne restent pas dans le Gestionnaire d'identification.
  for (const p of (await A?.ev(`window.__TAURI__.core.invoke('list_providers')`).catch(() => [])) ?? []) await A.ev(`window.__TAURI__.core.invoke('delete_provider', { id: ${JSON.stringify(p.id)} })`);
  await A?.close();
  server?.close();
  fs.rmSync(QWEN, { recursive: true, force: true });
});

const lastChat = () => requests.filter((r) => r.url === '/v1/chat/completions').at(-1);
const settingsText = () => fs.readFileSync(path.join(A.home, 'settings.json'), 'utf8');

/** Choisit un modèle distant dans la liste. */
async function pick(model, provider) {
  await A.ev(`(() => { const li = [...document.querySelectorAll('#models li.remote')].find((li) => li.dataset.model === ${JSON.stringify(model)} && (!${JSON.stringify(provider ?? '')} || li.querySelector('.meta').textContent === ${JSON.stringify(provider ?? '')})); li.click(); return true; })()`);
  await A.waitFor(`S.model.remote?.model === ${JSON.stringify(model)}`, 5_000, `choix de ${model}`);
}

test('fournisseur dans les réglages : avertissement http, clé rangée hors de settings.json, Tester liste les modèles', async () => {
  await A.ev(`T.submit('/settings fournisseurs')`);
  await A.waitFor(`T.settings()?.querySelector('.providers-field')`, 10_000);
  await A.ev(`T.button('Ajouter un fournisseur', T.settings())`);
  const form = `T.settings().querySelector('.provider')`;
  const setUrl = (u) => A.ev(`T.setValue(${form}.querySelector('.url'), ${JSON.stringify(u)}); !${form}.querySelector('.http').hidden`);
  assert.equal(await setUrl('http://10.5.33.228:11434/v1'), true, 'http vers une autre machine : avertissement');
  assert.equal(await setUrl('https://exemple.ch/v1'), false, 'https : pas d\'avertissement');
  assert.equal(await setUrl(`http://127.0.0.1:${PORT}/v1`), false, 'http local : rien ne sort du PC');
  await A.ev(`T.setValue(${form}.querySelector('.name'), 'Faux'); T.setValue(${form}.querySelector('.key'), ${JSON.stringify(KEY)}); T.button('Tester', ${form})`);
  await A.waitFor(`${form}.querySelector('.status').textContent.includes('7 modèles')`, 10_000, 'liste des modèles');
  assert.match(await A.ev(`${form}.querySelector('.status').textContent`), /fake-chat, fake-think/);
  const models = requests.find((r) => r.url === '/v1/models');
  assert.equal(models.auth, `Bearer ${KEY}`, 'la clé est relue depuis le Gestionnaire d\'identification');
  assert.equal(models.ua, 'NelCode', 'appel fait par la partie Rust, pas par la page');
  assert.ok(!settingsText().includes(KEY), 'la clé n\'est pas dans settings.json');
  const p = A.readJson('settings.json').providers;
  assert.deepEqual([p.length, p[0].name, p[0].url, p[0].models.length], [1, 'Faux', `http://127.0.0.1:${PORT}/v1`, 7]);
  assert.equal(await A.ev(`S.providers[0].hasKey`), true);
  // La liste à gauche : le fournisseur enregistré.
  assert.match(await A.ev(`T.settings().querySelector('.provider-list .item.sel').textContent`), /^Faux7 modèles · clé$/);
  await A.ev(`T.key('Escape', {}, document)`);
});

test('modèles distants dans la liste (badge « réseau », fournisseur), réponse en streaming', async () => {
  assert.equal(await A.ev(`document.querySelectorAll('#models li.remote').length`), 7);
  assert.deepEqual(await A.ev(`[...document.querySelector('#models li.remote').querySelectorAll('.badge, .meta')].map((e) => e.textContent)`), ['réseau', 'Faux']);
  await pick('fake-chat');
  assert.match(await A.ev(`document.getElementById('status').textContent`), /fake-chat · réseau · Faux/);
  await A.ask('Bonjour');
  assert.equal(await A.ev(`S.current.messages.at(-1).content`), 'Bonjour !');
  const r = lastChat();
  assert.equal(r.body.stream, true);
  assert.equal(r.body.model, 'fake-chat');
  assert.deepEqual(r.body.messages, [{ role: 'user', content: 'Bonjour' }]);
  await A.waitFor(`S.lastSpeed?.startsWith('3 tokens')`, 5_000, 'vitesse (usage du serveur)');
  await A.waitFor(`document.getElementById('context-text').textContent.startsWith('≈ ')`, 5_000, 'contexte estimé');
});

test('réflexion : bloc repliable avec sa durée, jamais renvoyée au modèle', async () => {
  await pick('fake-think');
  await A.ask('Réfléchis');
  const m = await A.ev(`S.current.messages.at(-1)`);
  assert.deepEqual([m.content, m.reasoning], ['Réponse.', 'Je réfléchis…']);
  assert.ok(m.reasoningSeconds >= 0.1 && m.reasoningSeconds < 5, `durée ${m.reasoningSeconds}`);
  const box = `[...document.querySelectorAll('#messages .msg.assistant')].pop().querySelector('details.reasoning')`;
  assert.match(await A.ev(`${box}.querySelector('summary').textContent`), /^Réflexion · \d+[.,]\d s$/);
  assert.equal(await A.ev(`${box}.open`), false, 'repliée une fois la réponse écrite');
  assert.equal(await A.ev(`${box}.nextElementSibling.classList.contains('body')`), true, 'au-dessus de la réponse');
  for (const [model, thought, answer] of [['fake-ollama', 'Pensée Ollama', 'OK Ollama.'], ['fake-tags', 'Pensée en balises', 'Voilà.']]) {
    await pick(model);
    await A.ask('Encore');
    assert.deepEqual(await A.ev(`[S.current.messages.at(-1).reasoning, S.current.messages.at(-1).content]`), [thought, answer]);
  }
  // Les messages suivants : les réponses, sans la réflexion.
  const sent = JSON.stringify(lastChat().body.messages);
  for (const t of ['réfléchis…', 'Pensée Ollama', 'think']) assert.ok(!sent.includes(t), `« ${t} » renvoyé au modèle`);
  assert.ok(sent.includes('Réponse.') && sent.includes('OK Ollama.'));
});

test('Stop : la connexion est fermée tout de suite, le début de la réponse est gardé', async () => {
  await pick('fake-slow');
  await A.ev(`T.submit('Écris longtemps')`);
  await A.waitFor(`S.gen?.text.includes('mot2')`, 10_000, 'début de la réponse');
  const t = Date.now();
  await A.ev(`T.key('Escape', {}, document)`);
  await A.waitFor('!S.gen', 5_000, 'arrêt');
  assert.ok(Date.now() - t < 1500, `arrêt en ${Date.now() - t} ms`);
  assert.match(await A.ev(`S.lastSpeed`), /arrêtée/);
  assert.match(await A.ev(`S.current.messages.at(-1).content`), /^mot0 mot1 mot2/);
  await sleep(300);
  assert.ok(slowClosed, 'le serveur voit la connexion fermée');
});

test('messages clairs : modèle arrêté, délai dépassé, serveur injoignable', async () => {
  const n = await A.ev(`S.current.messages.length`);
  await pick('fake-off');
  await A.ev(`T.submit('Tu es là ?')`);
  await A.waitFor(`T.toasts().includes("le modèle « fake-off » n'existe pas ou est arrêté sur 127.0.0.1:${PORT}")`, 10_000, 'modèle arrêté');
  await A.waitFor('!S.gen', 5_000);
  await pick('fake-hang');
  const t = Date.now();
  await A.ev(`T.submit('Et toi ?')`);
  await A.waitFor(`T.toasts().includes('délai dépassé')`, 10_000, 'délai dépassé');
  assert.ok(Date.now() - t < 5000);
  assert.equal(await A.ev(`S.current.messages.length`), n, 'pas de réponse vide gardée');
  // Rien n'écoute sur ce port : « ne répond pas », dans la section Fournisseurs.
  await A.ev(`openSettings('providers')`);
  await A.waitFor(`T.settings()?.querySelector('.providers-field')`, 10_000);
  await A.ev(`T.button('Ajouter un fournisseur', T.settings())`);
  const form = `[...T.settings().querySelectorAll('.provider')].pop()`;
  await A.ev(`T.setValue(${form}.querySelector('.name'), 'Éteint'); T.setValue(${form}.querySelector('.url'), 'http://127.0.0.1:1/v1'); T.button('Tester', ${form})`);
  await A.waitFor(`${form}.querySelector('.status').textContent.includes('ne répond pas')`, 15_000, 'serveur injoignable');
  await A.ev(`T.button('Supprimer', ${form})`);
  await A.waitFor(`S.providers.length === 1`, 5_000);
  await A.ev(`T.key('Escape', {}, document)`);
});

test('import depuis Qwen Code : fournisseurs, réglages de chaque modèle, clé', async () => {
  const base = `http://localhost:${PORT}/v1`;
  fs.writeFileSync(path.join(QWEN, 'settings.json'), JSON.stringify({
    env: { FAKE_KEY: QWEN_KEY },
    modelProviders: { openai: [
      { id: 'fake-chat', name: 'Chat importé', envKey: 'FAKE_KEY', baseUrl: base, generationConfig: { contextWindowSize: 4096, samplingParams: { temperature: 0.3, top_p: 0.5, max_tokens: 77 } } },
      { id: 'fake-think', envKey: 'FAKE_KEY', baseUrl: base + '/', generationConfig: { samplingParams: { temperature: 0.6 } } },
    ] },
    security: { auth: { selectedType: 'openai' } },
  }));
  await A.ev(`openSettings('providers')`);
  await A.waitFor(`T.settings()?.querySelector('.providers-field')`, 10_000);
  await A.ev(`T.button('Importer depuis Qwen Code', T.settings())`);
  await A.waitFor(`T.toasts().includes('1 fournisseur créé, 2 modèles importés')`, 10_000, 'import');
  await A.waitFor(`T.settings().querySelectorAll('.provider-list .item').length === 2`, 5_000);
  await A.ev(`T.key('Escape', {}, document)`);
  const p = A.readJson('settings.json').providers.find((x) => x.url === base);
  assert.equal(p.name, `localhost:${PORT}`);
  assert.deepEqual(p.models, [
    { id: 'fake-chat', temperature: 0.3, topP: 0.5, maxTokens: 77, contextLength: 4096, label: 'Chat importé' },
    { id: 'fake-think', temperature: 0.6 },
  ]);
  assert.ok(!settingsText().includes(QWEN_KEY), 'la clé importée n\'est pas dans settings.json');
  // Les réglages du modèle sont envoyés, avec la clé importée.
  await pick('fake-chat', `localhost:${PORT}`);
  await A.waitFor(`(({ textContent: t }) => t.startsWith('≈ ') && t.endsWith(' / 4096 tokens'))(document.getElementById('context-text'))`, 5_000, 'contexte de Qwen Code');
  await A.ask('Avec les réglages de Qwen Code');
  const r = lastChat();
  assert.equal(r.auth, `Bearer ${QWEN_KEY}`);
  assert.deepEqual([r.body.temperature, r.body.top_p, r.body.max_tokens], [0.3, 0.5, 77]);
  // Sans settings.json de Qwen Code : un message clair.
  fs.rmSync(path.join(QWEN, 'settings.json'));
  assert.match(await A.ev(`window.__TAURI__.core.invoke('import_qwen').catch((e) => I18N.tr(String(e)))`), /introuvable : Qwen Code n'est pas configuré/);
});

test('au redémarrage de l\'interface, le modèle distant reste choisi ; supprimer un fournisseur retire sa clé', async () => {
  assert.match(A.readJson('settings.json').lastModel, /^remote:p[0-9a-f]+\/fake-chat$/);
  await A.ev(`location.reload(); true`).catch(() => {});
  await A.waitFor(`typeof S === 'object' && S.model?.remote?.model === 'fake-chat'`, 30_000, 'modèle distant après rechargement');
  await A.ev(`window.T || (window.T = {}); true`);
  const ids = (await A.ev(`window.__TAURI__.core.invoke('list_providers')`)).map((p) => p.id);
  for (const id of ids) await A.ev(`window.__TAURI__.core.invoke('delete_provider', { id: ${JSON.stringify(id)} })`);
  assert.deepEqual(await A.ev(`window.__TAURI__.core.invoke('list_providers')`), []);
});
