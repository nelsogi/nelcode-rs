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

// Les messages codés de la partie Rust rendus en français ou en anglais avec les catalogues de l'interface : pour
// comparer ce qui est enregistré (titres d'étapes, erreurs). Un message codé est un objet { $t, p } (ou { $parts })
// dans l'interface et les conversations ; une chaîne marquée {"$t<secret>":…} (appel direct à la partie Rust) ou
// ancienne {"$t":…} est aussi rendue (les tests seulement : l'interface ne décode jamais une chaîne).
const CATALOGS = Object.fromEntries(['fr', 'en'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, 'nel-desktop', 'ui', 'i18n', `${l}.json`), 'utf8'))]));
function one(key, p, lang) {
  const cat = CATALOGS[lang], plural = new Intl.PluralRules(lang);
  let v = cat[key] ?? key;
  p ??= {};
  if (typeof v === 'object') v = v[plural.select(Number(p.n ?? p.count ?? 0))] ?? v.other;
  return v.replace(/\{\{|\}\}|\{(\w+)\}/g, (all, k) => (all === '{{' ? '{' : all === '}}' ? '}' : k in p ? text(p[k] ?? '', lang) : all));
}
export function text(s, lang = 'fr') {
  if (s && typeof s === 'object') {
    if (Array.isArray(s.$parts)) return s.$parts.map((x) => text(x, lang)).join('');
    if (typeof s.$t === 'string') return one(s.$t, s.p, lang);
    return s;
  }
  if (typeof s !== 'string') return s;
  const re = /\{"(\$t(?:[0-9a-f]{32})?)":/g;
  let out = '', i = 0, m0;
  while ((m0 = re.exec(s))) {
    const j = m0.index;
    if (j < i) continue;
    out += s.slice(i, j);
    let depth = 0, inStr = false, end = -1;
    for (let k = j; k < s.length; k++) {
      const c = s[k];
      if (inStr) { if (c === '\\') k++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) { end = k + 1; break; }
    }
    let m = null;
    try { m = end > 0 ? JSON.parse(s.slice(j, end)) : null; } catch { m = null; }
    if (!m) { out += s[j]; i = j + 1; re.lastIndex = i; continue; }
    out += one(m[m0[1]], m.p, lang);
    i = end;
    re.lastIndex = i;
  }
  return out + s.slice(i);
}
export const fr = (s) => text(s, 'fr');

// Petits gestes dans la page : taper dans la saisie, touches, clics sur un bouton par son texte.
const HELPERS = `window.T = {
  type(text) { const i = document.getElementById('input'); i.focus(); i.value = text; i.dispatchEvent(new Event('input', { bubbles: true })); },
  key(key, opts = {}, el = document.activeElement || document.body) { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })); },
  submit(text) { T.type(text); T.key('Enter', {}, document.getElementById('input')); },
  button(text, root = document) {
    const b = [...root.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text) && !b.disabled);
    if (!b) throw new Error('bouton introuvable : ' + text);
    b.click();
    return true;
  },
  dialog() { return document.querySelector('#overlay:not([hidden]) .dialog'); },
  /** La page Réglages ouverte (null sinon). */
  settings() { return document.querySelector('#settings:not([hidden])'); },
  /** La ligne d'un réglage de la page (par sa clé ou son id), et son contrôle. */
  row(id) { return T.settings()?.querySelector('.setting[data-id="' + id + '"]'); },
  control(id) { return T.row(id)?.querySelector('.setting-control input:not([tabindex="-1"]), .setting-control select, .setting-control textarea'); },
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
  // Premier lancement déjà fait (sauf `onboarded: false` : les tests de l'assistant).
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ autoUpdate: false, temperature: 0.1, maxReplyTokens: 32, onboarded: true, language: 'fr', ...settings }));
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
    const exited = app.exitCode !== null ? Promise.resolve() : new Promise((r) => app.once('exit', r));
    app.kill();
    await Promise.race([exited, sleep(10_000)]);
    // Les processus de WebView2 peuvent garder le dossier quelques secondes de plus : ce n'est qu'un dossier
    // temporaire, un échec ici n'en est pas un pour les tests.
    try {
      // Node allonge l'attente à chaque essai (250, 500, … ms) : 8 essais, 9 s au plus (30 × 500 ms en faisaient 232).
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch (e) {
      console.warn(`dossier temporaire non effacé : ${home} (${e.code})`);
    }
  };

  await waitFor(`typeof S === 'object' && !!S.info.version && !!S.current`, 30_000, 'démarrage de l\'interface');
  await ev(HELPERS);
  /**
   * Les autorisations remises à neuf, comme au premier lancement : aucune commande autorisée, aucun outil MCP
   * « toujours autorisé », aucun projet où un .html s'ouvre sans confirmation, Claude Agent en mode « default » sans
   * outils autorisés. Appelé avant chaque test des fichiers qui partagent une application (beforeEach) : un test ne
   * profite jamais d'un accord donné par un autre.
   */
  const resetPermissions = async () => {
    const changes = { allowedCommands: [], htmlOpenNoAsk: [], claudeAllowedTools: [], claudePermissionMode: 'default' };
    await ev(`window.__TAURI__.core.invoke('save_settings', { changes: ${JSON.stringify(changes)} }).then((s) => (S.settings = s, true))`);
    const state = path.join(home, 'mcp-state.json');
    if (fs.existsSync(state)) {
      const s = JSON.parse(fs.readFileSync(state, 'utf8'));
      delete s.always;
      fs.writeFileSync(state, JSON.stringify(s, null, 2));
    }
    const s = await ev(`S.settings`);
    assert.deepEqual([s.allowedCommands, s.htmlOpenNoAsk, s.claudeAllowedTools, s.claudePermissionMode], [[], [], [], 'default'], 'autorisations remises à neuf');
  };
  /** Capture d'écran de la fenêtre, en PNG (scripts/captures.mjs). */
  const shot = async (file) => fs.writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  return { home, pid: app.pid, ev, waitFor, ask, importAs, close, shot, resetPermissions, readJson: (file) => JSON.parse(fs.readFileSync(path.join(home, file), 'utf8')) };
}
