// Les explorateurs du mode Agent (spawn_explorer), avec un faux serveur à outils : explorateurs en parallèle (2 à la
// fois par défaut), étapes regroupées sous « Explorateur : … », limites des réglages, refus de tout ce qui n'est pas
// lecture et des fichiers protégés (sans confirmation possible), Stop qui arrête tout, suivi « subagent » et budget,
// modèle des explorateurs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { launch, sleep } from './harness.mjs';

let server, A, DIR, PROVIDER;
const chats = [];   // les requêtes de l'agent principal
const explorers = [];   // les requêtes des explorateurs
let active = 0, maxActive = 0;   // les explorateurs en cours de réponse (parallélisme)

const call = (name, args) => ({ name, args });
const spawn = (task) => call('spawn_explorer', { task });
// L'agent principal : n = nombre de résultats d'outils déjà reçus → [contenu, appels].
const MAIN = {
  chef: (n) => n ? ['Fini.', []] : ['Je délègue.', [spawn('A'), spawn('B'), spawn('C')]],
  'chef-limite': (n) => n ? ['Limité.', []] : ['', [spawn('L1'), spawn('L2'), spawn('L3')]],
  'chef-pirate': (n) => n ? ['Vu.', []] : ['', [spawn('pirate')]],
  'chef-stop': () => ['', [spawn('S1'), spawn('S2'), spawn('S3')]],
  'chef-leger': (n) => n ? ['Léger.', []] : ['', [spawn('A')]],
  'chef-seul': () => ['OK.', []],
  eclaireur: () => ['?', []],
};
// Un explorateur, selon sa tâche : [contenu, appels, délai en ms].
const EXPLORER = (task, n) => {
  if (['A', 'B', 'C'].includes(task)) return n ? [`Résumé ${task} : Program.cs crée un Player (ligne 3).`, [], 600] : ['', [call('read_file', { path: 'src/Program.cs' })], 600];
  if (task.startsWith('L')) return ['', [call('list_files', {})]];
  if (task.startsWith('S')) return ['Trop tard.', [], 15_000];
  if (task === 'pirate') return n ? ['Rien écrit.', []] : ['', [
    call('write_file', { path: 'pirate.txt', content: 'x' }), call('edit_file', { path: 'src/Program.cs', old_text: 'Player', new_text: 'X' }),
    call('run_command', { program: 'node', args: ['-e', 'require("fs").writeFileSync("commande.txt", "x")'] }), spawn('encore'),
    call('update_plan', { tasks: [{ title: 'Pirater', status: 'in_progress' }] }), call('read_file', { path: '.env' }), call('search', { query: 'motdepasse' }),
  ]];
  return ['?', []];
};

function chat(res, body) {
  const explorer = body.messages[0].content.startsWith('Tu es un explorateur');
  const n = body.messages.filter((m) => m.role === 'tool').length;
  let content, calls, delay;
  if (explorer) {
    explorers.push(body);
    active++;
    maxActive = Math.max(maxActive, active);
    res.on('close', () => active--);
    [content, calls, delay] = EXPLORER(body.messages[1].content, n);
  } else {
    chats.push(body);
    [content, calls, delay] = MAIN[body.model](n);
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
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nelcode-explorer-'));
  const files = {
    'src/Program.cs': 'class Program {\n    static void Main() {\n        var p = new Player();\n    }\n}\n',
    '.env': 'MOTDEPASSE=motdepasse-secret\n',
    'notes.txt': 'pas de motdepasse ici\n',
    'secrets.json': '{ "pw": "motdepasse-secret" }\n',
  };
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(DIR, f)), { recursive: true }); fs.writeFileSync(path.join(DIR, f), c); }
  // Un prix pour le modèle des explorateurs : leurs coûts comptent dans le budget.
  A = await launch({ settings: { prices: [{ model: 'eclaireur', input: 1000, output: 2000 }] } });
  const p = await A.ev(`window.__TAURI__.core.invoke('save_provider', { id: null, name: 'Explorateurs factices', url: 'http://127.0.0.1:${server.address().port}/v1', key: null })`);
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
const settings = (changes) => A.ev(`window.__TAURI__.core.invoke('save_settings', { changes: ${JSON.stringify(changes)} }).then((s) => (S.settings = s, true))`);
const usage = () => fs.readFileSync(path.join(A.home, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

async function start(model, text) {
  await A.ev(`(() => { [...document.querySelectorAll('#models li.remote')].find((li) => li.dataset.model === ${JSON.stringify(model)}).click(); return true; })()`);
  await A.waitFor(`S.model.remote?.model === ${JSON.stringify(model)}`, 5_000);
  if (!(await A.ev(`!!S.current.agent`))) await A.ev(`document.getElementById('agent-btn').click()`);
  await A.waitFor(`S.current.agent === true`, 5_000);
  await A.ev(`T.submit(${JSON.stringify(text)})`);
  await A.waitFor('!!S.gen', 10_000, 'début de la demande');
}
const finish = () => A.waitFor('!S.gen', 30_000, 'fin de la demande');

test('explorateurs en parallèle (2 à la fois par défaut) : étapes regroupées, résumés à l\'agent, rien dans la réponse', async () => {
  await start('chef', 'Explore le projet');
  // Le troisième attend une place pendant que les deux premiers tournent.
  await A.waitFor(`[...${msgEl}.querySelectorAll('.step.explorer')].map((s) => s.dataset.status).join() === 'running,running,waiting'`, 10_000, 'deux en cours, un en attente');
  await finish();
  assert.equal(maxActive, 2, 'au plus 2 explorateurs en même temps');
  const m = await lastMsg();
  assert.equal(m.content, 'Fini.', 'le texte des explorateurs ne va pas dans la réponse');
  const ex = m.agent.steps.filter((s) => s.kind === 'explorer');
  assert.deepEqual(ex.map((s) => [s.title, s.status]), [['Explorateur : A', 'done'], ['Explorateur : B', 'done'], ['Explorateur : C', 'done']]);
  for (const s of ex) {
    assert.ok(s.seconds > 0.5 && s.tokens.input > 0 && s.tokens.output > 0, JSON.stringify(s));
    assert.match(s.detail, /^Résumé [ABC] : Program\.cs crée un Player/);
    const children = m.agent.steps.filter((c) => c.parent === s.id);
    assert.deepEqual(children.map((c) => [c.title, c.status]), [['Lecture de src/Program.cs', 'done']]);
    assert.match(children[0].id, new RegExp(`^${s.id}e1$`));
  }
  // L'agent reçoit chaque résumé, dans l'ordre de ses appels.
  const results = chats.at(-1).messages.filter((x) => x.role === 'tool').map((x) => x.content);
  assert.deepEqual(results.map((r) => r.split('\n')[0]), ['Résumé de l\'explorateur (« A ») :', 'Résumé de l\'explorateur (« B ») :', 'Résumé de l\'explorateur (« C ») :']);
  assert.match(results[2], /Résumé C : Program\.cs crée un Player/);
  // L'agent a l'outil et les consignes ; les explorateurs, seulement les outils de lecture et leur propre conversation.
  assert.ok(chats[0].tools.some((t) => t.function.name === 'spawn_explorer'));
  assert.match(chats[0].messages[0].content, /spawn_explorer\(task\)/);
  assert.match(chats[0].messages[0].content, /Ne les lance pas pour une petite tâche/);
  assert.ok(explorers.every((b) => b.tools.map((t) => t.function.name).join() === 'list_files,read_file,search'));
  assert.ok(explorers.every((b) => b.messages[1].role === 'user' && !JSON.stringify(b.messages).includes('Explore le projet')), 'pas la conversation de l\'agent');
  // Affichage : les étapes de chaque explorateur dans son corps, avec leur nombre, la durée et les tokens.
  assert.equal(await A.ev(`${msgEl}.querySelectorAll('.step.explorer .substeps > .step').length`), 3);
  assert.match(await A.ev(`${msgEl}.querySelector('.step.explorer summary').textContent`), /^Explorateur : A1 étape[\d,]+ s · .+ tokens$/);
  // Suivi : une ligne « subagent » par explorateur, en plus de celle de l'agent.
  const lines = usage();
  assert.equal(lines.filter((l) => l.kind === 'subagent').length, 3);
  assert.equal(lines.filter((l) => l.kind === 'agent').length, 1);
  assert.ok(!JSON.stringify(lines).includes('Résumé'), 'jamais le texte');
});

test('limites : explorateurs par demande et tours par explorateur (réglables) ; 0 : pas d\'explorateurs', async () => {
  await settings({ explorerMax: 2, explorerTurns: 2 });
  const before = explorers.length;
  await start('chef-limite', 'Explore');
  await finish();
  const m = await lastMsg();
  const ex = m.agent.steps.filter((s) => s.kind === 'explorer');
  assert.deepEqual(ex.map((s) => s.status), ['done', 'done', 'error']);
  assert.match(ex[2].detail, /limite atteinte : 2 explorateurs au plus par demande/);
  // 2 tours chacun ; au dernier, la consigne de conclure ; sans résumé, l'agent sait ce qu'ils ont fait.
  const mine = explorers.slice(before);
  assert.equal(mine.length, 4);
  assert.ok(mine.filter((b) => b.messages.at(-1).content?.startsWith('Dernier tour')).length === 2);
  const results = chats.at(-1).messages.filter((x) => x.role === 'tool').map((x) => x.content);
  assert.match(results[0], /limite de 2 tours sans résumé\. Ce qu'il a fait :\n- Liste du dossier de travail/);
  assert.match(results[2], /limite atteinte/);
  // 0 : ni l'outil ni les consignes.
  await settings({ explorerMax: 0 });
  await start('chef-seul', 'Rien');
  await finish();
  assert.ok(!chats.at(-1).tools.some((t) => t.function.name === 'spawn_explorer'));
  assert.ok(!chats.at(-1).messages[0].content.includes('spawn_explorer'));
  await settings({ explorerMax: 5, explorerTurns: 6 });
  // Les réglages : trois curseurs et le choix du modèle.
  await A.ev(`openSettings('agent')`);
  await A.waitFor(`T.settings()?.textContent.includes('Explorateurs en même temps')`, 10_000);
  assert.ok(await A.ev(`T.settings().textContent.includes('Explorateurs par demande') && T.settings().textContent.includes('Tours par explorateur')`));
  assert.equal(await A.ev(`T.settings().querySelector('select.explorer-model').value`), '');
  await A.ev(`T.key('Escape', {}, document)`);
});

test('un explorateur ne fait que lire : écriture, commande, plan, explorateur et fichiers protégés refusés, sans confirmation', async () => {
  await start('chef-pirate', 'Fouille');
  await finish();
  const m = await lastMsg();
  assert.ok(!fs.existsSync(path.join(DIR, 'pirate.txt')) && !fs.existsSync(path.join(DIR, 'commande.txt')));
  assert.ok(!fs.readFileSync(path.join(DIR, 'src/Program.cs'), 'utf8').includes('X'));
  assert.ok(!m.agent.steps.some((s) => s.status === 'pending'), 'aucune confirmation demandée');
  assert.ok(!m.plan, 'le plan n\'est pas touché');
  assert.equal(m.agent.steps.filter((s) => s.kind === 'explorer').length, 1, 'pas d\'explorateur d\'explorateur');
  const results = explorers.at(-1).messages.filter((x) => x.role === 'tool').map((x) => x.content);
  for (const k of [0, 1, 2, 3, 4]) assert.match(results[k], /n'est pas permis à un explorateur/);
  assert.match(results[5], /refusé : « \.env » est un fichier protégé \(\.env\)/);
  assert.match(results[6], /^notes\.txt:1: pas de motdepasse ici\n\(1 fichier protégé non parcouru : explorateur\)$/);
  assert.ok(!JSON.stringify(explorers.at(-1)).includes('motdepasse-secret'), 'le contenu protégé ne part jamais');
  // L'agent principal apprend le refus, et qu'il peut lire le fichier lui-même avec l'accord de l'utilisateur.
  const toAgent = chats.at(-1).messages.filter((x) => x.role === 'tool').at(-1).content;
  assert.match(toAgent, /Fichiers protégés que l'explorateur n'a pas pu lire ni parcourir : \.env, secrets\.json\. Si tu en as besoin, lis-les toi-même avec read_file/);
  const read = m.agent.steps.find((s) => s.kind === 'read');
  assert.equal(read.status, 'rejected');
  assert.match(read.title, /fichier protégé, refusée à l'explorateur/);
});

test('Stop arrête tout : explorateurs en cours et en attente', async () => {
  const before = explorers.length;
  await start('chef-stop', 'Explore longtemps');
  await A.waitFor(`[...${msgEl}.querySelectorAll('.step.explorer')].map((s) => s.dataset.status).join() === 'running,running,waiting'`, 10_000);
  const t = Date.now();
  await A.ev(`T.key('Escape', {}, document)`);
  await finish();
  assert.ok(Date.now() - t < 5_000, 'arrêt immédiat');
  const m = await lastMsg();
  assert.equal(m.content, '(arrêté)');
  assert.deepEqual(m.agent.steps.filter((s) => s.kind === 'explorer').map((s) => s.status), ['stopped', 'stopped', 'stopped']);
  await sleep(300);
  assert.equal(explorers.length - before, 2, 'le troisième n\'a jamais commencé');
  assert.equal(active, 0, 'connexions fermées');
});

test('modèle des explorateurs (réglage) ; leurs tokens « subagent » comptent dans le budget', async () => {
  await settings({ explorerModel: { provider: PROVIDER, model: 'eclaireur' } });
  const cost = await A.ev(`S.current.usage?.cost ?? 0`);
  await start('chef-leger', 'Explore vite');
  await finish();
  assert.equal(explorers.at(-1).model, 'eclaireur');
  assert.equal(chats.at(-1).model, 'chef-leger');
  const sub = usage().filter((l) => l.kind === 'subagent' && l.model === 'eclaireur');
  assert.equal(sub.length, 1);
  assert.ok(sub[0].cost > 0, 'prix du modèle des explorateurs');
  const all = usage().reduce((t, l) => t + l.cost, 0);
  const budget = await A.ev(`window.__TAURI__.core.invoke('budget_status', { model: 'chef-leger' })`);
  assert.ok(Math.abs(budget.monthCost - all) < 1e-9 && budget.monthCost >= sub[0].cost, JSON.stringify(budget));
  // L'en-tête de la conversation compte aussi les explorateurs.
  assert.ok(Math.abs((await A.ev(`S.current.usage.cost`)) - cost - sub[0].cost) < 1e-9);
  // Le réglage s'affiche ; un modèle qui n'existe plus : celui de l'agent.
  await A.ev(`openSettings('agent', 'explorerModel')`);
  await A.waitFor(`T.settings()?.querySelector('select.explorer-model')`, 10_000);
  assert.equal(await A.ev(`JSON.parse(T.settings().querySelector('select.explorer-model').value).model`), 'eclaireur');
  await A.ev(`T.key('Escape', {}, document)`);
  await settings({ explorerModel: { provider: PROVIDER, model: 'disparu' } });
  await start('chef-leger', 'Encore');
  await finish();
  assert.equal(explorers.at(-1).model, 'chef-leger');
});
