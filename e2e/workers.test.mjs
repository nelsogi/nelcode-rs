// Les travailleurs du mode Agent (spawn_worker, revise_worker), avec un faux serveur à outils : attribution exclusive
// des fichiers, refus de tout ce qui sort des fichiers attribués (et des fichiers protégés, des commandes…), brouillon
// jamais écrit sans accord, revue groupée (par travailleur puis par fichier, Accepter / Refuser, Tout accepter),
// plan avec les travailleurs, correction, Stop qui jette les brouillons après confirmation, limites et suivi « worker ».
// Usage : cargo build -p nel-desktop ; node --test e2e/workers.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { fr, launch, sleep } from './harness.mjs';

let server, A, DIR, PROVIDER;
const chats = [];   // les requêtes de l'agent principal
const workers = [];   // les requêtes des travailleurs
let active = 0, maxActive = 0;   // les travailleurs en cours de réponse (parallélisme)

const call = (name, args) => ({ name, args });
const work = (task, files, plan_task) => call('spawn_worker', plan_task ? { task, files, plan_task } : { task, files });
// L'agent principal : n = nombre de résultats d'outils déjà reçus → [contenu, appels].
const MAIN = {
  chef: (n) => [
    ['Je planifie.', [call('update_plan', { tasks: [{ title: 'Interface', status: 'todo' }, { title: 'Logique', status: 'todo' }] })]],
    ['', [work('UI', ['src/ui'], 1), work('LOGIQUE', ['src/a.cs'], 2), work('CONFLIT', ['src/'])]],
    null, null,
    ['', [call('edit_file', { path: 'src/a.cs', old_text: 'un', new_text: 'uno' })]],
    ['', [call('revise_worker', { worker: 'T2', instructions: 'Remplace aussi un par 1' })]],
    ['Fini : à toi de revoir.', []],
  ][n],
  'chef-pirate': (n) => [
    ['', [work('PIRATE', ['src/ui']), work('X', ['.env']), work('Y', ['../dehors'])]],
    null, null,
    ['Vu.', []],
  ][n],
  'chef-refus': (n) => (n ? ['Écrit.', []] : ['', [work('ECRIT', ['src/neuf'])]]),
  'chef-tout': (n) => (n ? ['Écrit.', []] : ['', [work('ECRIT', ['src/neuf']), work('ECRIT2', ['src/autre'])]]),
  'chef-stop': () => ['', [work('LENT', ['s1']), work('LENT', ['s2']), work('LENT', ['s3'])]],
  'chef-stop-vide': () => ['', [work('ATTEND', ['s4'])]],
  'chef-limite': (n) => (n ? ['Limité.', []] : ['', [work('L', ['l1']), work('L', ['l2']), work('L', ['l3'])]]),
  'chef-seul': () => ['OK.', []],
  ouvrier: () => ['?', []],
};
// Un travailleur, selon sa tâche : [contenu, appels, délai en ms]. n : résultats d'outils déjà reçus.
const WORKER = (task, n, body) => {
  if (task === 'UI') return n ? ['UI faite.', []] : ['', [call('write_file', { path: 'src/ui/new.js', content: 'nouveau\n' }), call('edit_file', { path: 'src/ui/old.js', old_text: 'ancien', new_text: 'neuf' })]];
  if (task === 'LOGIQUE') {
    const rev = body.messages.findIndex((m) => m.role === 'user' && m.content?.startsWith('Correction demandée'));
    if (rev > 0) return body.messages.slice(rev).some((m) => m.role === 'tool') ? ['Corrigé : un → 1.', []] : ['', [call('edit_file', { path: 'src/a.cs', old_text: 'un', new_text: '1' })]];
    return [['', [call('edit_file', { path: 'src/a.cs', old_text: 'deux', new_text: '2' })]], ['', [call('read_file', { path: 'src/a.cs' })]]][n] ?? ['Logique faite.', []];
  }
  if (task === 'PIRATE') return n ? ['Rien écrit.', []] : ['', [
    call('write_file', { path: 'dehors.txt', content: 'x' }), call('edit_file', { path: 'src/a.cs', old_text: 'un', new_text: 'X' }),
    call('write_file', { path: 'src/ui/.env', content: 'S=1' }), call('read_file', { path: '.env' }),
    call('run_command', { program: 'node', args: ['-e', 'require("fs").writeFileSync("commande.txt", "x")'] }), call('spawn_worker', { task: 'encore', files: ['src'] }),
    call('spawn_explorer', { task: 'x' }), call('update_plan', { tasks: [{ title: 'Pirater', status: 'in_progress' }] }), call('mcp__srv__outil', {}),
  ]];
  if (task === 'ECRIT') return n ? ['Écrit.', []] : ['', [call('write_file', { path: 'src/neuf/x.js', content: 'x\n' })]];
  if (task === 'ECRIT2') return n ? ['Écrit.', []] : ['', [call('write_file', { path: 'src/autre/y.js', content: 'y\n' })]];
  if (task === 'LENT') {
    const dir = body.messages[0].content.match(/fichiers ou dossiers : (s\d)/)[1];
    return n ? ['Trop tard.', [], 15_000] : ['', [call('write_file', { path: `${dir}/x.txt`, content: 'x' })]];
  }
  if (task === 'ATTEND') return ['Trop tard.', [], 15_000];
  if (task === 'L') return ['', [call('list_files', {})]];
  return ['?', []];
};

function chat(res, body) {
  const worker = body.messages[0].content.startsWith('Tu es un travailleur');
  const n = body.messages.filter((m) => m.role === 'tool').length;
  let content, calls, delay;
  if (worker) {
    workers.push(body);
    active++;
    maxActive = Math.max(maxActive, active);
    res.on('close', () => active--);
    [content, calls, delay] = WORKER(body.messages[1].content, n, body);
  } else {
    chats.push(body);
    [content, calls, delay] = MAIN[body.model](n) ?? ['?', []];
  }
  setTimeout(() => answer(res, content, calls), delay ?? 0);
}

function answer(res, content, calls) {
  if (res.destroyed) return;   // Stop : la connexion est déjà fermée
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  if (content) send({ content });
  calls.forEach((c, i) => send({ tool_calls: [{ index: i, id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] }));
  send({}, calls.length ? 'tool_calls' : 'stop');
  res.end('data: [DONE]\n\n');
}

const FILES = {
  'src/a.cs': 'un\ndeux\n',
  'src/ui/old.js': 'ancien\n',
  '.env': 'MOTDEPASSE=secret\n',
  '.gitignore': '.env\n',
};
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(DIR, f));

before(async () => {
  server = http.createServer((req, res) => {
    res.on('error', () => {});
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      if (!req.url.startsWith('/v1/')) { res.writeHead(404); return res.end(); }
      if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: Object.keys(MAIN).map((id) => ({ id })) })); }
      chat(res, JSON.parse(data));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nelcode-workers-'));
  for (const [f, c] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(DIR, f)), { recursive: true }); fs.writeFileSync(path.join(DIR, f), c); }
  // Un dépôt git : le point de restauration est pris avant la demande.
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: DIR, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '--no-gpg-sign', '-m', 'init');
  A = await launch({ settings: { prices: [{ model: 'ouvrier', input: 1000, output: 2000 }] } });
  const p = await A.ev(`window.__TAURI__.core.invoke('save_provider', { id: null, name: 'Travailleurs factices', url: 'http://127.0.0.1:${server.address().port}/v1', key: null })`);
  PROVIDER = p.id;
  await A.ev(`window.__TAURI__.core.invoke('test_provider', { id: ${JSON.stringify(PROVIDER)} }).then(() => refreshProviders()).then(() => true)`);
  await A.ev(`S.current.workingDirectory = ${JSON.stringify(DIR)}; renderHeader(); true`);
});

after(async () => {
  await A?.ev(`window.__TAURI__.core.invoke('delete_provider', { id: ${JSON.stringify(PROVIDER)} })`).catch(() => {});
  await A?.close();
  server?.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

const lastMsg = () => A.ev(`S.current.messages.at(-1)`);
const msgEl = `[...document.querySelectorAll('#messages .msg.assistant')].pop()`;
const genSteps = () => A.ev(`S.gen.steps`);
const settings = (changes) => A.ev(`window.__TAURI__.core.invoke('save_settings', { changes: ${JSON.stringify(changes)} }).then((s) => (S.settings = s, true))`);
const usage = () => fs.readFileSync(path.join(A.home, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const review = `${msgEl}.querySelector('.step.review')`;
const reviewPending = () => A.waitFor(`${review}?.dataset.status === 'pending'`, 15_000, 'revue en attente');
const pick = (file, choice) => A.ev(`${review}.querySelector('.review-file[data-path="${file}"] [data-choice="${choice}"]').click(), true`);
const action = (a) => A.ev(`${review}.querySelector('[data-action="${a}"]').click(), true`);

async function start(model, text) {
  await A.ev(`(() => { [...document.querySelectorAll('#models li.remote')].find((li) => li.dataset.model === ${JSON.stringify(model)}).click(); return true; })()`);
  await A.waitFor(`S.model.remote?.model === ${JSON.stringify(model)}`, 5_000);
  if (!(await A.ev(`!!S.current.agent`))) await A.ev(`document.getElementById('agent-btn').click()`);
  await A.waitFor(`S.current.agent === true`, 5_000);
  await A.ev(`T.submit(${JSON.stringify(text)})`);
  await A.waitFor('!!S.gen', 10_000, 'début de la demande');
}
const finish = () => A.waitFor('!S.gen', 30_000, 'fin de la demande');

test('attribution exclusive, plan des travailleurs, brouillon vu par ses lectures, correction, puis revue groupée', async () => {
  await start('chef', 'Refais l\'interface et la logique');
  await reviewPending();
  // Rien n'est écrit avant la revue.
  assert.ok(!exists('src/ui/new.js'));
  assert.equal(read('src/ui/old.js'), 'ancien\n');
  assert.equal(read('src/a.cs'), 'un\ndeux\n');
  const steps = await genSteps();
  const ws = steps.filter((s) => s.kind === 'worker' && s.worker);
  assert.deepEqual(ws.map((s) => [fr(s.title), s.status, s.files]), [['Travailleur T1 : UI', 'done', ['src/ui']], ['Travailleur T2 : LOGIQUE', 'done', ['src/a.cs']]]);
  // Le troisième chevauche T1 : refusé, avec l'explication pour l'agent.
  const conflict = steps.find((s) => s.kind === 'worker' && s.status === 'error');
  assert.match(fr(conflict.detail), /« src » est déjà attribué au travailleur T1 \(src\/ui\)/);
  const results = chats.at(-1).messages.filter((x) => x.role === 'tool').map((x) => x.content);
  assert.match(results[1], /^Travailleur T1 \(« UI »\) : terminé\.\nRésumé :\nUI faite\./);
  assert.match(results[1], /- src\/ui\/new\.js : créé \(\+1 −0\)\n- src\/ui\/old\.js : modifié \(\+1 −1\)/);
  assert.match(results[1], /--- src\/ui\/old\.js\n-ancien\n\+neuf/);
  assert.match(results[3], /déjà attribué au travailleur T1/);
  // L'agent principal ne peut pas écrire un fichier attribué.
  assert.match(results[4], /« src\/a\.cs » est attribué au travailleur T2 \(src\/a\.cs\)/);
  // La correction reprend la conversation et le brouillon de T2.
  assert.match(results[5], /^Travailleur T2 \(« LOGIQUE »\) : terminé\.\nRésumé :\nCorrigé : un → 1\./);
  assert.match(results[5], /--- src\/a\.cs\n-un\n-deux\n\+1\n\+2/);
  const t2 = workers.filter((b) => b.messages[1].content === 'LOGIQUE');
  assert.ok(t2.at(-1).messages.some((m) => m.role === 'assistant' && m.content === 'Logique faite.'), 'sa conversation est gardée');
  assert.match(t2.at(-1).messages.find((m) => m.role === 'tool' && m.content.includes('    1  un')).content, /    2  2/, 'sa lecture voit son brouillon');
  assert.equal(steps.filter((s) => s.parent === ws[1].id).map((s) => s.id).join(), [1, 2, 3].map((k) => `${ws[1].id}e${k}`).join(), 'numérotation continue après la correction');
  // Les travailleurs n'ont que leurs outils et leur propre conversation.
  assert.ok(workers.every((b) => b.tools.map((t) => t.function.name).join() === 'list_files,read_file,search,write_file,edit_file'));
  assert.ok(workers.every((b) => !JSON.stringify(b.messages).includes('Refais l\'interface')));
  assert.match(workers.find((b) => b.messages[1].content === 'UI').messages[0].content, /que ces fichiers ou dossiers : src\/ui\./);
  assert.ok(chats[0].tools.some((t) => t.function.name === 'spawn_worker') && chats[0].tools.some((t) => t.function.name === 'revise_worker'));
  assert.match(chats[0].messages[0].content, /spawn_worker\(task, files, plan_task\)/);
  // Le plan : chaque tâche avec son travailleur et son état.
  assert.equal(await A.ev(`[...document.querySelectorAll('#plan li')].map((li) => li.dataset.worker + ':' + li.dataset.status + ':' + li.querySelector('.plan-worker')?.dataset.workerStatus).join()`), 'T1:done:done,T2:done:done');
  // La revue : par travailleur puis par fichier.
  const rv = steps.find((s) => s.kind === 'review');
  assert.deepEqual(rv.workers.map((g) => [g.worker, g.files.map((f) => [f.path, f.created])]), [['T1', [['src/ui/new.js', true], ['src/ui/old.js', false]]], ['T2', [['src/a.cs', false]]]]);
  assert.equal(await A.ev(`${review}.querySelector('[data-action="validate"]').disabled`), true, 'Valider attend chaque fichier');
  await pick('src/ui/new.js', 'accepted');
  await pick('src/ui/old.js', 'rejected');
  assert.equal(await A.ev(`${review}.querySelector('[data-action="validate"]').disabled`), true);
  await pick('src/a.cs', 'accepted');
  assert.match(await A.ev(`${review}.querySelector('[data-action="validate"]').textContent`), /Valider : 2 accepté\(s\), 1 refusé\(s\)/);
  await action('validate');
  await finish();
  assert.equal(read('src/ui/new.js'), 'nouveau\n');
  assert.equal(read('src/ui/old.js'), 'ancien\n', 'refusé : inchangé');
  assert.equal(read('src/a.cs'), '1\n2\n');
  const m = await lastMsg();
  assert.equal(m.content, 'Fini : à toi de revoir.');
  assert.ok(m.agent.checkpoint?.id, 'point de restauration pris avant');
  const done = m.agent.steps.find((s) => s.kind === 'review');
  assert.equal(done.status, 'done');
  assert.equal(fr(done.title), 'Revue des changements des travailleurs : 2 accepté(s), 1 refusé(s), 0 en erreur');
  assert.deepEqual(done.workers.flatMap((g) => g.files.map((f) => f.decision)), ['accepted', 'rejected', 'accepted']);
  // Les fichiers écrits sont des écritures ordinaires : Annuler marche.
  const written = m.agent.steps.filter((s) => !s.parent && s.worker && (s.kind === 'write' || s.kind === 'edit'));
  assert.deepEqual(written.map((s) => [s.path, s.status, s.worker]), [['src/ui/new.js', 'accepted', 'T1'], ['src/a.cs', 'accepted', 'T2']]);
  await A.ev(`window.__TAURI__.core.invoke('agent_undo', { request: ${JSON.stringify(m.agent.request)}, step: ${JSON.stringify(written[1].id)} })`);
  assert.equal(read('src/a.cs'), 'un\ndeux\n');
  assert.equal(await A.ev(`${msgEl}.querySelectorAll('.undo-all').length`), 1);
  // Le plan gardé avec la conversation ; les tokens des travailleurs dans le Suivi.
  assert.deepEqual(m.plan ?? (await A.ev(`S.current.plan.tasks`)).map((t) => [t.worker, t.workerStatus, t.status]), [['T1', 'done', 'done'], ['T2', 'done', 'done']]);
  const lines = usage();
  assert.equal(lines.filter((l) => l.kind === 'worker').length, 3, 'T1, T2, et la correction de T2');
  assert.ok(!JSON.stringify(lines).includes('UI faite'), 'jamais le texte');
  fs.rmSync(path.join(DIR, 'src/ui/new.js'));
});

test('un travailleur n\'écrit que ses fichiers, dans son brouillon : hors portée, protégé, commande, MCP, plan, sous-agents refusés, sans confirmation', async () => {
  await start('chef-pirate', 'Fouille');
  await finish();
  const m = await lastMsg();
  assert.ok(!exists('dehors.txt') && !exists('commande.txt') && !exists('src/ui/.env'));
  assert.equal(read('src/a.cs'), 'un\ndeux\n');
  assert.ok(!m.agent.steps.some((s) => s.status === 'pending' || s.kind === 'review'), 'aucune confirmation, pas de revue sans brouillon');
  assert.ok(!m.plan, 'le plan n\'est pas touché');
  const results = workers.at(-1).messages.filter((x) => x.role === 'tool').map((x) => x.content);
  assert.match(results[0], /« dehors\.txt » n'est pas attribué à ce travailleur : il ne peut écrire que src\/ui/);
  assert.match(results[1], /« src\/a\.cs » n'est pas attribué à ce travailleur/);
  assert.match(results[2], /refusé : « src\/ui\/\.env » est un fichier protégé \(\.env\), un travailleur ne peut pas l'écrire/);
  assert.match(results[3], /refusé : « \.env » est un fichier protégé \(\.env\), un travailleur ne peut pas le lire/);
  for (const k of [4, 5, 6, 7, 8]) assert.match(results[k], /n'est pas permis à un travailleur/);
  assert.ok(!JSON.stringify(workers.at(-1)).includes('MOTDEPASSE=secret'), 'le contenu protégé ne part jamais');
  assert.equal(m.agent.steps.filter((s) => s.kind === 'worker').length, 3, 'pas de travailleur de travailleur');
  // L'agent principal : les refus d'attribution (protégé, hors du dossier), et les fichiers protégés signalés.
  const toAgent = chats.at(-1).messages.filter((x) => x.role === 'tool').map((x) => x.content);
  assert.match(toAgent[0], /Brouillon vide : aucun fichier changé\.\nFichiers protégés que le travailleur n'a pas pu lire ni écrire : \.env, src\/ui\/\.env/);
  assert.match(toAgent[1], /« \.env » est un fichier protégé \(\.env\) : un travailleur ne peut pas l'écrire/);
  assert.match(toAgent[2], /\.\./);
});

test('brouillon jamais écrit sans accord : Tout refuser ne touche à rien ; Tout accepter écrit tout', async () => {
  await start('chef-refus', 'Écris');
  await reviewPending();
  assert.ok(!exists('src/neuf/x.js'));
  const drafts = (await genSteps()).filter((s) => s.status === 'draft');
  assert.deepEqual(drafts.map((s) => [s.path, s.kind]), [['src/neuf/x.js', 'write']]);
  await action('reject_all');
  await finish();
  assert.ok(!exists('src/neuf/x.js') && !exists('src/neuf'));
  let m = await lastMsg();
  assert.deepEqual(m.agent.steps.find((s) => s.kind === 'review').workers[0].files.map((f) => f.decision), ['rejected']);
  assert.ok(!m.agent.steps.some((s) => !s.parent && s.kind === 'write'));
  await start('chef-tout', 'Écris tout');
  await reviewPending();
  assert.ok(!exists('src/neuf/x.js') && !exists('src/autre/y.js'));
  await action('accept_all');
  await finish();
  assert.equal(read('src/neuf/x.js'), 'x\n');
  assert.equal(read('src/autre/y.js'), 'y\n');
  m = await lastMsg();
  assert.equal(fr(m.agent.steps.find((s) => s.kind === 'review').title), 'Revue des changements des travailleurs : 2 accepté(s), 0 refusé(s), 0 en erreur');
  fs.rmSync(path.join(DIR, 'src/neuf'), { recursive: true });
  fs.rmSync(path.join(DIR, 'src/autre'), { recursive: true });
});

test('Stop : confirmation si des brouillons existent (Annuler continue), puis tout s\'arrête et les brouillons sont jetés ; sans brouillon, pas de question', async () => {
  maxActive = 0;
  const before = workers.length;
  await start('chef-stop', 'Travaille longtemps');
  await A.waitFor(`S.gen?.steps.filter((s) => s.status === 'draft').length === 2 && [...${msgEl}.querySelectorAll('.step.worker')].map((s) => s.dataset.status).join() === 'running,running,waiting'`, 15_000, 'deux brouillons, un en attente');
  assert.equal(maxActive, 2, 'au plus 2 travailleurs en même temps');
  await A.ev(`T.key('Escape', {}, document)`);
  await A.waitFor(`!document.getElementById('overlay').hidden`, 5_000, 'confirmation');
  assert.match(await A.ev(`document.querySelector('#overlay .dialog').textContent`), /Arrêter et jeter les brouillons \?.*changements dans 2 fichiers/);
  await A.ev(`T.key('Escape', {}, document)`);   // Annuler
  await sleep(300);
  assert.ok(await A.ev(`!!S.gen`), 'Annuler : la demande continue');
  await A.ev(`T.key('Escape', {}, document)`);
  await A.waitFor(`!document.getElementById('overlay').hidden`, 5_000);
  const t = Date.now();
  await A.ev(`document.querySelector('#overlay .btn.danger').click()`);
  await finish();
  assert.ok(Date.now() - t < 5_000, 'arrêt immédiat');
  const m = await lastMsg();
  assert.deepEqual(m.agent.steps.filter((s) => s.kind === 'worker').map((s) => s.status), ['stopped', 'stopped', 'stopped']);
  assert.deepEqual(m.agent.steps.filter((s) => s.parent && s.kind === 'write').map((s) => s.status), ['discarded', 'discarded']);
  assert.ok(!m.agent.steps.some((s) => s.kind === 'review'));
  for (const d of ['s1', 's2', 's3']) assert.ok(!exists(d), `rien d'écrit dans ${d}`);
  await sleep(300);
  assert.equal(workers.length - before, 4, 'deux tours chacun pour les deux premiers ; le troisième n\'a jamais commencé');
  assert.equal(active, 0, 'connexions fermées');
  // Sans brouillon : Stop tout de suite.
  await start('chef-stop-vide', 'Attends');
  await A.waitFor(`${msgEl}.querySelector('.step.worker')?.dataset.status === 'running'`, 10_000);
  await A.ev(`T.key('Escape', {}, document)`);
  await finish();
  assert.ok(await A.ev(`document.getElementById('overlay').hidden`));
});

test('limites (travailleurs par demande, tours), 0 : pas de travailleurs ; réglages ; modèle des travailleurs', async () => {
  await settings({ workerMax: 2, workerTurns: 2, workerModel: { provider: PROVIDER, model: 'ouvrier' } });
  const before = workers.length;
  await start('chef-limite', 'Divise');
  await finish();
  const m = await lastMsg();
  const ws = m.agent.steps.filter((s) => s.kind === 'worker');
  assert.deepEqual(ws.map((s) => s.status), ['done', 'done', 'error']);
  assert.match(fr(ws[2].detail), /limite atteinte : 2 travailleurs au plus par demande/);
  const mine = workers.slice(before);
  assert.equal(mine.length, 4);
  assert.ok(mine.every((b) => b.model === 'ouvrier'), 'modèle des travailleurs');
  assert.equal(chats.at(-1).model, 'chef-limite');
  assert.equal(mine.filter((b) => b.messages.at(-1).content?.startsWith('Dernier tour')).length, 2);
  const results = chats.at(-1).messages.filter((x) => x.role === 'tool').map((x) => x.content);
  assert.match(results[0], /limite de 2 tours sans résumé\. Ce qu'il a fait :\n- Liste du dossier de travail/);
  const sub = usage().filter((l) => l.kind === 'worker' && l.model === 'ouvrier');
  assert.equal(sub.length, 2);
  assert.ok(sub[0].cost > 0, 'prix du modèle des travailleurs');
  // 0 : ni les outils ni les consignes.
  await settings({ workerMax: 0 });
  await start('chef-seul', 'Rien');
  await finish();
  assert.ok(!chats.at(-1).tools.some((t) => t.function.name.endsWith('_worker')));
  assert.ok(!chats.at(-1).messages[0].content.includes('spawn_worker'));
  await settings({ workerMax: 4, workerTurns: 10, workerModel: null });
  // Les réglages : trois curseurs et le choix du modèle, dans le groupe « Travailleurs ».
  await A.ev(`openSettings('agent')`);
  await A.waitFor(`T.settings()?.textContent.includes('Travailleurs en même temps')`, 10_000);
  assert.ok(await A.ev(`T.settings().textContent.includes('Travailleurs par demande') && T.settings().textContent.includes('Tours par travailleur')`));
  assert.equal(await A.ev(`T.settings().querySelector('select.worker-model').value`), '');
  await A.ev(`T.key('Escape', {}, document)`);
});
