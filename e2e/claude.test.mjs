// Claude Agent, avec un faux exécutable « claude » (e2e/fake-claude/main.rs, compilé ici avec rustc) qui rejoue des flux
// stream-json enregistrés (e2e/fake-claude/*.jsonl) et note chaque lancement : arguments, message reçu sur l'entrée
// standard, clé API, variables secrètes, dossier courant, Ctrl+C.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT, fr, launch, sleep } from './harness.mjs';

const KEY = 'sk-ant-test-cle-claude-agent';
let A, TMP, DIR, LOG;

const runs = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const starts = () => runs().filter((r) => r.event === 'start');
const msg = `[...document.querySelectorAll('#messages .msg.assistant')].pop()`;

before(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nelcode-claude-'));
  const bin = path.join(TMP, 'bin');
  fs.mkdirSync(bin);
  execFileSync('rustc', ['--edition', '2024', '-O', path.join(ROOT, 'e2e', 'fake-claude', 'main.rs'), '-o', path.join(bin, 'claude.exe')], { stdio: 'inherit' });
  DIR = path.join(TMP, 'projet');
  fs.mkdirSync(path.join(DIR, 'src'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'src', 'Program.cs'), 'class Program { }\n');
  LOG = path.join(TMP, 'claude.log');
  A = await launch({ env: {
    PATH: `${bin};${process.env.PATH}`, FAKE_CLAUDE_DIR: path.join(ROOT, 'e2e', 'fake-claude'), FAKE_CLAUDE_LOG: LOG,
    NELCODE_E2E_SECRET_TOKEN: 'ne-doit-pas-passer',
  } });
});

after(async () => {
  await A?.ev(`window.__TAURI__.core.invoke('claude_agent_save_key', { key: '' })`).catch(() => {});   // pas de clé de test laissée dans Windows
  await A?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Une nouvelle conversation Claude Agent dans DIR. */
async function newClaude() {
  // Une conversation vraiment nouvelle (la précédente peut déjà être une conversation Claude Agent).
  await A.ev(`window.__before = S.current; document.getElementById('claude-chat').click(); true`);
  await A.waitFor(`S.current !== window.__before && !!S.current.claudeAgent && S.current.messages.length === 0`, 10_000, 'nouvelle conversation Claude Agent');
  await A.ev(`S.current.workingDirectory = ${JSON.stringify(DIR)}; renderHeader(); true`);
}

test('sans clé API : Claude Agent la demande (Réglages), jamais de connexion à un compte', async () => {
  await A.ev(`document.getElementById('claude-chat').click()`);
  await A.waitFor(`T.toasts().includes('ajoute d\\'abord ta clé API Anthropic')`, 10_000);
  await A.waitFor(`T.settings()?.querySelector('.claude-field')`, 10_000, 'réglages ouverts (Claude Agent)');
  assert.equal(await A.ev(`document.querySelector('#settings-nav .cat.sel').dataset.cat`), 'claude');
  const text = await A.ev(`T.settings().querySelector('.claude-field').textContent`);
  assert.match(text, /Outil « claude » : .*claude\.exe/);
  assert.match(text, /Pas de connexion à un compte Claude\.ai/);
  assert.ok(!/se connecter|connexion avec|login/i.test(text.replace('Pas de connexion à un compte Claude.ai', '')), 'aucun bouton de connexion');
  // La clé va dans le Gestionnaire d'identification, pas dans settings.json.
  await A.ev(`T.setValue(T.settings().querySelector('.claude-field .key'), ${JSON.stringify(KEY)}); T.button('Ranger la clé', T.settings().querySelector('.claude-field'))`);
  await A.waitFor(`S.claudeStatus?.hasKey === true`, 5_000, 'clé enregistrée');
  assert.ok(!fs.readFileSync(path.join(A.home, 'settings.json'), 'utf8').includes(KEY));
  await A.ev(`T.key('Escape', {}, document)`);
});

test('sans l\'outil claude : message avec le lien d\'installation', async () => {
  const B = await launch({ env: { NELCODE_CLAUDE_PATH: '' } });
  try {
    await B.ev(`document.getElementById('claude-chat').click()`);
    await B.waitFor(`T.dialog()?.textContent.includes('introuvable sur ce PC')`, 10_000);
    assert.match(await B.ev(`T.dialog().textContent`), /https:\/\/code\.claude\.com\/docs\/en\/setup/);
    assert.ok(await B.ev(`[...T.dialog().querySelectorAll('button')].some((b) => b.textContent === 'Ouvrir la page d\\'installation')`));
    assert.equal(await B.ev(`!!S.current.claudeAgent`), false);
  } finally { await B.close(); }
});

test('conversation : texte au fil de l\'eau, outil Lecture en étape, coût et durée ; arguments, stdin, clé, environnement', async () => {
  await newClaude();
  assert.match(await A.ev(`document.getElementById('claude-chip').textContent`), /Claude Agent/);
  assert.equal(await A.ev(`document.getElementById('agent-btn').hidden`), true);
  await A.waitFor(`document.getElementById('context-text').textContent === 'contexte géré par Claude Agent'`, 5_000, 'barre de contexte');
  await A.ev(`T.submit('lecture de Program.cs ?')`);
  // Au fil de l'eau : le texte arrive avant la fin.
  await A.waitFor(`S.gen?.text.includes('Program.cs définit')`, 15_000, 'texte en direct');
  assert.equal(await A.ev(`!!S.gen`), true);
  await A.waitFor('!S.gen', 30_000, 'fin');
  const m = await A.ev(`S.current.messages.at(-1)`);
  assert.equal(m.content, 'Program.cs définit la classe Program.');
  assert.equal(m.reasoning, 'Il faut lire Program.cs.');
  assert.deepEqual(m.agent.steps.map((s) => [s.kind, fr(s.title), s.status]), [['note', 'Je lis le fichier.', 'done'], ['read', 'Lecture de src/Program.cs', 'done']]);
  assert.match(fr(m.agent.steps[1].detail), /class Program \{/);
  assert.deepEqual(m.claude, { cost: 0.0123, durationMs: 4567, turns: 2 });
  assert.equal(await A.ev(`${msg}.querySelector('.claude-cost').textContent`), '0,0123 $ · 4,6 s · 2 tours');
  assert.match(await A.ev(`document.getElementById('status').textContent`), /Claude Agent · rien d'automatique · 0,0123 \$ · 4,6 s/);
  // Pas de Régénérer ni de Modifier (la session de claude ne se réécrit pas).
  assert.equal(await A.ev(`[...document.querySelectorAll('#messages .actions button')].some((b) => /Régénérer|Modifier/.test(b.textContent))`), false);
  const r = starts().at(-1);
  assert.deepEqual(r.args, ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'default', '--setting-sources', 'user'], 'les réglages du projet (.claude/settings.json) ne sont pas lus par défaut');
  assert.equal(r.prompt, 'lecture de Program.cs ?', 'le message passe par l\'entrée standard');
  assert.equal(r.key, KEY, 'ANTHROPIC_API_KEY depuis le Gestionnaire d\'identification');
  assert.equal(r.secret, false, 'les variables *TOKEN* ne sont pas transmises');
  assert.equal(fs.realpathSync.native(r.cwd), fs.realpathSync.native(DIR));
  // Message suivant : --resume avec la session rendue par claude.
  await A.ask('texte encore');
  assert.deepEqual(starts().at(-1).args.slice(-2), ['--resume', 'sess-neuve']);
  assert.equal(await A.ev(`S.current.messages.at(-1).content`), 'Bonjour, je suis prêt.');
  assert.match(await A.ev(`document.getElementById('claude-chip').textContent`), /0,0154 \$/);
  const saved = A.readJson(path.join('sessions', (await A.ev(`S.current.id`)) + '.json'));
  assert.equal(saved.claudeAgent.sessionId, 'sess-neuve');
});

test('écriture avec diff, commande et plan ; réglages acceptEdits, outils autorisés et modèle', async () => {
  await A.ev(`openSettings('claude')`);
  await A.waitFor(`T.control('claudeModel')?.matches('input.model')`, 10_000);
  // Un nom de modèle invalide : l'erreur sous le champ, rien d'enregistré (jamais passé à claude).
  await A.ev(`T.setValue(T.control('claudeModel'), 'opus & calc')`);
  await A.waitFor(`!T.row('claudeModel').querySelector('.setting-error').hidden`, 5_000, 'erreur sous le champ');
  assert.match(await A.ev(`T.row('claudeModel').querySelector('.setting-error').textContent`), /Lettres, chiffres/);
  assert.equal(await A.ev(`T.control('claudeModel').getAttribute('aria-invalid')`), 'true');
  await sleep(1000);
  assert.equal(A.readJson('settings.json').claudeModel ?? '', '');
  await A.ev(`T.setValue(T.control('claudePermissionMode'), 'acceptEdits'); T.setValue(T.control('claudeAllowedTools'), 'Read\\n Bash(dotnet build *) \\n\\nRead'); T.setValue(T.control('claudeModel'), ' sonnet '); T.control('claudeProjectSettings').click()`);
  await A.waitFor(`S.settings.claudeModel === 'sonnet' && S.settings.claudeProjectSettings === true && S.settings.claudeAllowedTools.length === 2 && S.settings.claudePermissionMode === 'acceptEdits'`, 5_000, 'réglages enregistrés');
  assert.equal(await A.ev(`T.row('claudeModel').querySelector('.setting-error').hidden`), true, 'erreur effacée');
  await A.ev(`T.key('Escape', {}, document)`);
  assert.equal(A.readJson('settings.json').claudeProjectSettings, true, 'réglages du projet : choisis explicitement');
  assert.equal(await A.ev(`S.settings.claudePermissionMode`), 'acceptEdits');
  assert.deepEqual(A.readJson('settings.json').claudeAllowedTools, ['Read', 'Bash(dotnet build *)']);
  assert.equal(A.readJson('settings.json').claudeModel, 'sonnet');
  await newClaude();
  await A.ev(`T.submit('ecriture : renomme p et compile')`);
  // Le plan (TodoWrite) s'affiche pendant la demande.
  await A.waitFor(`[...document.querySelectorAll('#plan .plan-tasks li')].map((li) => li.dataset.status).join() === 'in_progress,todo'`, 15_000, 'plan en direct');
  await A.waitFor('!S.gen', 30_000);
  const m = await A.ev(`S.current.messages.at(-1)`);
  assert.deepEqual(m.agent.steps.map((s) => [s.kind, fr(s.title), s.status]), [
    ['edit', 'Modification de src/Program.cs (+1 −1)', 'done'],
    ['write', 'Écriture de notes/journal.txt (+2)', 'done'],
    ['command', 'Commande : dotnet build', 'done'],
  ]);
  assert.match(fr(m.agent.steps[2].detail), /Build succeeded/);
  await A.ev(`${msg}.querySelector('.step.edit summary').click()`);
  const diff = await A.ev(`[...${msg}.querySelectorAll('.step.edit .diff > div')].map((d) => d.className + ':' + d.textContent)`);
  assert.deepEqual(diff, ['del:-var p = new Player();', 'add:+var joueur = new Player();']);
  assert.equal(await A.ev(`[...document.querySelectorAll('#plan .plan-tasks li')].map((li) => li.dataset.status).join()`), 'done,done');
  assert.deepEqual(starts().at(-1).args, ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Bash(dotnet build *)', '--model', 'sonnet']);
  // Aucune étape n'a de bouton Annuler : c'est claude qui écrit, pas Nel Code.
  assert.equal(await A.ev(`[...${msg}.querySelectorAll('button')].some((b) => b.textContent.includes('Annuler'))`), false);
});

test('outil refusé par le mode de permission : étape « refusée »', async () => {
  await newClaude();
  await A.ask('refus : renomme la classe');
  const m = await A.ev(`S.current.messages.at(-1)`);
  assert.deepEqual(m.agent.steps.map((s) => [s.kind, s.status]), [['edit', 'rejected']]);
  assert.match(fr(m.agent.steps[0].detail), /Non autorisé par le mode de permission/);
  // La raison du refus s'affiche avec le diff.
  assert.match(await A.ev(`${msg}.querySelector('.step.edit .step-body .detail').textContent`), /Non autorisé par le mode de permission/);
  assert.ok(await A.ev(`!!${msg}.querySelector('.step.edit .step-body .diff')`));
  assert.equal(m.content, 'Je n\'ai pas la permission de modifier ce fichier.');
});

test('erreur de claude : message clair, rien de gardé', async () => {
  await newClaude();
  await A.ev(`T.submit('erreur volontaire')`);
  await A.waitFor(`T.toasts().includes('Claude Agent : error_max_turns')`, 15_000);
  await A.waitFor('!S.gen', 10_000);
  assert.equal(await A.ev(`S.current.messages.length`), 0);
});

test('Stop : Ctrl+C (SIGINT) puis fin propre, le début de la réponse est gardé', async () => {
  await newClaude();
  await A.ev(`T.submit('long travail')`);
  await A.waitFor(`S.gen?.text.includes('Je commence un long travail')`, 15_000, 'début');
  await sleep(300);
  const t = Date.now();
  await A.ev(`T.key('Escape', {}, document)`);
  await A.waitFor('!S.gen', 20_000, 'fin après Stop');
  assert.ok(Date.now() - t < 10_000, `${Date.now() - t} ms`);
  const events = runs().map((r) => r.event);
  assert.ok(events.includes('ctrl-c') && events.includes('fin-propre'), `Ctrl+C reçu, fin propre : ${events}`);
  const m = await A.ev(`S.current.messages.at(-1)`);
  assert.equal(m.content, 'Je commence un long travail');
  assert.match(await A.ev(`S.lastSpeed`), /arrêtée/);
});

// Les étapes de premier niveau du dernier message : [titre, compteur, titres des étapes du sous-agent].
const groups = () => A.ev(`[...${msg}.querySelectorAll(':scope > .steps > .step')].map((d) => [d.querySelector(':scope > summary .title').textContent,
  d.querySelector(':scope > summary .count')?.textContent ?? '', [...d.querySelectorAll(':scope > .step-body > .substeps > .step')].map((c) => c.querySelector(':scope > summary .title').textContent)])`);

test('sous-agents (rendu seul) : étapes avec parent dans l\'étape parente, sur plusieurs niveaux ; parent introuvable : premier niveau', async () => {
  await newClaude();
  const steps = [
    { id: 's1', kind: 'note', title: 'Sous-agent : A', status: 'done', detail: 'rapport de A' },
    { id: 's2', kind: 'read', title: 'Lecture de a.txt', status: 'done', parent: 's1' },
    { id: 's3', kind: 'note', title: 'Sous-agent : B', status: 'running', parent: 's1' },
    { id: 's4', kind: 'search', title: 'Recherche de "x"', status: 'done', parent: 's3' },
    { id: 's5', kind: 'note', title: 'Message du sous-agent', detail: 'texte de A', status: 'done', parent: 's1' },
    { id: 's6', kind: 'read', title: 'Lecture orpheline', status: 'done', parent: 's99' },
    { id: 's7', kind: 'note', title: 'Fini.', status: 'done' },
  ];
  await A.ev(`S.current.messages.push({ role: 'user', content: 'q' }, { role: 'assistant', content: 'réponse', agent: { request: 'rtest', steps: ${JSON.stringify(steps)} } }); renderMessages(); true`);
  assert.deepEqual(await groups(), [
    ['Sous-agent : A', '3 étapes', ['Lecture de a.txt', 'Sous-agent : B', 'Message du sous-agent']],
    ['Lecture orpheline', '', []],
    ['Fini.', '', []],
  ]);
  assert.equal(await A.ev(`${msg}.querySelector('[data-step="s3"] > summary .count').textContent`), '1 étape');
  assert.ok(await A.ev(`!!${msg}.querySelector('[data-step="s3"] > .step-body > .substeps > [data-step="s4"]')`));
  assert.match(await A.ev(`${msg}.querySelector('[data-step="s5"]').textContent`), /texte de A/);
  // Pendant la réponse : les étapes qui tournent sont ouvertes, y compris l'étape parente.
  const live = steps.map((s) => (s.id === 's1' ? { ...s, status: 'running' } : s));
  assert.deepEqual(await A.ev(`import('/js/agent.js').then((a) => [...a.stepsEl(${JSON.stringify(live)}, null).querySelectorAll('details[open]')].map((d) => d.dataset.step))`), ['s1', 's3']);
});

test('sous-agents : étapes regroupées dans l\'étape Sous-agent, texte du sous-agent hors de la réponse, coût ; gardé au rechargement', async () => {
  await newClaude();
  await A.ev(`T.submit('sousagent : explore le projet')`);
  // Pendant la réponse : l'étape Sous-agent est ouverte et reçoit ses étapes.
  await A.waitFor(`S.gen && document.querySelector('#messages .steps > details.step[open] > .step-body > .substeps > .step')`, 15_000, 'étapes du sous-agent en direct');
  await A.waitFor('!S.gen', 30_000, 'fin');
  const m = await A.ev(`S.current.messages.at(-1)`);
  assert.equal(m.content, 'Le sous-agent a trouvé une seule classe, Program.');
  const task = m.agent.steps.find((s) => fr(s.title) === 'Sous-agent : Explorer le projet');
  assert.deepEqual(m.agent.steps.filter((s) => s.parent === task.id).map((s) => fr(s.title)), ['Lecture de src/Program.cs', 'Recherche de "class"', 'Message du sous-agent']);
  const check = async () => {
    assert.deepEqual(await groups(), [['Sous-agent : Explorer le projet', '3 étapes', ['Lecture de src/Program.cs', 'Recherche de "class"', 'Message du sous-agent']]]);
    assert.match(await A.ev(`${msg}.querySelector('.substeps').textContent`), /Le projet ne contient qu'une classe : Program\./);
    const body = await A.ev(`${msg}.querySelector(':scope > .body').textContent`);
    assert.match(body, /Le sous-agent a trouvé une seule classe/);
    assert.doesNotMatch(body, /ne contient qu'une classe/);
    assert.equal(await A.ev(`${msg}.querySelector('.claude-cost').textContent`), '0,0789 $ · 23,5 s · 3 tours');
  };
  await check();
  // Rouverte : le même regroupement.
  const id = await A.ev(`S.current.id`);
  assert.ok(A.readJson(path.join('sessions', id + '.json')).messages.at(-1).agent.steps.some((s) => s.parent === task.id), 'parent enregistré');
  await A.ev(`T.key('n', { ctrlKey: true }, document)`);
  await A.waitFor(`S.current.id !== ${JSON.stringify(id)}`, 5_000, 'nouvelle conversation');
  await A.ev(`openSession(S.sessions.find((s) => s.id === ${JSON.stringify(id)})); true`);
  await A.waitFor(`S.current.id === ${JSON.stringify(id)} && ${msg}?.querySelector('.substeps')`, 5_000, 'conversation rouverte');
  await check();
});

test('suivi : tokens et coût de l\'événement result dans usage.jsonl (type claude-agent), et dans l\'en-tête', async () => {
  await newClaude();
  await A.ev(`T.submit('bonjour')`);
  await A.waitFor('!!S.gen', 10_000);
  await A.waitFor('!S.gen', 30_000, 'fin');
  const u = fs.readFileSync(path.join(A.home, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual([u.kind, u.provider, u.model, u.input, u.output, u.cost, u.project], ['claude-agent', 'Claude Agent', 'claude-sonnet-5-5', 1312, 25, 0.0031, DIR]);
  assert.match(await A.ev(`document.getElementById('usage-chip').textContent`), /tokens · ≈ 0,0031 \$/);
});
