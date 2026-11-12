// Pack GPU et calcul sur GPU, de bout en bout. Demande : Nel Code compilé avec la feature cuda (debug), une carte
// NVIDIA avec un pilote assez récent, et le pack (make-gpu-pack.ps1 : dist/nelcode-gpu-pack-cuda12.zip, ou
// NELCODE_GPU_PACK_ZIP). Sinon, les tests sont ignorés. Le pack est servi en local (NELCODE_GPU_PACK_URL, lue
// seulement en debug) : bon fichier, mauvais fichier, ou téléchargement lent pour l'annulation.
//
//   cargo build -p nel-desktop --features cuda --target-dir target\cuda
//   $env:NELCODE_EXE = "target\cuda\debug\nel-desktop.exe"; node --test --test-reporter=spec e2e/gpu.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { ROOT, launch } from './harness.mjs';

const ZIP = path.resolve(process.env.NELCODE_GPU_PACK_ZIP ?? path.join(ROOT, 'dist', 'nelcode-gpu-pack-cuda12.zip'));
let server, mode = 'good';
let A, skip;

const leftovers = () => ['gpu.partial', 'gpu.download'].filter((f) => fs.existsSync(path.join(A.home, f)));

/** Ouvre les réglages et clique sur un bouton de la section Calcul. */
async function settingsButton(text) {
  if (!(await A.ev(`!!T.dialog()?.querySelector('.calc')`))) {
    await A.ev(`T.key(',', { ctrlKey: true }, document)`);
    await A.waitFor(`T.dialog()?.querySelector('.calc .gpu-info')?.textContent`);
  }
  await A.waitFor(`[...T.dialog().querySelectorAll('.calc button')].some((b) => b.textContent.includes(${JSON.stringify(text)}))`, 10_000, `bouton ${text}`);
  await A.ev(`T.button(${JSON.stringify(text)}, T.dialog().querySelector('.calc'))`);
}

before(async () => {
  if (!fs.existsSync(ZIP)) { skip = `pack absent (${ZIP}) : .\\make-gpu-pack.ps1`; return; }
  server = http.createServer((req, res) => {
    if (mode === 'bad') return res.end(Buffer.alloc(4096, 7));   // mauvaise empreinte
    const size = fs.statSync(ZIP).size;
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/zip' });
    const stream = fs.createReadStream(ZIP, mode === 'slow' ? { highWaterMark: 64 * 1024 } : {});
    if (mode === 'slow') stream.on('data', () => { stream.pause(); setTimeout(() => stream.resume(), 50); });
    stream.pipe(res);
    req.on('close', () => stream.destroy());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  A = await launch({ env: { NELCODE_GPU_PACK_URL: `http://127.0.0.1:${server.address().port}/pack.zip` } });
  const st = await A.ev(`window.__TAURI__.core.invoke('gpu_status')`);
  if (!st.compiled) skip = 'Nel Code compilé sans CUDA (NELCODE_EXE)';
  else if (!st.card) skip = 'aucune carte NVIDIA';
  else if (!st.driverOk) skip = `pilote trop ancien (CUDA ${st.driverCuda})`;
});

after(async () => {
  await A?.close();
  server?.close();
});

test('section Calcul : carte et pilote détectés, pack proposé avec sa taille', async (t) => {
  if (skip) return t.skip(skip);
  await A.importAs('mini');
  await A.waitFor(`S.model.name === 'mini' && !S.model.loading`, 120_000);
  assert.equal(await A.ev(`S.model.device`), 'CPU');   // pas de pack : le CPU, sans erreur
  await A.ev(`T.key(',', { ctrlKey: true }, document)`);
  const info = await A.waitFor(`T.dialog()?.querySelector('.calc .gpu-info')?.textContent`);
  assert.match(info, /NVIDIA .* · pilote \d+\.\d+ \(CUDA \d+\.\d+\)/);
  assert.match(info, /Installer le pack GPU \(\d+ Mo\)/);
  await A.ev(`T.key('Escape', {}, document)`);
});

test('empreinte incorrecte : le pack est refusé, rien ne reste', async (t) => {
  if (skip) return t.skip(skip);
  mode = 'bad';
  await settingsButton('Installer le pack GPU');
  await A.waitFor(`T.toasts().includes('empreinte SHA-256 incorrecte')`, 60_000);
  assert.ok(!fs.existsSync(path.join(A.home, 'gpu')));
  assert.deepEqual(leftovers(), []);
});

test('annulation pendant le téléchargement : rien ne reste', async (t) => {
  if (skip) return t.skip(skip);
  mode = 'slow';
  await settingsButton('Installer le pack GPU');
  await A.waitFor(`/Téléchargement… [1-9]/.test(document.getElementById('gpu-text')?.textContent)`, 60_000, 'progression');
  await A.ev(`T.button('Annuler', T.dialog().querySelector('.calc'))`);
  await A.waitFor(`T.toasts().includes('Installation du pack GPU annulée')`, 60_000);
  assert.ok(!fs.existsSync(path.join(A.home, 'gpu')));
  assert.deepEqual(leftovers(), []);
});

test('installation du pack, puis le modèle tourne sur le GPU', async (t) => {
  if (skip) return t.skip(skip);
  mode = 'good';
  await settingsButton('Installer le pack GPU');
  await A.waitFor(`T.toasts().includes('Pack GPU installé')`, 300_000, 'installation du pack');
  assert.deepEqual(fs.readdirSync(path.join(A.home, 'gpu')).sort(), ['NVIDIA-LICENSE.txt', 'cublas64_12.dll', 'cublasLt64_12.dll', 'cudart64_12.dll', 'curand64_10.dll'].sort());
  assert.deepEqual(leftovers(), []);
  await A.waitFor(`S.model.device?.startsWith('GPU') && !S.model.loading`, 120_000, 'rechargement sur le GPU');
  await A.ev(`T.key('Escape', {}, document)`);
  assert.match(await A.ev(`document.getElementById('status').textContent`), /mini · GPU · NVIDIA/);
  await A.ask('Bonjour, qui es-tu ?');
  assert.ok((await A.ev(`S.current.messages.at(-1).content`)).length > 0);
});

test('les DLL CUDA ne viennent que du pack (et nvcuda de System32)', async (t) => {
  if (skip) return t.skip(skip);
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `(Get-Process -Id ${A.pid}).Modules | Where-Object { $_.ModuleName -match '^(nvcuda|cudart|cublas|curand|nvrtc)' } | ForEach-Object { $_.FileName }`], { encoding: 'utf8' });
  const modules = out.trim().split(/\r?\n/).filter(Boolean);
  const pack = path.join(A.home, 'gpu').toLowerCase();
  for (const dll of ['cudart64_12.dll', 'cublaslt64_12.dll', 'cublas64_12.dll', 'curand64_10.dll'])
    assert.ok(modules.some((m) => m.toLowerCase() === path.join(pack, dll)), `${dll} chargée depuis le pack (${modules.join(', ')})`);
  for (const m of modules) {
    const lower = m.toLowerCase();
    if (path.basename(lower).startsWith('nvcuda')) assert.match(lower, /\\system32\\/, m);
    else if (/^(cudart|cublas|curand|nvrtc)/.test(path.basename(lower))) assert.ok(lower.startsWith(pack), `${m} hors du pack`);
  }
});

test('test de vitesse sur CPU et sur GPU', async (t) => {
  if (skip) return t.skip(skip);
  await A.ev(`runBenchmark()`);
  await A.waitFor(`!S.bench && T.dialog()?.textContent.includes('Test de vitesse')`, 300_000, 'fin du test de vitesse');
  const b = A.readJson('benchmarks.json').mini;
  assert.equal(b.cpu.device, 'CPU');
  assert.match(b.gpu.device, /^GPU · /);
  for (const r of [b.cpu, b.gpu]) assert.ok(r.tokensPerSecond > 0 && r.loadSeconds > 0 && r.tokens === 200);
  assert.equal(await A.ev(`T.dialog().querySelectorAll('table.board tr').length`), 3);   // en-tête, CPU, GPU
  t.diagnostic(`CPU ${b.cpu.tokensPerSecond.toFixed(1)} tokens/s, ${b.gpu.device} ${b.gpu.tokensPerSecond.toFixed(1)} tokens/s`);
  await A.ev(`T.key('Escape', {}, document)`);
});

test('choix CPU dans les réglages : le modèle est rechargé sur le CPU', async (t) => {
  if (skip) return t.skip(skip);
  await A.ev(`T.key(',', { ctrlKey: true }, document)`);
  await A.waitFor(`T.dialog()?.querySelector('.calc select')`);
  await A.ev(`T.setValue(T.dialog().querySelector('.calc select'), 'cpu'); T.button('Enregistrer', T.dialog())`);
  await A.waitFor(`S.model.device === 'CPU' && !S.model.loading`, 120_000);
  assert.equal(A.readJson('settings.json').device, 'cpu');
});

test('retirer le pack (DLL chargées : au prochain démarrage)', async (t) => {
  if (skip) return t.skip(skip);
  await settingsButton('Retirer le pack GPU');
  await A.waitFor(`T.toasts().includes('au prochain démarrage')`, 10_000);
  assert.ok(fs.existsSync(path.join(A.home, 'gpu.remove')));
  assert.equal((await A.ev(`window.__TAURI__.core.invoke('gpu_status')`)).installed, false);
  await A.waitFor(`[...T.dialog().querySelectorAll('.calc button')].some((b) => b.textContent.includes('Installer le pack GPU'))`, 10_000);
  await A.ev(`T.key('Escape', {}, document)`);
});

test('au démarrage : retrait en attente fait, restes d\'une installation interrompue effacés', async () => {
  // Pas besoin de GPU : un pack factice, marqué à retirer, et les restes d'une installation coupée.
  const B = await launch({ files: { 'gpu/cudart64_12.dll': 'x', 'gpu.remove': '', 'gpu.partial/cublas64_12.dll': 'x', 'gpu.download': 'x' } });
  try {
    for (const f of ['gpu', 'gpu.remove', 'gpu.partial', 'gpu.download']) assert.ok(!fs.existsSync(path.join(B.home, f)), `${f} reste`);
    assert.equal((await B.ev(`window.__TAURI__.core.invoke('gpu_status')`)).installed, false);
  } finally {
    await B.close();
  }
});
