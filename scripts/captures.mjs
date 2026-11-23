// Les captures d'écran du README (docs/*.png) : lance Nel Code (debug) comme les tests de l'interface, avec des données
// temporaires, un faux modèle distant pour le mode Agent et le modèle de test MiniChat, puis enregistre chaque vue.
// Usage : cargo build -p nel-desktop ; node scripts/captures.mjs   (rien ne touche à %APPDATA%\NelCode)

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { launch, sleep, ROOT } from '../e2e/harness.mjs';

const DOCS = path.join(ROOT, 'docs');
const call = (name, args) => ({ name, args });
// Le faux modèle Agent : n = nombre de résultats d'outils reçus → [texte, appels].
const SCRIPT = (n) => [
  ['', [call('update_plan', { tasks: [{ title: 'Lire Player.cs', status: 'in_progress' }, { title: 'Ajouter les points de vie', status: 'todo' }, { title: 'Compiler', status: 'todo' }] }), call('list_files', {})]],
  ['', [call('read_file', { path: 'src/Player.cs' })]],
  ['', [call('search', { query: 'Player' })]],
  ['', [call('update_plan', { tasks: [{ title: 'Lire Player.cs', status: 'done' }, { title: 'Ajouter les points de vie', status: 'in_progress' }, { title: 'Compiler', status: 'todo' }] }),
    call('edit_file', { path: 'src/Player.cs', old_text: '    public string Name { get; set; } = "";\n', new_text: '    public string Name { get; set; } = "";\n    public int Health { get; private set; } = 100;\n\n    public void Hit(int damage) => Health = Math.Max(0, Health - damage);\n' })]],
][n] ?? ['Player a maintenant des points de vie (`Health`, 100 au départ) et une méthode `Hit` qui ne descend jamais sous 0.', []];

function answer(res, n) {
  const [content, calls] = SCRIPT(n);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  if (n === 0) send({ reasoning_content: 'Je regarde d\'abord la classe Player, puis j\'ajoute les points de vie.' });
  if (content) send({ content });
  calls.forEach((c, i) => send({ tool_calls: [{ index: i, id: `call_${n}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] }));
  send({}, calls.length ? 'tool_calls' : 'stop');
  res.end('data: [DONE]\n\n');
}

const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (d) => (data += d));
  req.on('end', () => {
    if (!req.url.startsWith('/v1/')) { res.writeHead(404); return res.end(); }
    if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'qwen3-coder' }] })); }
    const body = JSON.parse(data);
    setTimeout(() => answer(res, body.messages.filter((m) => m.role === 'tool').length), 300);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

// Le projet de la démonstration.
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'nelcode-captures-'));
const DIR = path.join(OUT, 'jeu-de-plateau');
const files = {
  'src/Program.cs': 'var joueur = new Player { Name = "Alice" };\nConsole.WriteLine($"{joueur.Name} entre en jeu.");\n',
  'src/Player.cs': 'public class Player\n{\n    public string Name { get; set; } = "";\n}\n',
  'src/Board.cs': 'public class Board\n{\n    public List<Player> Players { get; } = new();\n}\n',
  'JeuDePlateau.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework></PropertyGroup>\n</Project>\n',
  'NELCODE.md': '# Jeu de plateau\n\nC# 13, .NET 9. Compiler avec `dotnet build`.\n',
};
for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(DIR, f)), { recursive: true }); fs.writeFileSync(path.join(DIR, f), c); }

// Un mois de suivi (page Suivi), sans aucun texte de conversation.
const day = 86_400_000, now = Date.now();
const pad = (n) => String(n).padStart(2, '0');
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const usage = [];
for (let i = 27; i >= 0; i--) {
  const d = new Date(now - i * day);
  const k = (i * 7) % 5;
  usage.push({ ts: Math.floor(+d / 1000), date: local(d), project: DIR, provider: 'Anthropic', model: 'claude-sonnet-5-5', kind: 'agent', input: 9000 + k * 4000, output: 900 + k * 300, seconds: 14 + k, tps: 70, cost: 0.04 + k * 0.02 });
  usage.push({ ts: Math.floor(+d / 1000) + 60, date: local(d), project: DIR, provider: 'local', model: 'Qwen2.5-Coder-1.5B-Instruct', kind: 'chat', input: 600 + k * 100, output: 200 + k * 40, seconds: 4, tps: 52, cost: 0 });
}

const A = await launch({
  settings: { maxReplyTokens: 60, temperature: 0.3, budgetMonthly: 20 },
  files: { 'usage.jsonl': usage.map((l) => JSON.stringify(l)).join('\n') + '\n' },
});
const shot = async (name) => { await sleep(600); await A.ev(`document.getElementById('toasts').replaceChildren(); document.querySelectorAll('.dialog, .dialog *').forEach((e) => { e.scrollTop = 0; }); true`); await A.shot(path.join(DOCS, name)); console.log(`docs/${name}`); };

try {
  // 1. L'import d'un modèle, puis une conversation avec lui.
  await A.ev(`T.submit(${JSON.stringify(`/import "${path.join(ROOT, 'test-models', 'minichat-v3b.nelmodel')}"`)})`);
  await A.waitFor(`T.dialog()?.querySelector('input.text-input')`, 30_000, 'fenêtre d\'import');
  await shot('import.png');
  await A.ev(`T.setValue(T.dialog().querySelector('input.text-input'), 'minichat-v3b'); T.button('Importer', T.dialog())`);
  await A.waitFor(`S.models.some((m) => m.name === 'minichat-v3b') && S.model.name === 'minichat-v3b'`, 120_000, 'import');
  await A.ev(`S.current.workingDirectory = ${JSON.stringify(DIR)}; renderHeader(); true`);
  await A.ask('Bonjour !');
  await A.ask('Peux-tu me proposer une idée de sortie pour samedi ?');
  await shot('conversation.png');

  // 2. Les commandes « / » et la palette Ctrl+K.
  await A.ev(`T.type('/')`);
  await shot('commandes.png');
  await A.ev(`T.type(''); T.key('Escape', {}, document.getElementById('input')); true`);
  await A.ev(`T.key('k', { ctrlKey: true }, document)`);
  await shot('palette.png');
  await A.ev(`T.key('Escape', {}, document.activeElement); true`);

  // 3. Le mode Agent : plan, étapes, diff à valider.
  const p = await A.ev(`window.__TAURI__.core.invoke('save_provider', { id: null, name: 'Serveur du bureau', url: 'http://127.0.0.1:${server.address().port}/v1', key: null })`);
  await A.ev(`window.__TAURI__.core.invoke('test_provider', { id: ${JSON.stringify(p.id)} }).then(() => refreshProviders()).then(() => true)`);
  await A.ev(`T.key('n', { ctrlKey: true }, document); true`);
  await A.waitFor(`S.current && !S.current.messages.length`, 5_000);
  await A.ev(`S.current.workingDirectory = ${JSON.stringify(DIR)}; renderHeader(); true`);
  await A.ev(`[...document.querySelectorAll('#models li.remote')].find((li) => li.dataset.model === 'qwen3-coder').click(); true`);
  await A.waitFor(`S.model.remote?.model === 'qwen3-coder'`, 5_000);
  await A.ev(`document.getElementById('agent-btn').click()`);
  await A.waitFor(`S.current.agent === true`, 5_000);
  await A.ev(`T.submit('Ajoute des points de vie au joueur')`);
  await A.waitFor(`[...document.querySelectorAll('#messages .step')].some((s) => s.dataset.status === 'pending')`, 30_000, 'diff à valider');
  await shot('agent.png');
  await A.ev(`T.button('Accepter', [...document.querySelectorAll('#messages .step')].find((s) => s.dataset.status === 'pending'))`);
  await A.waitFor('!S.gen', 30_000, 'fin de la demande');

  // 4. La page Suivi.
  await A.ev(`T.submit('/suivi')`);
  await A.waitFor(`document.querySelector('.usage-page, #usage:not([hidden]), .dialog .usage')`, 10_000, 'page Suivi').catch(() => {});
  await shot('suivi.png');
  await A.ev(`T.key('Escape', {}, document)`);

  // 5. La page Réglages (Modèles : génération, contexte et résumé).
  await A.ev(`openSettings('models')`);
  await A.waitFor(`!!T.settings()?.querySelector('.setting[data-id="temperature"]')`, 10_000, 'page Réglages');
  await shot('reglages.png');
} finally {
  await A.close();
  server.close();
  fs.rmSync(OUT, { recursive: true, force: true });
}
