// Modèles ouverts : catalogue (téléchargement servi en local, NELCODE_CATALOG_URL lue seulement en debug), réponse
// d'un modèle GGUF, contexte réglable, import d'un .gguf par glisser-déposer. Demande le .gguf de Qwen2.5-Coder-0.5B
// (variable GGUF, sinon test-models/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf) ; sans lui, les tests sont ignorés.
//
//   curl -L -o test-models/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf <adresse du catalogue, nel-desktop/src/catalog.rs>
//   node --test --test-reporter=spec e2e/gguf.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { ROOT, launch } from './harness.mjs';

const GGUF = path.resolve(process.env.GGUF ?? path.join(ROOT, 'test-models', 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf'));
const SMALL = 'Qwen2.5-Coder-0.5B-Instruct', BIG = 'Qwen2.5-Coder-1.5B-Instruct';
let server, A, skip;

/** Ouvre le catalogue (s'il ne l'est pas) et clique « Télécharger » sur `name`, puis accepte la licence. */
async function download(name) {
  if (!(await A.ev(`!!document.querySelector('.catalog')`))) {
    await A.ev(`T.submit('/catalogue')`);
    await A.waitFor(`document.querySelectorAll('.catalog .entry').length === 2`, 10_000, 'catalogue');
  }
  await A.ev(`T.button('Télécharger', document.querySelector('.catalog .entry[data-name="${name}"]'))`);
  await A.waitFor(`T.dialog()?.textContent.includes('Licence') && T.dialog().textContent.includes('Apache 2.0') && !document.querySelector('.catalog')`, 10_000, 'licence');
  await A.ev(`T.button('Accepter (Apache 2.0) et télécharger', T.dialog())`);
}

before(async () => {
  if (!fs.existsSync(GGUF)) { skip = `${GGUF} absent`; return; }
  // Le bon fichier pour le 0.5B ; pour le 1.5B, des octets quelconques (mauvaise empreinte).
  server = http.createServer((req, res) => {
    if (!req.url.includes('0.5b')) return res.end(Buffer.alloc(4096, 7));
    res.writeHead(200, { 'Content-Length': fs.statSync(GGUF).size });
    fs.createReadStream(GGUF).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  A = await launch({ env: { NELCODE_CATALOG_URL: `http://127.0.0.1:${server.address().port}` } });
});

after(async () => {
  await A?.close();
  server?.close();
});

test('catalogue : modèles, tailles et licences affichées avant le téléchargement', async (t) => {
  if (skip) return t.skip(skip);
  await A.ev(`document.getElementById('catalog-btn').click()`);
  await A.waitFor(`document.querySelectorAll('.catalog .entry').length === 2`, 10_000);
  const text = await A.ev(`document.querySelector('.catalog').textContent`);
  for (const s of [SMALL, BIG, 'Licence : Apache 2.0', '491 Mo', '1.1 Go', 'huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/blob/main/LICENSE']) assert.ok(text.includes(s), s);
  await A.ev(`T.key('Escape', {}, document)`);
});

test('empreinte incorrecte : le modèle est refusé, rien ne reste', async (t) => {
  if (skip) return t.skip(skip);
  await download(BIG);
  await A.waitFor(`T.toasts().includes('empreinte SHA-256 incorrecte')`, 60_000);
  assert.equal(await A.ev(`S.models.length`), 0);
  const tmp = path.join(A.home, 'import-tmp');
  assert.ok(!fs.existsSync(tmp) || fs.readdirSync(tmp).length === 0, 'dossier temporaire nettoyé');
  assert.ok(!fs.existsSync(path.join(A.home, 'models', BIG)));
  await A.ev(`T.key('Escape', {}, document)`);
});

test('téléchargement vérifié, installation, chargement avec la vraie taille de contexte', async (t) => {
  if (skip) return t.skip(skip);
  await A.ev(`window.__progress = 0; window.__TAURI__.event.listen('catalog-progress', () => window.__progress++).then(() => true)`);
  await download(SMALL);
  await A.waitFor(`S.model.name === '${SMALL}' && !S.model.loading`, 300_000, 'installation et chargement');
  assert.match(await A.ev(`document.getElementById('status').textContent`), new RegExp(`${SMALL} · CPU`));
  await A.waitFor(`document.getElementById('context-text').textContent.endsWith('/ 8192 tokens')`, 10_000, 'contexte de 8192');
  const info = A.readJson(path.join('models', SMALL, 'model-info.json'));
  assert.deepEqual([info.format, info.architecture, info.license, info.contextLength], ['gguf', 'qwen2', 'Apache 2.0', 32768]);
  assert.match(info.sha256, /^1d9614638d/);
  assert.ok((await A.ev(`window.__progress`)) > 10, 'progression du téléchargement');
  assert.ok(await A.ev(`document.querySelector('.catalog .entry[data-name="${SMALL}"]')?.textContent.includes('Installé')`));
  await A.ev(`T.key('Escape', {}, document)`);
});

test('réponse du modèle GGUF, avec un bloc de code colorié', async (t) => {
  if (skip) return t.skip(skip);
  await A.ask('Write a Python function add(a, b) that returns a + b.');
  const answer = await A.ev(`S.current.messages.at(-1).content`);
  assert.match(answer, /def add\(a, b\)/);
  assert.ok(!answer.includes('<|im_end|>'), 'arrêt au token de fin de tour');
  const block = `[...document.querySelectorAll('#messages .msg.assistant')].pop().querySelector('.code-block')`;
  assert.equal(await A.ev(`${block}?.dataset.lang`), 'py');
  assert.ok(await A.ev(`[...${block}.querySelectorAll('.hl-kw')].some((s) => s.textContent === 'def')`));
  await A.waitFor(`/tokens\\/s/.test(S.lastSpeed ?? '')`, 5_000, 'vitesse affichée (après l\'enregistrement de la réponse)');
});

test('contexte réglable : le modèle est rechargé avec la nouvelle limite', async (t) => {
  if (skip) return t.skip(skip);
  await A.ev(`openSettings('models', 'contextLimit')`);
  await A.waitFor(`T.row('contextLimit')?.querySelector('input[type=range][max="32768"]')`);
  assert.ok(await A.ev(`T.row('contextLimit').textContent.includes('Contexte des modèles GGUF')`));
  await A.ev(`T.setValue(T.control('contextLimit'), '4096')`);
  await A.waitFor(`S.settings.contextLimit === 4096`);
  await A.ev(`T.key('Escape', {}, document)`);
  await A.waitFor(`!S.model.loading && document.getElementById('context-text').textContent.endsWith('/ 4096 tokens')`, 120_000, 'contexte de 4096');
  assert.equal(A.readJson('settings.json').contextLimit, 4096);
});

test('glisser-déposer d\'un .gguf : infos vérifiées, puis import', async (t) => {
  if (skip) return t.skip(skip);
  await A.ev(`onDrop([${JSON.stringify(GGUF)}])`);
  await A.waitFor(`T.dialog()?.querySelector('input.text-input')`, 30_000, 'fenêtre d\'import');
  const text = await A.ev(`T.dialog().textContent`);
  for (const s of ['qwen2', 'ChatML', '32', 'métadonnées du .gguf', 'Licence']) assert.ok(text.includes(s), s);
  await A.ev(`T.setValue(T.dialog().querySelector('input.text-input'), 'qwen-glisse'); T.button('Importer', T.dialog())`);
  await A.waitFor(`S.models.some((m) => m.name === 'qwen-glisse')`, 120_000, 'import du .gguf');
  assert.ok(fs.existsSync(path.join(A.home, 'models', 'qwen-glisse', 'model.gguf')));
  assert.ok(fs.existsSync(GGUF), 'le fichier déposé est copié, pas déplacé');
  assert.equal(await A.ev(`S.models.find((m) => m.name === 'qwen-glisse').blockSize`), 32768);
});
