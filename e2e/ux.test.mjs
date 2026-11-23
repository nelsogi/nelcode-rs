// L'interface : projets (sélecteur des récents, conversations rangées par projet), panneau Fichiers (arborescence,
// aperçu colorié, fichiers protégés, badges et diff de la session avec un petit faux modèle à outils), assistant du
// premier lancement, notifications discrètes, aide « ? », taille du texte.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { launch, sleep } from './harness.mjs';

let A, server, TMP, PA, PB, PROVIDER;

// Le faux modèle : une écriture et une modification, puis la réponse.
function chat(req, res, body) {
  const n = body.messages.filter((m) => m.role === 'tool').length;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  if (n === 0) {
    [['write_file', { path: 'nouveau.txt', content: 'créé\n' }], ['edit_file', { path: 'src/main.cs', old_text: 'Console.WriteLine("a");', new_text: 'Console.WriteLine("b");' }]].forEach(([name, args], i) => {
      send({ tool_calls: [{ index: i, id: `c${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    });
    send({}, 'tool_calls');
  } else {
    send({ content: 'Fait.' });
    send({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
}

const session = (id, dir, title, date) => JSON.stringify({ id, model: 'x', workingDirectory: dir, title, date, messages: [{ role: 'user', content: title }, { role: 'assistant', content: 'ok' }] });

before(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      if (!req.url.startsWith('/v1/')) { res.writeHead(404); return res.end(); }   // détection des images (/api/show, /props) : pas d'Ollama ici
      if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'ecrit' }] })); }
      chat(req, res, JSON.parse(data));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nelcode-ux-'));
  PA = path.join(TMP, 'projet-a');
  PB = path.join(TMP, 'projet-b');
  fs.mkdirSync(path.join(PA, 'src'), { recursive: true });
  fs.mkdirSync(PB);
  fs.writeFileSync(path.join(PA, 'src', 'main.cs'), 'class Program {\n    static void Main() {\n        Console.WriteLine("a");\n    }\n}\n');
  fs.writeFileSync(path.join(PA, 'notes.txt'), 'notes\n');
  fs.writeFileSync(path.join(PA, 'cle.pem'), '-----BEGIN PRIVATE KEY----- secret');
  fs.writeFileSync(path.join(PA, '.env'), 'CACHE=1');
  A = await launch({ files: {
    'sessions/2026-01-01_10-00-00-000.json': session('2026-01-01_10-00-00-000', PA, 'Conversation A1', '2026-01-01T10:00:00.000+01:00'),
    'sessions/2026-01-02_10-00-00-000.json': session('2026-01-02_10-00-00-000', PA, 'Conversation A2', '2026-01-02T10:00:00.000+01:00'),
    'sessions/2026-01-03_10-00-00-000.json': session('2026-01-03_10-00-00-000', PB, 'Conversation B1', '2026-01-03T10:00:00.000+01:00'),
  } });
  const p = await A.ev(`window.__TAURI__.core.invoke('save_provider', { id: null, name: 'Faux', url: 'http://127.0.0.1:${server.address().port}/v1', key: null })`);
  PROVIDER = p.id;
  await A.ev(`window.__TAURI__.core.invoke('test_provider', { id: ${JSON.stringify(PROVIDER)} }).then(() => refreshProviders()).then(() => true)`);
});

after(async () => {
  await A?.ev(`window.__TAURI__.core.invoke('delete_provider', { id: ${JSON.stringify(PROVIDER)} })`).catch(() => {});
  await A?.close();
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const sessionsShown = () => A.ev(`[...document.querySelectorAll('#sessions li')].map((li) => (li.classList.contains('group') ? '# ' : '') + (li.querySelector('.label')?.textContent ?? li.textContent).trim())`);
const menuItems = () => A.ev(`[...document.querySelectorAll('#menu button')].map((b) => b.textContent)`);
async function pickProject(label) {
  await A.ev(`document.getElementById('project-btn').click()`);
  await A.waitFor(`!document.getElementById('menu').hidden`, 5_000, 'menu des projets');
  await A.ev(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith(${JSON.stringify(label)})).click()`);
}

// --- Projets --------------------------------------------------------------------------------------------------

test('projets : conversations rangées par projet, sélecteur des projets récents', async () => {
  assert.equal(await A.ev(`document.getElementById('project-btn').textContent`), 'Tous les projets');
  const all = await sessionsShown();
  assert.deepEqual(all.filter((t) => t.startsWith('# ')), ['# projet-b', '# projet-a'], 'un titre par projet, le plus récent d\'abord');
  assert.ok(all.indexOf('# projet-a') < all.findIndex((t) => t.startsWith('Conversation A2')));
  // Le menu : les projets récents (tirés des conversations), « Tous les projets », « Ouvrir un dossier… ».
  await A.ev(`document.getElementById('project-btn').click()`);
  await A.waitFor(`!document.getElementById('menu').hidden`, 5_000);
  const items = await menuItems();
  assert.ok(items[0].startsWith('projet-b') && items[1].startsWith('projet-a'), items.join(' | '));
  assert.ok(items.includes('Tous les projets') && items.includes('Ouvrir un dossier…'));
  await A.ev(`document.getElementById('menu').hidden = true`);
  // Un projet : ses conversations seulement, sans titre de groupe ; une nouvelle conversation y est rangée.
  await pickProject('projet-a');
  await A.waitFor(`document.getElementById('project-btn').textContent === 'projet-a'`, 5_000);
  const shown = await sessionsShown();
  assert.ok(shown.every((t) => !t.startsWith('# ') && !t.includes('B1')), shown.join(' | '));
  assert.equal(shown.filter((t) => t.startsWith('Conversation A')).length, 2);
  const s = A.readJson('settings.json');
  assert.equal(s.currentProject, PA);
  assert.equal(s.recentProjects[0], PA);
  await A.ev(`T.key('n', { ctrlKey: true }, document)`);
  assert.equal(await A.ev(`S.current.workingDirectory`), PA);
  // Retour à tous les projets.
  await pickProject('Tous les projets');
  await A.waitFor(`document.getElementById('project-btn').textContent === 'Tous les projets'`, 5_000);
  assert.equal(A.readJson('settings.json').currentProject, '');
  await pickProject('projet-a');
  await A.waitFor(`document.getElementById('project-btn').textContent === 'projet-a'`, 5_000);
});

// --- Panneau Fichiers -----------------------------------------------------------------------------------------

const tree = () => A.ev(`[...document.querySelectorAll('#files .tree li')].map((li) => li.dataset.path + (li.querySelector(':scope > .row .badge')?.textContent ?? ''))`);

test('panneau Fichiers : arborescence repliable, aperçu colorié, fichier protégé sur demande', async () => {
  await A.ev(`document.getElementById('files-btn').click()`);
  await A.waitFor(`!document.getElementById('files').hidden && document.querySelectorAll('#files .tree li').length > 0`, 10_000, 'panneau ouvert');
  assert.equal(A.readJson('settings.json').filesPanel, true);
  assert.deepEqual(await tree(), ['src', 'cle.pem', 'notes.txt'], 'dossier replié, sans fichier caché');
  await A.ev(`document.querySelector('#files li[data-path="src"] > .row').click()`);
  await A.waitFor(`document.querySelector('#files li[data-path="src/main.cs"]')`, 5_000, 'dossier déplié');
  await A.ev(`document.querySelector('#files li[data-path="src/main.cs"] > .row').click()`);
  await A.waitFor(`document.querySelector('#files .preview .code-block')?.dataset.lang === 'cs'`, 5_000, 'aperçu colorié');
  assert.ok(await A.ev(`[...document.querySelectorAll('#files .preview .hl-kw')].some((s) => s.textContent === 'class')`));
  assert.equal(await A.ev(`!!document.querySelector('#files .preview .tabs button:nth-child(2)')`), false, 'pas de diff : rien de modifié');
  // Un fichier protégé : rien n'est lu sans confirmation.
  await A.ev(`document.querySelector('#files li[data-path="cle.pem"] > .row').click()`);
  await A.waitFor(`document.querySelector('#files .preview .protected')`, 5_000, 'fichier protégé');
  assert.ok(!(await A.ev(`document.getElementById('files').textContent`)).includes('BEGIN PRIVATE KEY'));
  await A.ev(`T.button('Afficher quand même', document.getElementById('files'))`);
  await A.waitFor(`T.dialog()?.textContent.includes('Fichier protégé')`, 5_000);
  await A.ev(`T.button('Afficher', T.dialog().querySelector('.buttons'))`);
  await A.waitFor(`document.querySelector('#files .preview code')?.textContent.includes('BEGIN PRIVATE KEY')`, 5_000, 'affiché après confirmation');
  // Ctrl+Maj+E : replié, et gardé dans les réglages.
  await A.ev(`T.key('E', { ctrlKey: true, shiftKey: true }, document)`);
  await A.waitFor(`document.getElementById('files').hidden`, 5_000);
  assert.equal(A.readJson('settings.json').filesPanel, false);
  await A.ev(`T.key('E', { ctrlKey: true, shiftKey: true }, document)`);
  await A.waitFor(`!document.getElementById('files').hidden`, 5_000);
});

test('panneau Fichiers : badges des fichiers modifiés par l\'agent et diff de la session', async () => {
  await A.ev(`(() => { [...document.querySelectorAll('#models li.remote')].find((li) => li.dataset.model === 'ecrit').click(); return true; })()`);
  await A.waitFor(`S.model.remote?.model === 'ecrit'`, 5_000);
  await A.ev(`document.getElementById('agent-btn').click()`);
  await A.waitFor(`S.current.agent === true`, 5_000);
  await A.ev(`T.submit('Écris et modifie')`);
  await A.waitFor(`S.gen?.steps?.[0]?.status === 'pending'`, 10_000);
  await A.ev(`T.button('Accepter tout pour cette demande', [...document.querySelectorAll('#messages .msg.assistant')].pop())`);
  await A.waitFor('!S.gen', 20_000, 'fin de la demande');
  await A.waitFor(`document.querySelector('#files li[data-path="nouveau.txt"] .badge')?.textContent === 'A'`, 5_000, 'badge A');
  assert.equal(await A.ev(`document.querySelector('#files li[data-path="src"] > .row .dot.changed') !== null`), true, 'le dossier montre un fichier modifié');
  await A.ev(`(() => { const li = document.querySelector('#files li[data-path="src"]'); if (!li.classList.contains('open')) li.querySelector(':scope > .row').click(); return true; })()`);
  await A.waitFor(`document.querySelector('#files li[data-path="src/main.cs"] .badge')?.textContent === 'M'`, 5_000, 'badge M');
  assert.match(await A.ev(`document.querySelector('#files .files-count').textContent`), /2 modifiés/);
  // Le diff de la session : depuis avant la première modification (sauvegarde de l'agent), contre le fichier actuel.
  await A.ev(`document.querySelector('#files li[data-path="src/main.cs"] > .row').click()`);
  await A.waitFor(`[...document.querySelectorAll('#files .preview .tabs button')].some((b) => b.textContent === 'Diff de la session')`, 5_000);
  await A.ev(`[...document.querySelectorAll('#files .preview .tabs button')].find((b) => b.textContent === 'Diff de la session').click()`);
  await A.waitFor(`document.querySelector('#files .preview .diff')`, 5_000, 'diff de la session');
  const diff = await A.ev(`[...document.querySelectorAll('#files .preview .diff > div')].map((d) => d.className + ':' + d.textContent.trim())`);
  assert.ok(diff.includes('del:-        Console.WriteLine("a");') && diff.includes('add:+        Console.WriteLine("b");'), diff.join('\n'));
  assert.ok(diff.some((d) => d.startsWith('ctx:') && d.includes('class Program')), 'le fichier entier, pas seulement le passage');
  // Annuler toute la demande : plus de badge.
  await A.ev(`T.button('Annuler toute la demande', [...document.querySelectorAll('#messages .msg.assistant')].pop())`);
  await A.waitFor(`!document.querySelector('#files .badge')`, 10_000, 'badges retirés après l\'annulation');
  assert.ok(!fs.existsSync(path.join(PA, 'nouveau.txt')));
  // Sans sauvegarde (étapes de Claude Agent) : les diffs des étapes.
  await A.ev(`(() => { S.current.messages.push({ role: 'user', content: 'x' }, { role: 'assistant', content: 'ok', agent: { request: 'rclaude', steps: [{ id: 's1', request: 'rclaude', kind: 'edit', path: 'notes.txt', status: 'done', title: 'Modification de notes.txt (+1 −1)', diff: [['-', 'notes'], ['+', 'notes 2']] }] } }); renderMessages(); return true; })()`);
  // Le panneau relu (fermé puis rouvert : chaque bascule attend la précédente).
  await A.ev(`document.getElementById('files-btn').click()`);
  await A.waitFor(`document.getElementById('files').hidden`, 5_000);
  await A.ev(`document.getElementById('files-btn').click()`);
  await A.waitFor(`document.querySelector('#files li[data-path="notes.txt"] .badge')?.textContent === 'M'`, 10_000, 'badge des étapes de Claude Agent');
  await A.ev(`document.querySelector('#files li[data-path="notes.txt"] > .row').click()`);
  await A.waitFor(`[...document.querySelectorAll('#files .preview .tabs button')].some((b) => b.textContent === 'Diff de la session')`, 5_000);
  await A.ev(`[...document.querySelectorAll('#files .preview .tabs button')].find((b) => b.textContent === 'Diff de la session').click()`);
  await A.waitFor(`document.querySelector('#files .preview')?.textContent.includes('Modification de notes.txt (+1 −1)')`, 5_000, 'diff des étapes');
  await A.ev(`S.current.messages.splice(-2); renderMessages(); true`);
});

// --- Notifications, aide « ? », taille du texte -----------------------------------------------------------------

test('notifications discrètes : en bas à droite, 4 au plus, fermables, durée selon le genre', async () => {
  await A.ev(`document.getElementById('toasts').replaceChildren(); true`);
  const r = await A.ev(`(() => { const t = document.getElementById('toasts').getBoundingClientRect(); return [t.right > innerWidth - 40, getComputedStyle(document.getElementById('toasts')).bottom]; })()`);
  assert.equal(r[0], true);
  assert.notEqual(r[1], 'auto', 'en bas');
  // Six notifications : les quatre dernières restent.
  await A.ev(`(async () => { const m = await import('./js/util.js'); for (let i = 1; i <= 6; i++) m.toast('note ' + i, '', 0); return true; })()`);
  assert.deepEqual(await A.ev(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent)`), ['note 3', 'note 4', 'note 5', 'note 6']);
  await A.ev(`document.querySelector('#toasts .toast .toast-close').click()`);
  assert.equal(await A.ev(`document.querySelectorAll('#toasts .toast').length`), 3, 'la croix ferme');
  // Un succès part tout seul (3 s) ; une erreur est annoncée (role alert).
  await A.ev(`(async () => { const m = await import('./js/util.js'); document.getElementById('toasts').replaceChildren(); m.toast('réussi', 'success'); m.toast('raté', 'error'); return true; })()`);
  assert.equal(await A.ev(`document.querySelector('#toasts .toast.error').getAttribute('role')`), 'alert');
  await sleep(3500);
  assert.deepEqual(await A.ev(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent)`), ['raté']);
});

test('aide « ? » des raccourcis, et taille du texte (Ctrl + = / - / 0, réglage)', async () => {
  await A.ev(`T.type('')`);
  await A.ev(`T.key('?', {}, document.getElementById('input'))`);
  await A.waitFor(`T.dialog()?.textContent.includes('Raccourcis clavier')`, 5_000, 'aide');
  const keys = await A.ev(`T.dialog().textContent`);
  for (const k of ['Ctrl+K', 'Ctrl+Maj+E', 'zoom', '?']) assert.ok(keys.includes(k), k);
  await A.ev(`T.key('Escape', {}, document)`);
  // Dans une saisie déjà remplie, « ? » s'écrit.
  await A.ev(`T.type('Pourquoi')`);
  await A.ev(`T.key('?', {}, document.getElementById('input'))`);
  await sleep(300);
  assert.equal(await A.ev(`!!T.dialog()`), false);
  await A.ev(`T.type('')`);
  // Taille du texte : la page entière (zoom), enregistrée.
  const base = await A.ev(`devicePixelRatio`);
  await A.ev(`T.key('=', { ctrlKey: true }, document)`);
  await A.waitFor(`S.settings.textSize === 110`, 5_000);
  await A.waitFor(`Math.abs(devicePixelRatio / ${base} - 1.1) < 0.02`, 5_000, 'page agrandie');
  await A.ev(`T.key('-', { ctrlKey: true }, document)`);
  await A.ev(`T.key('-', { ctrlKey: true }, document)`);
  await A.waitFor(`S.settings.textSize === 90`, 5_000);
  await A.ev(`T.key('0', { ctrlKey: true }, document)`);
  await A.waitFor(`S.settings.textSize === 100 && Math.abs(devicePixelRatio - ${base}) < 0.02`, 5_000, 'taille normale');
  await A.waitFor(`window.__TAURI__.core.invoke('get_settings').then((s) => s.textSize === 100)`, 5_000, 'taille enregistrée');
  await A.ev(`T.key(',', { ctrlKey: true }, document)`);
  await A.waitFor(`T.row('textSize')?.querySelector('input[type=range][max="150"][min="80"][step="10"]')`, 10_000, 'réglage du zoom');
  await A.ev(`T.key('Escape', {}, document)`);
});

// --- Assistant du premier lancement ----------------------------------------------------------------------------

test('premier lancement : l\'assistant en 3 étapes, puis le choix fait', async () => {
  const B = await launch({ settings: { onboarded: false } });
  try {
    await B.waitFor(`T.dialog()?.classList.contains('wizard')`, 10_000, 'assistant');
    const step = () => B.ev(`[...document.querySelectorAll('.wizard .step-dot')].map((d) => d.className.replace('step-dot', '').trim() || '-').join()`);
    assert.equal(await step(), 'on,-,-');
    assert.match(await B.ev(`T.dialog().textContent`), /Bienvenue dans Nel Code/);
    await B.ev(`document.querySelector('.wizard .swatch[data-accent="orange"]').click()`);
    assert.equal(await B.ev(`document.documentElement.dataset.accent`), 'orange');
    await B.ev(`T.button('Suivant', T.dialog())`);
    assert.equal(await step(), 'done,on,-');
    assert.equal(await B.ev(`document.querySelectorAll('.wizard .choice').length`), 4);
    await B.ev(`document.querySelector('.wizard .choice[data-source="catalog"]').click()`);
    await B.ev(`T.button('Suivant', T.dialog())`);
    assert.equal(await step(), 'done,done,on');
    assert.match(await B.ev(`T.dialog().textContent`), /Ton dossier de travail/);
    await B.ev(`T.button('Précédent', T.dialog())`);
    assert.equal(await step(), 'done,on,-');
    await B.ev(`T.button('Suivant', T.dialog())`);
    await B.ev(`T.button('Commencer', T.dialog())`);
    // Le choix : le catalogue s'ouvre ; la couleur et « fait » sont gardés.
    await B.waitFor(`!!document.querySelector('.catalog')`, 10_000, 'catalogue ouvert');
    const s = B.readJson('settings.json');
    assert.deepEqual([s.onboarded, s.accent], [true, 'orange']);
    assert.ok(s.currentProject, 'le dossier de travail devient le projet');
  } finally { await B.close(); }
  // Déjà des conversations : pas d'assistant, et « fait » est noté.
  const C = await launch({ settings: { onboarded: false }, files: { 'sessions/2026-01-01_10-00-00-000.json': session('2026-01-01_10-00-00-000', TMP, 'Ancienne', '2026-01-01T10:00:00.000+01:00') } });
  try {
    await sleep(1500);
    assert.equal(await C.ev(`!!document.querySelector('.wizard')`), false);
    assert.equal(C.readJson('settings.json').onboarded, true);
  } finally { await C.close(); }
});

test('premier lancement : « Passer » ferme l\'assistant pour de bon', async () => {
  const B = await launch({ settings: { onboarded: false } });
  try {
    await B.waitFor(`T.dialog()?.classList.contains('wizard')`, 10_000);
    await B.ev(`T.button('Passer', T.dialog())`);
    await B.waitFor(`!T.dialog() && S.settings.onboarded === true`, 5_000, 'assistant fermé, noté fait');
    assert.equal(B.readJson('settings.json').onboarded, true);
  } finally { await B.close(); }
});
