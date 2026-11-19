// Résumé du contexte et commandes personnalisées, avec un faux serveur compatible OpenAI :
// - résumé automatique (seuil, 4 derniers échanges gardés, bloc repliable, messages grisés, barre de contexte, réglage,
//   conversation modifiée), /compact [consigne], étapes de l'agent en lignes courtes, anciens résultats d'outils réduits
//   dans la boucle de l'agent, .nelmodel et Claude Agent exclus ;
// - commandes .md (projet et globales) : suggestions, palette, $ARGUMENTS, priorité, jamais une commande intégrée,
//   mode Agent sans contournement, /commands et création.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { launch, MODEL } from './harness.mjs';

let server, A, OUT, DIR;
const chats = [];   // les requêtes de chat reçues
let summaries = 0;

const call = (name, args) => ({ name, args });
// Les faux modèles à outils : n = nombre de résultats d'outils déjà reçus → [contenu, appels].
const SCRIPTS = {
  'agent-lecteur': (n) => [['', [call('read_file', { path: 'a.txt' })]], ['', [call('read_file', { path: 'b.txt' })]]][n] ?? ['Lu.', []],
  'agent-ecrivain': (n) => (n ? ['Fait.', []] : ['', [call('write_file', { path: 'nouveau.txt', content: 'x\n' })]]),
};

function chat(req, res, body) {
  chats.push(body);
  const n = body.messages.filter((m) => m.role === 'tool').length;
  const last = body.messages.at(-1).content;
  let content, calls = [];
  if (SCRIPTS[body.model]) [content, calls] = SCRIPTS[body.model](n);
  else if (typeof last === 'string' && last.startsWith('Résume les échanges')) content = `RÉSUMÉ-FAUX ${++summaries}`;
  else content = `Réponse ${chats.length}.`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  if (content) send({ content });
  calls.forEach((c, i) => send({ tool_calls: [{ index: i, id: `call_${n}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] }));
  send({}, calls.length ? 'tool_calls' : 'stop');
  res.end('data: [DONE]\n\n');
}

const lineText = (k) => `ligne ${k} ` + 'x'.repeat(20);
const seed = {
  id: '2026-02-01_10-00-00-000', model: 'x', agent: true, date: '2026-02-01T10:00:00.000+01:00',
  plan: { request: 'r1', tasks: [{ title: 'Corriger', status: 'in_progress' }] },
  messages: Array.from({ length: 6 }, (_, k) => [
    { role: 'user', content: `Demande ${k + 1}` },
    { role: 'assistant', content: `Fait ${k + 1}.`, ...(k ? {} : { agent: { request: 'r1', steps: [
      { kind: 'read', title: 'Lecture de src/Player.cs', path: 'src/Player.cs', detail: Array.from({ length: 120 }, () => 'CONTENU-SECRET-DU-FICHIER').join('\n'), status: 'done' },
      { kind: 'write', title: 'Création de src/New.cs', path: 'src/New.cs', status: 'accepted' },
      { kind: 'command', title: 'Commande dotnet', command: 'dotnet build', status: 'done', detail: 'SORTIE-DE-COMMANDE-LONGUE' },
      { kind: 'error', title: 'Échec de la compilation', detail: 'CS1002', status: 'error' },
    ] } }) },
  ]).flat(),
};

before(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      if (!req.url.startsWith('/v1/')) { res.writeHead(404); return res.end(); }   // détection des images (/api/show, /props) : pas d'Ollama ici
      if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
      chat(req, res, JSON.parse(data));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'nelcode-context-'));
  DIR = path.join(OUT, 'projet');
  const files = {
    'a.txt': Array.from({ length: 60 }, (_, k) => lineText(k)).join('\n') + '\n',
    'b.txt': Array.from({ length: 60 }, (_, k) => lineText(k + 100)).join('\n') + '\n',
    '.nelcode/commands/review.md': '---\ndescription: Relire le projet\n---\nRelis le projet.\n',
    '.nelcode/commands/tests.md': '---\ndescription: Écrire des tests\n---\nÉcris des tests pour $ARGUMENTS, puis relis $ARGUMENTS.\n',
    '.nelcode/commands/ecrire.md': 'Crée le fichier nouveau.txt avec un titre.\n',
  };
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(DIR, f)), { recursive: true }); fs.writeFileSync(path.join(DIR, f), c); }
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const models = [{ id: 'petit', contextLength: 1000, maxTokens: 50 }, { id: 'inconnu' }, { id: 'agent-lecteur', contextLength: 1000, maxTokens: 50 }, { id: 'agent-ecrivain' }];
  A = await launch({
    settings: { providers: [{ id: 'pfake', name: 'Faux', url, models }] },
    files: {
      [`sessions/${seed.id}.json`]: JSON.stringify({ ...seed, workingDirectory: DIR }),
      'commands/review.md': '---\ndescription: Globale cachée\n---\nRelis tout (globale).\n',
      'commands/hello.md': '---\ndescription: Dire bonjour\n---\nDis bonjour.\n',
      'commands/new.md': '---\ndescription: Ne doit jamais remplacer /new\n---\nPiège.\n',
    },
  });
});

after(async () => {
  await A?.close();
  server?.close();
  fs.rmSync(OUT, { recursive: true, force: true });
});

const big = (n) => `Q${n} ` + 'mot '.repeat(175);   // environ 700 caractères
const summaryRequests = (from = 0) => chats.slice(from).filter((c) => typeof c.messages.at(-1).content === 'string' && c.messages.at(-1).content.startsWith('Résume les échanges'));

async function pick(model) {
  await A.ev(`(() => { [...document.querySelectorAll('#models li.remote')].find((li) => li.dataset.model === ${JSON.stringify(model)}).click(); return true; })()`);
  await A.waitFor(`S.model.remote?.model === ${JSON.stringify(model)}`, 5_000, `choix de ${model}`);
}

/** Une conversation vide dans le dossier du projet. */
async function fresh() {
  await A.ev(`T.submit('/new')`);
  await A.waitFor(`S.current.messages.length === 0 && !S.gen`, 5_000, 'nouvelle conversation');
  await A.ev(`S.current.workingDirectory = ${JSON.stringify(DIR)}; renderHeader(); true`);
}

/** Envoie `text` et attend la réponse (le résumé automatique éventuel compris). */
async function exchange(text) {
  const n = await A.ev(`S.current.messages.length`);
  await A.ev(`T.submit(${JSON.stringify(text)})`);
  await A.waitFor(`S.current.messages.length >= ${n + 2} && !S.gen`, 30_000, `réponse à « ${text.slice(0, 20)} »`);
}

const save = (changes) => A.ev(`window.__TAURI__.core.invoke('save_settings', { changes: ${JSON.stringify(changes)} }).then((s) => (S.settings = s, true))`);
const toasts = () => A.ev(`T.toasts()`);
const clearToasts = () => A.ev(`document.getElementById('toasts').replaceChildren(); true`);

// --- Résumé automatique ----------------------------------------------------------------------------------

test('résumé automatique : les anciens échanges résumés, les 4 derniers gardés, le reste grisé, bloc repliable', async () => {
  await pick('petit');
  await fresh();
  for (let n = 1; n <= 5; n++) await exchange(big(n));
  assert.equal(summaryRequests().length, 0, 'moins de 5 échanges avant le nouveau : rien à résumer');
  await exchange(big(6));
  const sums = summaryRequests();
  assert.equal(sums.length, 1);
  const prompt = sums[0].messages.at(-1).content;
  assert.match(prompt, /décisions prises, les fichiers modifiés, le plan en cours et les erreurs non résolues/);
  assert.match(prompt, /Utilisateur : Q1 /);
  assert.ok(!prompt.includes('Q2 '), 'seul le premier échange est résumé : les 4 derniers + le nouveau restent');
  assert.equal(sums[0].messages.length, 1, 'le résumé ne reçoit que sa consigne');
  // Ce que le modèle lit : le résumé comme premier échange, puis les 4 derniers échanges et la question.
  const real = chats.at(-1).messages;
  assert.equal(real.length, 11);
  assert.deepEqual([real[0].role, real[0].content], ['user', 'Résumé des échanges précédents :\nRÉSUMÉ-FAUX 1']);
  assert.equal(real[1].role, 'assistant');
  assert.match(real[2].content, /^Q2 /);
  assert.match(real.at(-1).content, /^Q6 /);
  assert.ok(!JSON.stringify(real).includes('Q1 '), 'le premier échange n\'est plus envoyé');
  // La conversation garde tous les messages ; seul le résumé s'y ajoute.
  const s = await A.ev(`({ n: S.current.messages.length, summary: S.current.summary, id: S.current.id })`);
  assert.equal(s.n, 12);
  assert.deepEqual([s.summary.text, s.summary.upTo], ['RÉSUMÉ-FAUX 1', 2]);
  const disk = A.readJson(`sessions/${s.id}.json`);
  assert.deepEqual([disk.messages.length, disk.summary.upTo, disk.messages[0].content.slice(0, 3)], [12, 2, 'Q1 ']);
  // Affichage : 2 messages grisés, le bloc repliable à leur place, puis les 10 autres.
  assert.equal(await A.ev(`[...document.getElementById('messages').children].map((e) => e.className.includes('summary-block') ? 'S' : e.className.includes('faded') ? 'F' : 'M').join('')`), 'FFSMMMMMMMMMM');
  assert.deepEqual(await A.ev(`(() => { const d = document.querySelector('#messages .summary-block'); return [d.querySelector('summary').textContent, d.open, d.querySelector('.think').textContent]; })()`),
    ['Résumé des échanges précédents', false, 'RÉSUMÉ-FAUX 1']);
  await A.waitFor(`document.getElementById('context-text').textContent.includes('· résumé')`, 5_000, 'barre de contexte');
  // Un deuxième résumé reprend le premier.
  await exchange(big(7));
  const second = summaryRequests().at(-1).messages.at(-1).content;
  assert.match(second, /Résumé précédent :\nRÉSUMÉ-FAUX 1/);
  assert.match(second, /Utilisateur : Q2 /);
  assert.ok(!second.includes('Q3 '));
  assert.equal(await A.ev(`S.current.summary.upTo`), 4);
  // Modifier un message résumé : la conversation repart de là, le résumé tombe.
  await A.ev(`T.button('Modifier', document.querySelector('#messages .msg.user'))`);
  await A.ev(`(() => { const ta = document.querySelector('#messages textarea.edit-box'); ta.value = 'Nouveau départ'; T.key('Enter', {}, ta); return true; })()`);
  await A.waitFor(`S.current.messages.length === 2 && !S.gen`, 15_000, 'conversation relancée');
  assert.equal(await A.ev(`S.current.summary`), undefined);
  assert.deepEqual(chats.at(-1).messages, [{ role: 'user', content: 'Nouveau départ' }]);
});

test('réglage : 0 = jamais ; contexte inconnu = jamais ; le réglage est dans la fenêtre des réglages', async () => {
  await A.ev(`T.key(',', { ctrlKey: true }, document)`);
  await A.waitFor(`T.dialog()?.textContent.includes('Résumé automatique à')`, 10_000);
  assert.equal(await A.ev(`[...T.dialog().querySelectorAll('label.field')].find((l) => l.textContent.includes('Résumé automatique à')).querySelector('input').value`), '80', '80 % par défaut');
  await A.ev(`(() => { const f = [...T.dialog().querySelectorAll('label.field')].find((l) => l.textContent.includes('Résumé automatique à')); T.setValue(f.querySelector('input'), '0'); T.button('Enregistrer', T.dialog().querySelector('.buttons')); return true; })()`);
  await A.waitFor(`S.settings.summaryThreshold === 0`, 5_000, 'réglage enregistré');
  assert.equal(A.readJson('settings.json').summaryThreshold, 0);
  const from = chats.length;
  await pick('petit');
  await fresh();
  for (let n = 1; n <= 7; n++) await exchange(big(n));
  assert.equal(summaryRequests(from).length, 0);
  assert.equal(await A.ev(`S.current.summary`), undefined);
  await save({ summaryThreshold: 80 });
  await pick('inconnu');
  await fresh();
  for (let n = 1; n <= 7; n++) await exchange(big(n));
  assert.equal(summaryRequests(from).length, 0, 'sans taille de contexte connue, rien à comparer');
  await save({ summaryThreshold: 500 });
  assert.equal(await A.ev(`S.settings.summaryThreshold`), 95, 'borné à 95');
  await save({ summaryThreshold: 80 });
});

test('/compact [consigne] : à la main, avec la consigne ; rien à résumer sous 5 échanges', async () => {
  await pick('petit');
  await fresh();
  for (let n = 1; n <= 3; n++) await exchange(`Court ${n}`);
  await clearToasts();
  await A.ev(`T.submit('/compact')`);
  await A.waitFor(`T.toasts().includes('Rien à résumer')`, 5_000);
  assert.equal(await A.ev(`S.current.summary`), undefined);
  for (let n = 4; n <= 6; n++) await exchange(`Court ${n}`);
  const from = chats.length;
  await A.ev(`T.submit('/compact garde surtout les tests')`);
  await A.waitFor(`S.current.summary && !S.gen`, 15_000, 'résumé à la main');
  const prompt = summaryRequests(from)[0].messages.at(-1).content;
  assert.match(prompt, /Consigne de l'utilisateur : garde surtout les tests/);
  assert.match(prompt, /Utilisateur : Court 1\b/);
  assert.match(prompt, /Utilisateur : Court 2\b/);
  assert.ok(!prompt.includes('Court 3'), 'les 4 derniers échanges restent tels quels');
  assert.equal(await A.ev(`[S.current.summary.upTo, S.current.messages.length]`).then(String), '4,12', 'aucun message retiré');
  await A.waitFor(`T.toasts().includes('Échanges précédents résumés')`, 5_000);
  await exchange('Suite');
  const real = chats.at(-1).messages;
  assert.equal(real.length, 11);
  assert.match(real[0].content, /^Résumé des échanges précédents :\nRÉSUMÉ-FAUX \d+$/);
  assert.equal(real[2].content, 'Court 3');
});

test('résumé d\'une conversation Agent : étapes en lignes courtes, jamais le contenu des fichiers', async () => {
  await pick('petit');
  await A.ev(`openSession(S.sessions.find((s) => s.id === ${JSON.stringify(seed.id)})); true`);
  await A.waitFor(`S.current.id === ${JSON.stringify(seed.id)}`, 5_000);
  const from = chats.length;
  await A.ev(`T.submit('/compact')`);
  await A.waitFor(`S.current.summary && !S.gen`, 15_000, 'résumé');
  const prompt = summaryRequests(from)[0].messages.at(-1).content;
  assert.ok(prompt.includes('[fichier lu : src/Player.cs, 120 lignes]'));
  assert.ok(prompt.includes('[fichier créé : src/New.cs (accepté)]'));
  assert.ok(prompt.includes('[commande : dotnet build (done)]'));
  assert.ok(prompt.includes('[erreur : Échec de la compilation — CS1002]'));
  assert.ok(prompt.includes('Plan en cours :\n- Corriger (in_progress)'));
  assert.ok(!prompt.includes('CONTENU-SECRET-DU-FICHIER') && !prompt.includes('SORTIE-DE-COMMANDE-LONGUE'));
});

// --- Mode Agent : anciens résultats d'outils --------------------------------------------------------------

async function runReader() {
  await pick('agent-lecteur');
  await fresh();
  await A.ev(`document.getElementById('agent-btn').click()`);
  await A.waitFor(`S.current.agent === true`, 5_000);
  const from = chats.length;
  await A.ev(`T.submit('Lis a.txt puis b.txt')`);
  await A.waitFor(`S.current.messages.length === 2 && !S.gen`, 30_000, 'fin de la demande');
  return chats.slice(from).filter((c) => c.model === 'agent-lecteur');
}
const toolContents = (c) => c.messages.filter((m) => m.role === 'tool').map((m) => m.content);

test('mode Agent : les anciens résultats d\'outils deviennent une ligne courte quand le contexte est presque plein', async () => {
  const [, second, third] = await runReader();
  const full = toolContents(second)[0];
  assert.ok(full.length > 1500, 'tel quel tant que c\'est le dernier tour');
  const lines = full.replace(/\n$/, '').split('\n').length;
  const [a, b] = toolContents(third);
  assert.equal(a, `fichier lu : a.txt, ${lines} lignes`);
  assert.ok(b.length > 1500 && b.includes('ligne 100'), 'le dernier résultat reste entier');
});

test('mode Agent : réglage à 0, les résultats d\'outils restent entiers', async () => {
  await save({ summaryThreshold: 0 });
  const [, , third] = await runReader();
  assert.ok(toolContents(third).every((t) => t.length > 1500));
  await save({ summaryThreshold: 80 });
});

// --- Commandes personnalisées ----------------------------------------------------------------------------

const suggestions = () => A.ev(`[...document.querySelectorAll('#suggest .item')].map((i) => i.textContent)`);

test('suggestions /  : description et origine ; le projet remplace la globale ; jamais une commande intégrée', async () => {
  await pick('petit');
  await fresh();
  await A.ev(`T.type('/re')`);
  await A.waitFor(`[...document.querySelectorAll('#suggest .item')].some((i) => i.textContent.includes('/review'))`, 5_000, 'commandes du projet');
  const review = (await suggestions()).filter((t) => t.startsWith('/review'));
  assert.deepEqual(review, ['/reviewRelire le projet · projet']);
  await A.ev(`T.type('/he')`);
  await A.waitFor(`[...document.querySelectorAll('#suggest .item')].some((i) => i.textContent.includes('/hello'))`, 5_000);
  assert.deepEqual(await suggestions(), ['/helpListe des commandes', '/helloDire bonjour · globale']);
  await A.ev(`T.type('/ne')`);
  await A.waitFor(`[...document.querySelectorAll('#suggest .item')].some((i) => i.textContent.includes('/new'))`, 5_000);
  const news = (await suggestions()).filter((t) => t.startsWith('/new'));
  assert.deepEqual(news, ['/newNouvelle conversation'], 'la commande globale « new » est ignorée');
  await A.ev(`T.type('')`);
});

test('/nom texte : $ARGUMENTS remplacé tel quel, ajouté à la fin s\'il manque ; le projet gagne ; envoyé comme un message', async () => {
  const sent = async (line) => {
    await fresh();
    const from = chats.length;
    await A.ev(`T.submit(${JSON.stringify(line)})`);
    await A.waitFor(`S.current.messages.length === 2 && !S.gen`, 15_000, line);
    const request = chats.slice(from).at(-1).messages.at(-1).content;
    assert.equal(await A.ev(`S.current.messages[0].content`), request, 'le message de la conversation est celui que le modèle reçoit');
    return request;
  };
  assert.equal(await sent('/tests src/a.cs'), 'Écris des tests pour src/a.cs, puis relis src/a.cs.');
  assert.equal(await sent('/tests $& et $1'), 'Écris des tests pour $& et $1, puis relis $& et $1.', 'le texte tapé n\'est jamais interprété');
  assert.equal(await sent('/tests'), 'Écris des tests pour , puis relis .');
  assert.equal(await sent('/review'), 'Relis le projet.', 'la commande du projet remplace la globale');
  assert.equal(await sent('/review le module Player'), 'Relis le projet.\n\nle module Player');
  assert.equal(await sent('/hello Pierre'), 'Dis bonjour.\n\nPierre');
  assert.equal(await sent('/HELLO'), 'Dis bonjour.', 'nom insensible à la casse');
  // Une commande inconnue n'envoie rien ; /new reste la commande intégrée.
  await fresh();
  const from = chats.length;
  await clearToasts();
  await A.ev(`T.submit('/inexistante x')`);
  await A.waitFor(`T.toasts().includes('Commande inconnue : /inexistante')`, 5_000);
  await A.ev(`T.submit('/new')`);
  assert.equal(chats.length, from);
  assert.equal(await A.ev(`S.current.messages.length`), 0);
});

test('mode Agent : une commande n\'est qu\'un texte, l\'écriture demande toujours l\'accord', async () => {
  await pick('agent-ecrivain');
  await fresh();
  await A.ev(`document.getElementById('agent-btn').click()`);
  await A.waitFor(`S.current.agent === true`, 5_000);
  await A.ev(`T.submit('/ecrire')`);
  const step = `[...document.querySelectorAll('#messages .msg.assistant')].pop().querySelectorAll('.step')[0]`;
  await A.waitFor(`${step}?.dataset.status === 'pending'`, 15_000, 'écriture à valider');
  assert.equal(await A.ev(`S.current.messages[0].content`), 'Crée le fichier nouveau.txt avec un titre.');
  assert.ok(!fs.existsSync(path.join(DIR, 'nouveau.txt')), 'rien d\'écrit sans accord');
  await A.ev(`T.button('Refuser', ${step})`);
  await A.waitFor('!S.gen', 15_000);
  assert.ok(!fs.existsSync(path.join(DIR, 'nouveau.txt')));
  assert.equal(await A.ev(`S.current.messages.at(-1).agent.steps[0].status`), 'rejected');
});

test('palette Ctrl+K : commandes avec description et origine', async () => {
  await pick('petit');
  await fresh();
  await A.ev(`T.key('k', { ctrlKey: true }, document)`);
  await A.waitFor(`T.dialog()?.querySelector('input')`, 5_000);
  await A.ev(`T.setValue(T.dialog().querySelector('input'), 'review')`);
  await A.waitFor(`[...T.dialog().querySelectorAll('.item')].some((i) => i.textContent.includes('/review'))`, 5_000);
  const rows = await A.ev(`[...T.dialog().querySelectorAll('.item')].map((i) => i.textContent)`);
  assert.ok(rows.some((t) => t.startsWith('Commande/review — Relire le projet (projet)')), rows.join(' | '));
  await A.ev(`[...T.dialog().querySelectorAll('.item')].find((i) => i.textContent.startsWith('Commande')).click(); true`);
  await A.waitFor(`document.getElementById('input').value === '/review '`, 5_000, 'commande dans la saisie');
  await A.ev(`T.type('')`);
});

test('/commands : liste avec origine, commande ignorée signalée ; Nouvelle commande… crée un modèle sans rien écraser', async () => {
  await fresh();
  await A.ev(`T.submit('/commands')`);
  await A.waitFor(`T.dialog()?.textContent.includes('Commandes personnalisées') && T.dialog().textContent.includes('/hello')`, 5_000);
  const text = await A.ev(`T.dialog().textContent`);
  assert.match(text, /\/review.*Relire le projet · projet/);
  assert.match(text, /\/hello.*Dire bonjour · globale/);
  assert.match(text, /\/new.*Ne doit jamais remplacer \/new · globale · ignorée/);
  const create = async (name, description, scope) => {
    await A.ev(`T.button('Nouvelle commande', T.dialog())`);
    await A.waitFor(`T.dialog()?.querySelector('select')`, 5_000);
    await A.ev(`(() => { const [n, d] = T.dialog().querySelectorAll('input.text-input'); T.setValue(n, ${JSON.stringify(name)}); T.setValue(d, ${JSON.stringify(description)}); T.setValue(T.dialog().querySelector('select'), ${JSON.stringify(scope)}); T.button('Créer', T.dialog()); return true; })()`);
  };
  await clearToasts();
  await create('Neuve', 'Ma commande', 'project');
  await A.waitFor(`T.toasts().includes('Commande créée')`, 5_000);
  const file = path.join(DIR, '.nelcode', 'commands', 'neuve.md');
  assert.match(fs.readFileSync(file, 'utf8'), /^---\ndescription: Ma commande\n---\n.*\$ARGUMENTS/s);
  assert.match(fs.readFileSync(file, 'utf8'), /\nDécris ici ce que le modèle doit faire\./, 'modèle dans la langue de l\'interface');
  fs.writeFileSync(file, '---\ndescription: Ma commande\n---\nMon texte.\n');
  // Rien n'est écrasé, un nom invalide est refusé.
  await clearToasts();
  await A.ev(`T.submit('/commands')`);
  await A.waitFor(`T.dialog()?.textContent.includes('/neuve')`, 5_000);
  await create('neuve', '', 'project');
  await A.waitFor(`T.toasts().includes('existe déjà')`, 5_000);
  assert.match(fs.readFileSync(file, 'utf8'), /Mon texte/);
  await clearToasts();
  await A.ev(`T.submit('/commands')`);
  await A.waitFor(`T.dialog()?.textContent.includes('/neuve')`, 5_000);
  await create('Mauvais nom', '', 'project');
  await A.waitFor(`T.toasts().includes('nom invalide')`, 5_000);
  // Une commande globale, puis la commande créée s'utilise tout de suite.
  await clearToasts();
  await A.ev(`T.submit('/commands')`);
  await A.waitFor(`T.dialog()?.textContent.includes('/neuve')`, 5_000);
  await create('globale-test', 'Pour tous', 'global');
  await A.waitFor(`T.toasts().includes('Commande créée')`, 5_000);
  assert.ok(fs.existsSync(path.join(A.home, 'commands', 'globale-test.md')));
  await A.ev(`T.submit('/neuve')`);
  await A.waitFor(`S.current.messages.length === 2 && !S.gen`, 15_000);
  assert.equal(await A.ev(`S.current.messages[0].content`), 'Mon texte.');
});

// --- Exclusions ------------------------------------------------------------------------------------------

test('Claude Agent et .nelmodel : pas de résumé', { skip: !fs.existsSync(MODEL) && 'modèle de test absent' }, async () => {
  await fresh();
  await A.ev(`S.current.claudeAgent = {}; true`);
  await clearToasts();
  await A.ev(`T.submit('/compact')`);
  await A.waitFor(`T.toasts().includes('Claude Agent gère lui-même son contexte')`, 5_000);
  await A.ev(`delete S.current.claudeAgent; true`);
  await A.importAs('mini');
  await A.ev(`T.submit('/model mini')`);
  await A.waitFor(`S.model.name === 'mini' && !S.model.loading && !S.model.remote`, 120_000, 'chargement de mini');
  await fresh();
  await clearToasts();
  await A.ev(`T.submit('/compact')`);
  await A.waitFor(`T.toasts().includes('Pas de résumé avec un .nelmodel')`, 5_000);
});
