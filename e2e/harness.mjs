// Lance Nel Code (debug) avec un dossier de données et un dossier WebView2 temporaires, et le pilote par le port
// de débogage de WebView2 (protocole DevTools). Utilisé par les fichiers *.test.mjs de ce dossier.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const EXE = process.env.NELCODE_EXE ?? path.join(ROOT, 'target', 'debug', 'nel-desktop.exe');
export const MODEL = path.resolve(process.env.NELMODEL ?? path.join(ROOT, 'test-models', 'minichat-v3b.nelmodel'));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Petits gestes dans la page : taper dans la saisie, touches, clics sur un bouton par son texte.
const HELPERS = `window.T = {
  type(text) { const i = document.getElementById('input'); i.value = text; i.dispatchEvent(new Event('input', { bubbles: true })); },
  key(key, opts = {}, el = document.activeElement || document.body) { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })); },
  submit(text) { T.type(text); T.key('Enter', {}, document.getElementById('input')); },
  button(text, root = document) {
    const b = [...root.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text) && !b.disabled);
    if (!b) throw new Error('bouton introuvable : ' + text);
    b.click();
    return true;
  },
  dialog() { return document.querySelector('#overlay:not([hidden]) .dialog'); },
  setValue(el, value) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); },
  toasts() { return document.getElementById('toasts').innerText; },
}; true`;

/**
 * Lance l'application. `settings` : le settings.json de départ ; `files` : { "chemin relatif": contenu } à créer
 * dans le dossier de données avant le lancement ; `env` : variables en plus.
 */
export async function launch({ settings = {}, files = {}, env = {} } = {}) {
  assert.ok(fs.existsSync(EXE), `${EXE} introuvable : cargo build -p nel-desktop`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nelcode-e2e-'));
  const port = 9400 + Math.floor(Math.random() * 500);
  // Pas de recherche de mise à jour pendant les tests, réponses courtes et presque déterministes.
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ autoUpdate: false, temperature: 0.1, maxReplyTokens: 32, ...settings }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    fs.writeFileSync(path.join(home, file), content);
  }
  const app = spawn(EXE, [], {
    env: { ...process.env, NELCODE_HOME: home, NELCODE_DEBUG_PORT: String(port), WEBVIEW2_USER_DATA_FOLDER: path.join(home, 'webview'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));
  let page;
  for (let i = 0; i < 600 && !page && app.exitCode === null; i++) {
    page = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((l) => l.find((p) => p.type === 'page')).catch(() => null);
    if (!page) await sleep(100);
  }
  assert.ok(page, `la fenêtre de Nel Code ne répond pas sur le port de débogage (code de sortie : ${app.exitCode})`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result);
  };
  const send = (method, params = {}) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  /** Évalue `expr` dans la page (les promesses sont attendues) et rend sa valeur. */
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expr}\n→ ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };

  /** Attend que `expr` soit vrai (ou non vide) et rend sa valeur. */
  const waitFor = async (expr, ms = 90_000, what = expr) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await ev(expr).catch(() => undefined);
      if (v) return v;
      if (Date.now() > end) throw new Error(`délai dépassé : ${what}`);
      await sleep(100);
    }
  };

  /** Envoie un message et attend la fin de la réponse. */
  const ask = async (text) => {
    await ev(`T.submit(${JSON.stringify(text)})`);
    await waitFor('!!S.gen', 10_000, 'début de la réponse');
    await waitFor('!S.gen', 120_000, 'fin de la réponse');
  };

  /** Importe le modèle de test sous `name` par la commande /import. */
  const importAs = async (name) => {
    assert.ok(fs.existsSync(MODEL), `${MODEL} introuvable (gh release download models --pattern "minichat-v3b.nelmodel" --dir test-models)`);
    await ev(`T.submit(${JSON.stringify(`/import "${MODEL}"`)})`);
    await waitFor(`T.dialog()?.querySelector('input.text-input')`, 30_000, 'fenêtre d\'import');
    await ev(`T.setValue(T.dialog().querySelector('input.text-input'), ${JSON.stringify(name)}); T.button('Importer', T.dialog())`);
    await waitFor(`S.models.some((m) => m.name === ${JSON.stringify(name)})`, 120_000, `import de ${name}`);
  };

  const close = async () => {
    ws.close();
    app.kill();
    await sleep(1000);   // WebView2 lâche ses fichiers
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  };

  await waitFor(`typeof S === 'object' && !!S.info.version && !!S.current`, 30_000, 'démarrage de l\'interface');
  await ev(HELPERS);
  return { home, pid: app.pid, ev, waitFor, ask, importAs, close, readJson: (file) => JSON.parse(fs.readFileSync(path.join(home, file), 'utf8')) };
}
