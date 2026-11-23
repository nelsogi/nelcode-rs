// Les images des messages : un faux serveur compatible OpenAI (et Ollama pour la détection) reçoit les requêtes et
// vérifie le contenu envoyé. Coller, glisser-déposer, miniatures et croix, 5 images au plus, préparation (taille
// réglée, métadonnées retirées), envoi en tableau OpenAI (chat, mode Agent, fournisseur Claude), modèles qui voient
// les images (détection, réglage manuel, bouton désactivé avec explication), enregistrement en fichiers, agrandir,
// estimation dans la barre de contexte, résumé « [image : nom] », suppression avec la conversation.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { launch } from './harness.mjs';

let server, A, OUT, DIR;
const chats = [];   // les corps des requêtes /v1/chat/completions
const shows = [];   // les modèles demandés à /api/show (détection Ollama)
const CAPS = { 'fake-vision': ['completion', 'vision'], 'fake-blind': ['completion'] };

before(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      const body = data ? JSON.parse(data) : null;
      if (req.method === 'POST' && req.url === '/api/show') {
        shows.push(body.model);
        if (!CAPS[body.model]) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ capabilities: CAPS[body.model] }));
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        chats.push(body);
        const last = body.messages.at(-1).content;
        const text = typeof last === 'string' && last.startsWith('Résume les échanges') ? 'Résumé court.' : 'Vu.';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
        return res.end();
      }
      res.writeHead(404); res.end();   // /props (llama.cpp) : ce serveur n'en a pas
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'nelcode-images-'));
  DIR = path.join(OUT, 'projet');
  fs.mkdirSync(DIR);
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  A = await launch({
    settings: {
      currentProject: DIR,
      providers: [
        { id: 'pimg', name: 'Faux', url, models: [{ id: 'fake-vision', contextLength: 200000 }, { id: 'fake-blind' }, { id: 'fake-unknown' }] },
        { id: 'pclaude', name: 'Claude', url, kind: 'anthropic', omitSampling: true, models: [{ id: 'claude-test-5' }] },
      ],
    },
  });
  // Des images faites dans la page (canvas) : un JPEG avec un segment EXIF (orientation, position GPS, description) et
  // un commentaire, ou un PNG.
  await A.ev(`window.MK = async (type, w, h, name, exif = false) => {
    const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
    g.fillStyle = '#3a7'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.fillRect(0, 0, w / 2, h / 2);
    let bytes = new Uint8Array(await (await c.convertToBlob({ type, quality: 0.9 })).arrayBuffer());
    if (exif) {
      const desc = [...new TextEncoder().encode('GPS 46.2044N 6.1432E SECRET'), 0];
      const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 2, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 1, 0, 0,
        0x01, 0x0e, 0, 2, 0, 0, 0, desc.length, 0, 0, 0, 38, 0, 0, 0, 0, ...desc];
      const app1 = [...new TextEncoder().encode('Exif'), 0, 0, ...tiff];
      const seg = [0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1];
      const com = [0xff, 0xfe, 0, 16, ...new TextEncoder().encode('COMMENT SECRET')];
      bytes = new Uint8Array([...bytes.slice(0, 2), ...seg, ...com, ...bytes.slice(2)]);
    }
    return new File([bytes], name, { type });
  }; true`);
});

after(async () => {
  await A?.close();
  server?.close();
  fs.rmSync(OUT, { recursive: true, force: true });
});

const btn = `document.getElementById('image-btn')`;
const pending = () => A.ev(`IMG.pendingOf().map((x) => x.name)`);
const sessionDir = async () => path.join(A.home, 'sessions', await A.ev(`S.current.id`));
const userContent = (body = chats.at(-1)) => body.messages.filter((m) => m.role === 'user').at(-1).content;

async function pick(model) {
  await A.ev(`(() => { [...document.querySelectorAll('#models li.remote')].find((li) => li.dataset.model === ${JSON.stringify(model)}).click(); return true; })()`);
  await A.waitFor(`S.model.remote?.model === ${JSON.stringify(model)} && S.model.visionOf === ${JSON.stringify(model)}`, 10_000, `choix de ${model}`);
}

/** Colle une image (vrai événement « paste » dans la saisie). */
async function paste(type, w, h, name, exif = false) {
  const before = (await pending()).length;
  await A.ev(`MK(${JSON.stringify(type)}, ${w}, ${h}, ${JSON.stringify(name)}, ${exif}).then((f) => {
    const dt = new DataTransfer(); dt.items.add(f);
    document.getElementById('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true; })`);
  await A.waitFor(`IMG.pendingOf().length > ${before}`, 10_000, `image ${name} préparée`).catch(async (e) => {
    throw new Error(`${e.message} ; notifications : ${await A.ev(`T.toasts()`)} ; vision : ${JSON.stringify(await A.ev(`IMG.vision()`))}`);
  });
}

test('bouton désactivé avec une explication : modèle local, Claude Agent, modèle qui ne voit pas les images', async () => {
  await A.importAs('mini');
  await A.waitFor(`S.model.name === 'mini' && !S.model.loading`, 60_000, 'mini chargé');
  assert.equal(await A.ev(`${btn}.classList.contains('off')`), true);
  assert.match(await A.ev(`${btn}.title`), /\.nelmodel et les modèles GGUF de ce PC ne voient pas les images/);
  assert.match(await A.ev(`IMG.vision({ claudeAgent: {} }).why`), /Claude Agent/);
  // Un clic n'ouvre rien : il explique.
  await A.ev(`${btn}.click(); true`);
  await A.waitFor(`T.toasts().includes('ne voient pas les images')`, 5_000);
  // Ollama dit que le modèle ne voit pas les images.
  await pick('fake-blind');
  assert.equal(await A.ev(`S.model.vision`), false);
  assert.match(await A.ev(`${btn}.title`), /« fake-blind » ne voit pas les images \(détecté auprès du serveur\)/);
  // Le serveur ne dit rien : inconnu, désactivé, avec le chemin du réglage manuel.
  await pick('fake-unknown');
  assert.equal(await A.ev(`S.model.vision`), null);
  assert.match(await A.ev(`${btn}.title`), /ne sait pas si « fake-unknown » voit les images[\s\S]*Réglages → Fournisseurs → Images/);
  // Coller une image est refusé, avec la même explication.
  await A.ev(`MK('image/png', 10, 10, 'x.png').then((f) => IMG.addFiles([f]))`);
  await A.waitFor(`T.toasts().includes('fake-unknown')`, 5_000);
  assert.deepEqual(await pending(), []);
  // La détection est gardée dans les réglages.
  const models = A.readJson('settings.json').providers[0].models;
  assert.deepEqual(models.map((m) => m.visionDetected ?? null), [null, false, null]);
});

test('réglage manuel par modèle (Réglages → Fournisseurs → Images), détection automatique ; Claude sans détection', async () => {
  await A.ev(`openSettings('providers')`);
  await A.waitFor(`T.settings()?.querySelector('.vision-models select[data-model="fake-unknown"]')`, 10_000);
  await A.ev(`T.setValue(T.settings().querySelector('.vision-models select[data-model="fake-unknown"]'), 'yes')`);
  await A.waitFor(`S.model.vision === true`, 5_000, 'réglage manuel pris en compte');
  assert.equal(A.readJson('settings.json').providers[0].models[2].vision, true);
  assert.equal(await A.ev(`${btn}.classList.contains('off')`), false);
  await A.ev(`T.setValue(T.settings().querySelector('.vision-models select[data-model="fake-unknown"]'), 'auto')`);
  await A.waitFor(`S.model.vision === null`, 5_000);
  assert.equal(A.readJson('settings.json').providers[0].models[2].vision, undefined);
  await A.ev(`T.key('Escape', {}, document)`);
  await pick('fake-vision');
  assert.equal(await A.ev(`S.model.vision`), true);
  assert.equal(await A.ev(`${btn}.classList.contains('off')`), false);
  const asked = shows.length;
  await pick('claude-test-5');
  assert.equal(await A.ev(`S.model.vision`), true, 'les modèles Claude voient les images');
  assert.equal(shows.length, asked, 'pas de requête de détection pour Claude');
});

test('coller : préparée côté Rust (métadonnées retirées), miniature avec croix, estimation dans la barre de contexte', async () => {
  await pick('fake-vision');
  await A.ev(`T.submit('/new')`);
  await A.waitFor(`S.current.messages.length === 0`, 5_000);
  await paste('image/jpeg', 64, 32, 'photo.jpg', true);
  assert.deepEqual(await pending(), ['photo.jpg']);
  const dir = await sessionDir();
  const [file] = fs.readdirSync(dir);
  assert.match(file, /^img-[0-9a-f]{16}\.jpg$/);
  const bytes = fs.readFileSync(path.join(dir, file));
  for (const secret of ['Exif', 'SECRET', 'GPS']) assert.ok(!bytes.includes(Buffer.from(secret)), `${secret} retiré`);
  const img = await A.ev(`IMG.pendingOf()[0]`);
  assert.deepEqual([img.width, img.height], [64, 32]);
  assert.ok(img.tokens > 0);
  await A.waitFor(`document.querySelector('#attachments:not([hidden]) .thumb img')?.src.startsWith('data:image/jpeg;base64,')`, 5_000, 'miniature (data URL)');
  await A.waitFor(`/1 image ≈ \\d+ \\(estimation\\)/.test(document.getElementById('context-text').textContent)`, 5_000, 'estimation dans la barre');
  assert.match(await A.ev(`document.getElementById('context').title`), /photo\.jpg : ≈ \d+ tokens \(estimation\)/);
  // La croix retire l'image (et son fichier).
  await A.ev(`document.querySelector('#attachments .thumb-remove').click(); true`);
  await A.waitFor(`document.getElementById('attachments').hidden`, 5_000);
  for (let i = 0; i < 50 && fs.existsSync(path.join(dir, file)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fs.existsSync(path.join(dir, file)), 'fichier supprimé');
});

test('5 images au plus par message', async () => {
  await A.ev(`Promise.all([1, 2, 3, 4, 5, 6].map((i) => MK('image/png', 8, 8, 'i' + i + '.png'))).then((fs) => (IMG.addFiles(fs), true))`);
  await A.waitFor(`IMG.pendingOf().length === 5 && T.toasts().includes('5 images au plus par message')`, 15_000);
  await A.ev(`document.getElementById('toasts').replaceChildren(); MK('image/png', 8, 8, 'septieme.png').then((f) => (IMG.addFiles([f]), true))`);
  await A.waitFor(`T.toasts().includes('5 images au plus par message')`, 5_000, 'sixième refusée');
  assert.equal((await pending()).length, 5);
  for (let i = 0; i < 5; i++) await A.ev(`document.querySelector('#attachments .thumb-remove').click(); true`);
  await A.waitFor(`IMG.pendingOf().length === 0`, 5_000);
});

test('envoi (chat) : tableau OpenAI en data URL, taille réglée, glisser-déposer ; fichiers, historique, agrandir', async () => {
  await paste('image/png', 3000, 2000, 'grande.png');
  const dropped = path.join(OUT, 'déposée.jpg');
  const b64 = await A.ev(`MK('image/jpeg', 40, 20, 'd.jpg', true).then((f) => f.arrayBuffer()).then((b) => btoa(String.fromCharCode(...new Uint8Array(b))))`);
  fs.writeFileSync(dropped, Buffer.from(b64, 'base64'));
  await A.ev(`onDrop([${JSON.stringify(dropped)}]); true`);
  await A.waitFor(`IMG.pendingOf().length === 2`, 10_000, 'image déposée');
  await A.ask('Que vois-tu ?');
  const content = userContent();
  assert.ok(Array.isArray(content));
  assert.deepEqual(content.map((p) => p.type), ['image_url', 'image_url', 'text']);
  assert.equal(content[2].text, 'Que vois-tu ?');
  const [png, jpg] = content.map((p) => p.image_url?.url);
  assert.match(png, /^data:image\/png;base64,/);
  assert.match(jpg, /^data:image\/jpeg;base64,/);
  // Le plus grand côté ramené à 1568 px (réglage par défaut) : largeur et hauteur lues dans l'en-tête PNG.
  const head = Buffer.from(png.split(',')[1], 'base64');
  assert.deepEqual([head.readUInt32BE(16), head.readUInt32BE(20)], [1568, 1045]);
  assert.ok(!Buffer.from(jpg.split(',')[1], 'base64').includes(Buffer.from('SECRET')), 'rien des métadonnées n\'est envoyé');
  assert.deepEqual(await pending(), [], 'les images partent avec le message');
  // Enregistrées en fichiers dans le dossier de la conversation, pas en base64 dans le JSON.
  const id = await A.ev(`S.current.id`);
  const saved = A.readJson(`sessions/${id}.json`);
  assert.deepEqual(saved.messages[0].images.map((x) => [x.name, x.width, x.height]), [['grande.png', 1568, 1045], ['déposée.jpg', 40, 20]]);
  assert.ok(!fs.readFileSync(path.join(A.home, 'sessions', `${id}.json`), 'utf8').includes('base64'));
  assert.equal(fs.readdirSync(path.join(A.home, 'sessions', id)).length, 2);
  // Dans l'historique, un clic les agrandit.
  await A.waitFor(`document.querySelectorAll('#messages .msg.user .msg-images .thumb img[src^="data:image/"]').length === 2`, 5_000, 'miniatures de l\'historique');
  await A.ev(`document.querySelector('#messages .msg-images .thumb-open').click(); true`);
  await A.waitFor(`T.dialog()?.querySelector('img.image-large')?.src.startsWith('data:image/png')`, 5_000, 'image agrandie');
  assert.match(await A.ev(`T.dialog().textContent`), /1568 × 1045 px · ≈ [\d\s]+ tokens \(estimation\)/);
  await A.ev(`T.key('Escape', {}, document)`);
  // Le message suivant renvoie les images de l'historique ; le nouveau message est du texte.
  await A.ask('Et maintenant ?');
  const msgs = chats.at(-1).messages;
  assert.equal(msgs[0].content.length, 3);
  assert.equal(msgs.at(-1).content, 'Et maintenant ?');
});

test('mode Agent et fournisseur Claude : les images partent aussi', async () => {
  await A.ev(`S.current.workingDirectory = ${JSON.stringify(DIR)}; renderHeader(); true`);
  await A.ev(`document.getElementById('agent-btn').click()`);
  await A.waitFor(`S.current.agent === true`, 5_000);
  await paste('image/png', 20, 20, 'agent.png');
  await A.ask('Regarde cette capture.');
  let body = chats.at(-1);
  assert.ok(Array.isArray(body.tools), 'demande du mode Agent');
  assert.deepEqual(userContent(body).map((p) => p.type), ['image_url', 'text']);
  await A.ev(`document.getElementById('agent-btn').click()`);
  await A.waitFor(`!S.current.agent`, 5_000);
  await pick('claude-test-5');
  await paste('image/jpeg', 30, 30, 'claude.jpg');
  await A.ask('Et toi ?');
  body = chats.at(-1);
  assert.equal(body.model, 'claude-test-5');
  assert.equal(body.temperature, undefined);
  assert.deepEqual(userContent(body).map((p) => p.type), ['image_url', 'text']);
  assert.match(userContent(body)[0].image_url.url, /^data:image\/jpeg;base64,/);
});

test('résumé : les anciennes images deviennent « [image : nom] » ; supprimer la conversation supprime ses images', async () => {
  await pick('fake-vision');
  for (let i = 0; i < 3; i++) await A.ask(`Suite ${i}`);
  const from = chats.length;
  await A.ev(`T.submit('/compact')`);
  await A.waitFor(`!!S.current.summary`, 15_000, 'résumé écrit');
  const summary = chats.slice(from).find((c) => typeof c.messages.at(-1).content === 'string' && c.messages.at(-1).content.startsWith('Résume les échanges'));
  assert.ok(summary, 'demande de résumé');
  assert.match(summary.messages.at(-1).content, /Utilisateur : \[image : grande\.png\] \[image : déposée\.jpg\]\nQue vois-tu \?/);
  assert.ok(!JSON.stringify(summary).includes('image_url'), 'aucune image dans la demande de résumé');
  await A.ask('Après le résumé');
  assert.ok(!JSON.stringify(chats.at(-1).messages.slice(0, 2)).includes('image_url'), 'les images résumées ne sont plus envoyées');
  const dir = await sessionDir();
  assert.ok(fs.existsSync(dir));
  const id = await A.ev(`S.current.id`);
  await A.ev(`window.__TAURI__.core.invoke('delete_session', { id: ${JSON.stringify(id)} }).then(() => true)`);
  assert.ok(!fs.existsSync(dir), 'dossier des images supprimé');
  assert.ok(!fs.existsSync(path.join(A.home, 'sessions', `${id}.json`)));
});

test('réglage de la taille des images', async () => {
  await A.ev(`window.__TAURI__.core.invoke('save_settings', { changes: { imageMaxSide: 600 } }).then((s) => (S.settings = s, true))`);
  await A.ev(`T.submit('/new')`);
  await A.waitFor(`S.current.messages.length === 0`, 5_000);
  await paste('image/png', 1200, 300, 'large.png');
  assert.deepEqual(await A.ev(`[IMG.pendingOf()[0].width, IMG.pendingOf()[0].height]`), [600, 150]);
  assert.equal(A.readJson('settings.json').imageMaxSide, 600);
  await A.ev(`window.__TAURI__.core.invoke('save_settings', { changes: { imageMaxSide: 99999 } }).then(() => true)`);
  assert.equal(A.readJson('settings.json').imageMaxSide, 4096, 'borné');
});
