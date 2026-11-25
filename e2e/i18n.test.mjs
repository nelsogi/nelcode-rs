// Tests des traductions : catalogues fr.json et en.json (mêmes clés, mêmes paramètres, mêmes pluriels), clés utilisées
// (JS, HTML, codes Rust), aucun texte écrit en dur dans les modules, écrans principaux dans les deux langues,
// changement de langue depuis la page Réglages, conversation enregistrée qui change de langue.
// Usage : cargo build -p nel-desktop ; node --test e2e/i18n.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, launch, sleep } from './harness.mjs';

const UI = path.join(ROOT, 'nel-desktop', 'ui');
const read = (f) => fs.readFileSync(f, 'utf8');
const FR = JSON.parse(read(path.join(UI, 'i18n', 'fr.json')));
const EN = JSON.parse(read(path.join(UI, 'i18n', 'en.json')));
const JS = fs.readdirSync(path.join(UI, 'js')).filter((f) => f.endsWith('.js')).map((f) => [f, read(path.join(UI, 'js', f))]);
const HTML = read(path.join(UI, 'index.html'));
const RUST = fs.readdirSync(path.join(ROOT, 'nel-desktop', 'src')).filter((f) => f.endsWith('.rs')).map((f) => [f, read(path.join(ROOT, 'nel-desktop', 'src', f))]);

const params = (v) => new Set((typeof v === 'string' ? [v] : Object.values(v)).flatMap((s) => [...s.replace(/\{\{|\}\}/g, '').matchAll(/\{(\w+)\}/g)].map((m) => m[1])));
const NAMESPACES = new Set(Object.keys(FR).map((k) => k.split('.')[0]));

test('fr.json et en.json : mêmes clés, mêmes paramètres, mêmes pluriels, aucun texte vide', () => {
  assert.ok(Object.keys(FR).length > 800, 'catalogue complet');
  assert.deepEqual(Object.keys(EN).sort(), Object.keys(FR).sort());
  const problems = [];
  for (const [k, fr] of Object.entries(FR)) {
    const en = EN[k];
    if (typeof fr !== typeof en) { problems.push(`${k} : pluriel dans une langue seulement`); continue; }
    if (typeof fr === 'object') {
      if (JSON.stringify(Object.keys(fr).sort()) !== JSON.stringify(['one', 'other'])) problems.push(`${k} : formes ${Object.keys(fr)}`);
      if (JSON.stringify(Object.keys(en).sort()) !== JSON.stringify(['one', 'other'])) problems.push(`${k} : formes en ${Object.keys(en)}`);
    }
    const [pf, pe] = [params(fr), params(en)];
    if ([...pf].sort().join() !== [...pe].sort().join()) problems.push(`${k} : paramètres fr {${[...pf]}} ≠ en {${[...pe]}}`);
    for (const v of typeof en === 'object' ? Object.values(en) : [en]) if (!String(v).trim() && String(fr).trim()) problems.push(`${k} : anglais vide`);
  }
  assert.deepEqual(problems, []);
});

test('toutes les clés utilisées existent : modules JS, index.html, codes de la partie Rust', () => {
  const missing = [];
  for (const [f, src] of JS) {
    for (const m of src.matchAll(/['"`]([a-z][\w-]*\.[\w.-]+)['"`]/g)) {
      const k = m[1];
      // Un préfixe ('step.status.' + état) : la famille est vérifiée dans l'application.
      if (!NAMESPACES.has(k.split('.')[0]) || /\.(js|json|md|css|html)$/.test(k) || k.endsWith('.')) continue;
      if (!(k in FR)) missing.push(`${f} : ${k}`);
    }
  }
  for (const m of HTML.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) if (!(m[1] in FR)) missing.push(`index.html : ${m[1]}`);
  let codes = 0;
  for (const [f, src] of RUST) {
    for (const m of src.matchAll(/"(rs\.[\w-]+\.[\w.-]+)"/g)) { codes++; if (!(m[1] in FR)) missing.push(`${f} : ${m[1]}`); }
  }
  assert.ok(codes > 200, `codes Rust trouvés : ${codes}`);
  assert.deepEqual(missing, []);
});

// Un découpage simple du JavaScript : chaînes et gabarits (sans les ${…}), avec leur ligne et ce qui les précède.
function literals(src) {
  const out = [];
  let i = 0, line = 1, prev = '';
  const regexAllowed = () => /[(,=:[!&|?{};+\-*%<>~^]$|^$|\breturn$|\btypeof$|\bcase$/.test(prev.trimEnd());
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; prev += c; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); line += (src.slice(i, e).match(/\n/g) ?? []).length; i = e + 2; continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, cls = false;
      while (j < src.length && (src[j] !== '/' || cls) && src[j] !== '\n') { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      i = j + 1; while (/[a-z]/.test(src[i])) i++;
      prev = 'x'; continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') { s += src[j + 1]; j += 2; } else s += src[j++]; }
      out.push({ text: s, line, before: prev.slice(-40) });
      i = j + 1; prev = 'x'; continue;
    }
    if (c === '`') {
      let j = i + 1, s = '', startLine = line;
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1; j += 2;
          while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; else if (src[j] === '\n') line++; j++; }
          s += ' ';
          continue;
        }
        if (src[j] === '\n') line++;
        s += src[j++];
      }
      out.push({ text: s, line: startLine, before: prev.slice(-40) });
      i = j + 1; prev = 'x'; continue;
    }
    prev = (prev + c).slice(-60);
    i++;
  }
  return out;
}

// Les mots qui trahissent une phrase (français ou anglais), et les noms propres et touches qu'on garde tels quels.
const STOP = /(^|\s)(le|la|les|de|des|du|un|une|et|ou|à|au|aux|pour|par|sur|avec|sans|dans|est|pas|ne|ce|cette|the|and|of|to|in|is|not|with|for|your|this|a|an)(\s|$)/i;
const KEEP = new Set(['Nel Code', 'Claude Agent', 'Claude', 'Markdown', 'JavaScript', 'Python', 'Rust', 'Anthropic', 'Ollama', 'OpenAI', 'Escape', 'Enter', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab', 'Backspace', 'Delete', 'Shift', 'Control', 'Meta', 'Alt', 'Infinity', 'Object', 'Array', 'Promise', 'Error', 'NaN',
  'Copier', 'Bearer', 'Authorization', 'Content-Type', 'GET', 'POST']);

test('aucun texte écrit en dur dans les modules (tout passe par t())', () => {
  const found = [];
  for (const [f, src] of JS) {
    if (f === 'i18n.js') continue;
    const lines = src.split('\n'), ignored = new Set();
    let skip = false;
    lines.forEach((l, k) => {
      if (l.includes('i18n-ignore-start')) skip = true;
      if (skip || /i18n-ignore(?!-)/.test(l)) ignored.add(k + 1);
      if (l.includes('i18n-ignore-end')) skip = false;
    });
    for (const { text, line, before } of literals(src)) {
      if (ignored.has(line) || !/\p{L}{3}/u.test(text)) continue;
      if (/(===|!==|==|!=)\s*$|case\s*$/.test(before)) continue;          // comparaisons (touches, valeurs techniques)
      if (/\bt\(\s*$|\btr\(\s*$|\bimport\b.*from\s*$|from\s*$/.test(before)) continue;
      if (/^[a-z][\w-]*\.[\w.-]+$/.test(text) && NAMESPACES.has(text.split('.')[0])) continue;   // une clé
      const t = text.trim();
      if (KEEP.has(t)) continue;
      const accented = /[À-ÿŒœ«»]/.test(t) && !/^[—…·→×✓∅↵≈−\s\d%$.,:;()/+-]*$/.test(t);
      const sentence = /\p{L}{2,}\s+\p{L}{2,}/u.test(t) && (STOP.test(t) || /^\p{Lu}\p{Ll}+\s/u.test(t));
      const word = /^\p{Lu}\p{Ll}{3,}[.…:!?]?$/u.test(t);
      if (accented || sentence || word) found.push(`${f}:${line} « ${t.slice(0, 70)} »`);
    }
  }
  assert.deepEqual(found, []);
});

test('index.html : aucun texte en dur, chaque titre et chaque libellé par data-i18n', () => {
  const body = HTML.slice(HTML.indexOf('<body>'), HTML.indexOf('<script'));
  const texts = [...body.replace(/<kbd>[^<]*<\/kbd>/g, '').matchAll(/>([^<]+)</g)].map((m) => m[1].trim()).filter((s) => /\p{L}/u.test(s) && s !== 'Nel Code' && s !== 'Claude Agent');
  assert.deepEqual(texts, [], 'textes hors de data-i18n');
  const attrs = [...body.matchAll(/\s(title|placeholder|aria-label)="([^"]*)"/g)].map((m) => `${m[1]}="${m[2]}"`);
  assert.deepEqual(attrs, [], 'attributs à traduire sans data-i18n-*');
});

// --- Dans l'application -----------------------------------------------------------------------------------

let A;
before(async () => { A = await launch({ settings: { language: 'fr' } }); });
after(async () => A?.close());

/** Le texte visible et les titres, libellés et indications de la page. */
const visibleText = () => A.ev(`document.body.innerText + '\\n' + [...document.querySelectorAll('[title],[placeholder],[aria-label]')].filter((e) => e.offsetParent || e === document.body).map((e) => [e.title, e.getAttribute('placeholder'), e.getAttribute('aria-label')].filter(Boolean).join('\\n')).join('\\n')`);
/** Les clés brutes restées dans la page (une clé non traduite s'affiche telle quelle). */
const rawKeys = (text) => [...new Set(text.match(/\b[a-z][\w-]*\.[a-z][\w-]*(?:\.[\w-]+)*\b/g) ?? [])].filter((k) => NAMESPACES.has(k.split('.')[0]) && k in FR);

test('familles de clés construites à l\'exécution : réglages, catégories, commandes /, raccourcis, actions, états', async () => {
  const missing = await A.ev(`(async () => {
    const { catalog } = await import('./js/i18n.js');
    const { SETTINGS, CATEGORIES } = await import('./js/settings-page.js');
    const { COMMANDS, SHORTCUTS } = await import('./js/palette.js');
    const { STEP_STATUS, PLAN_STATUS } = await import('./js/agent.js');
    const fr = catalog('fr'), need = [];
    for (const c of CATEGORIES) need.push('set.cat.' + c.id);
    for (const d of SETTINGS) { need.push('set.' + d.id + '.label'); if (d.group) need.push('set.group.' + d.group); }
    for (const d of SETTINGS.filter((x) => x.key && x.type !== 'switch' && !x.block)) if (!['select'].includes(d.type) || d.options) need.push('set.' + d.id + '.hint');
    for (const c of COMMANDS) { need.push('cmd.' + c.name + '.desc'); if (c.args) need.push('cmd.' + c.name + '.args'); }
    for (const [, d] of SHORTCUTS) need.push('shortcut.' + d);
    for (const k of ['shift', 'enter', 'esc']) need.push('keys.' + k);
    need.push(...Object.values(STEP_STATUS), ...Object.values(PLAN_STATUS));
    for (const s of ['stopped', 'starting', 'running', 'error']) need.push('mcp.state.' + s);
    for (const s of ['global', 'project']) need.push('mcp.scope.' + s);
    for (const d of SETTINGS) for (const [v, label] of d.options && d.key !== 'defaultModel' && d.key !== 'explorerModel' ? d.options() : []) if (label === 'set.' + d.key + '.opt.' + v) need.push(label);
    return need.filter((k) => !(k in fr));
  })()`);
  assert.deepEqual(missing, []);
});

async function screens(lang) {
  const shown = {};
  const grab = async (name) => { shown[name] = await visibleText(); };
  await grab('principal');
  for (const c of ['general', 'models', 'providers', 'agent', 'claude', 'mcp', 'images', 'calc', 'usage', 'server', 'advanced']) {
    await A.ev(`openSettings(${JSON.stringify(c)})`);
    await sleep(300);
    await grab('réglages ' + c);
  }
  await A.ev(`T.key('Escape', {}, document)`);
  await A.ev(`T.key('k', { ctrlKey: true }, document)`); await A.waitFor(`T.dialog()?.classList.contains('palette')`, 5_000); await grab('palette');
  await A.ev(`T.key('Escape', {}, document)`);
  for (const [cmd, what] of [['/help', 'aide'], ['/suivi', 'suivi'], ['/catalogue', 'catalogue'], ['/commands', 'commandes'], ['/info', 'infos']]) {
    await A.ev(`T.submit(${JSON.stringify(cmd)})`);
    await A.waitFor(`!!T.dialog()`, 5_000, what);
    await sleep(400);
    await grab(what);
    await A.ev(`T.key('Escape', {}, document)`);
  }
  await A.ev(`T.type('/')`); await sleep(200); await grab('suggestions /');
  await A.ev(`T.type(''); T.key('Escape', {}, document.getElementById('input')); true`);
  await A.ev(`T.key('?', {}, document.getElementById('input'))`); await A.waitFor(`!!T.dialog()`, 5_000); await grab('raccourcis');
  await A.ev(`T.key('Escape', {}, document)`);
  for (const [name, text] of Object.entries(shown)) {
    assert.deepEqual(rawKeys(text), [], `${lang}, ${name} : clés non traduites`);
    if (lang === 'en') {
      // Plus rien en français : ni accents (hors « Français », proposé dans Langue), ni mots courants.
      const fr = text.replace(/Français|Échap|é\b/g, '').match(/[^\n]*[àâçéèêëîïôûùœ«»][^\n]*/g) ?? [];
      assert.deepEqual(fr, [], `${lang}, ${name} : textes en français`);
      assert.doesNotMatch(text, /\b(Nouvelle|Réglages|Fermer|Annuler|Modèle|Dossier|réponse|conversation comparée)\b/, `${lang}, ${name}`);
    } else {
      assert.doesNotMatch(text, /\b(Settings|Close|Cancel|New conversation|Working folder|Search…)\b/, `${lang}, ${name}`);
    }
  }
}

test('écrans principaux en français : aucune clé brute, aucun texte anglais de l\'interface', async () => {
  await screens('fr');
});

test('langue changée depuis Réglages → Général : English tout de suite, sans redémarrer, puis retour au français', async () => {
  await A.ev(`openSettings('general', 'language')`);
  await A.waitFor(`T.control('language')`, 5_000);
  assert.deepEqual(await A.ev(`[...T.control('language').options].map((o) => [o.value, o.textContent])`),
    [['auto', 'Automatique (langue du système)'], ['fr', 'Français'], ['en', 'English']]);
  assert.equal(await A.ev(`T.control('language').value`), 'fr');
  await A.ev(`T.setValue(T.control('language'), 'en')`);
  await A.waitFor(`document.documentElement.lang === 'en' && S.settings.language === 'en'`, 5_000, 'anglais');
  assert.equal(A.readJson('settings.json').language, 'en');
  // La page reste ouverte, sur Général, dans la nouvelle langue.
  await A.waitFor(`document.querySelector('#settings-nav .cat.sel')?.textContent === 'General'`, 5_000);
  assert.equal(await A.ev(`T.row('language').querySelector('.setting-label').textContent`), 'Language');
  assert.equal(await A.ev(`T.control('language').selectedOptions[0].textContent`), 'English');
  assert.equal(await A.ev(`document.getElementById('settings-search').placeholder`), 'Search settings…  (Ctrl+F)');
  await A.ev(`T.key('Escape', {}, document)`);
  // Le reste de la fenêtre aussi : index.html, la barre d'état, la saisie, les fenêtres.
  assert.equal(await A.ev(`document.getElementById('new-chat').innerText.split('\\n')[0].trim()`), 'New conversation');
  assert.equal(await A.ev(`document.getElementById('settings-btn').innerText.trim()`), 'Settings');
  assert.match(await A.ev(`document.getElementById('input').placeholder`), /^Write a message…/);
  assert.equal(await A.ev(`document.getElementById('status').textContent`), 'no model loaded');
  await A.ev(`T.submit('/help')`);
  await A.waitFor(`T.dialog()?.textContent.includes('Keyboard shortcuts') || T.dialog()?.textContent.includes('Shortcuts')`, 5_000);
  assert.match(await A.ev(`T.dialog().textContent`), /New conversation[\s\S]*Shift/);
  await A.ev(`T.key('Escape', {}, document)`);
  // Un pluriel, un nombre : selon la langue.
  assert.equal(await A.ev(`window.__TAURI__ && (async () => (await import('./js/i18n.js')).t('agent.steps', { n: 1 }))()`), '1 step');
  assert.equal(await A.ev(`(async () => (await import('./js/i18n.js')).t('agent.steps', { n: 3 }))()`), '3 steps');
  assert.equal(await A.ev(`(async () => (await import('./js/i18n.js')).num(1234.5))()`), (1234.5).toLocaleString('en-US'));
  await screens('en');
  // Une erreur de la partie Rust : codée, traduite par l'interface.
  // Brute, l'erreur est marquée du secret du lancement ; l'interface (util.js, invoke) en fait un objet { $t, p }.
  const raw = await A.ev(`window.__TAURI__.core.invoke('open_folder', { path: 'Z:\\\\pas\\\\de\\\\dossier' }).then(() => '', (e) => String(e))`);
  assert.match(raw, /^\{"\$t[0-9a-f]{32}":"rs\.main\.folder_missing"/);
  const err = await A.ev(`(async () => (await import('./js/util.js')).invoke('open_folder', { path: 'Z:\\\\pas\\\\de\\\\dossier' }).then(() => null, (e) => e))()`);
  assert.equal(err.$t, 'rs.main.folder_missing');
  assert.equal(await A.ev(`(async () => (await import('./js/util.js')).errText(${JSON.stringify(err)}))()`), 'folder not found: Z:\\pas\\de\\dossier');
  // Le même texte sans le secret (venu du modèle, d'un fichier…) : du texte brut.
  assert.equal(await A.ev(`(async () => (await import('./js/util.js')).errText(${JSON.stringify(raw.replace(/\$t[0-9a-f]{32}/, '$t'))}))()`), raw.replace(/\$t[0-9a-f]{32}/, '$t'));
  // Retour au français.
  await A.ev(`openSettings('general', 'language')`);
  await A.waitFor(`T.control('language')`, 5_000);
  await A.ev(`T.setValue(T.control('language'), 'fr')`);
  await A.waitFor(`document.documentElement.lang === 'fr' && document.getElementById('new-chat').innerText.includes('Nouvelle conversation')`, 5_000, 'français');
  assert.equal(await A.ev(`document.querySelector('#settings-nav .cat.sel')?.textContent`), 'Général');
  await A.ev(`T.key('Escape', {}, document)`);
});

test('une conversation enregistrée change de langue : titres d\'étapes et détails codés', async () => {
  const coded = (k, p = {}) => JSON.stringify({ $t: k, p });
  const id = '2026-01-02_03-04-05-006';
  const session = { id, title: 'Ancienne', model: 'm', workingDirectory: '', date: '2026-01-02T03:04:05.006+01:00', messages: [
    { role: 'user', content: 'Lis le fichier' },
    { role: 'assistant', content: 'Fait.', agent: { request: 'r1', steps: [
      { id: 's1', kind: 'read', title: coded('rs.step.read', { path: 'src/a.txt' }), status: 'done', detail: 'contenu' },
      { id: 's2', kind: 'search', title: coded('rs.step.search_results', { query: 'x', n: 3, note: '' }), status: 'done' },
      { id: 's3', kind: 'error', title: coded('rs.step.unknown_tool', { name: 'z' }), status: 'error', detail: coded('rs.sandbox.parent_dir', { path: '../x' }) },
      // Des champs qui recevaient un texte non fiable : jamais décodés (note du modèle, fichier lu, paramètre query).
      { id: 's4', kind: 'note', title: coded('rs.step.read', { path: 'pirate' }), status: 'done', detail: 'x' },
      { id: 's5', kind: 'read', title: coded('rs.step.read', { path: 'b.txt' }), status: 'done', detail: coded('rs.step.read', { path: 'pirate' }) },
      { id: 's6', kind: 'search', title: coded('rs.step.search_results', { query: coded('rs.step.read', { path: 'pirate' }), n: 1, note: '' }), status: 'done' },
    ] } },
  ] };
  await A.ev(`S.sessions.push(${JSON.stringify(session)}); openSession(S.sessions.at(-1)); true`);
  const titles = () => A.ev(`[...document.querySelectorAll('#messages .step .title')].map((e) => e.textContent)`);
  await A.waitFor(`document.querySelectorAll('#messages .step').length === 6`, 5_000);
  const raw = coded('rs.step.read', { path: 'pirate' });
  assert.deepEqual(await titles(), ['Lecture de src/a.txt', 'Recherche de "x" — 3 résultats', 'Outil inconnu : z', raw, 'Lecture de b.txt', `Recherche de "${raw}" — 1 résultat`]);
  await A.ev(`document.querySelector('#messages .step[data-step="s5"]').open = true; true`);
  assert.equal(await A.ev(`document.querySelector('#messages .step[data-step="s5"] .detail').textContent`), raw);
  assert.match(await A.ev(`document.querySelector('#messages .step[data-step="s3"]').textContent`), /« \.\.\/x » : « \.\. » est refusé/);
  await A.ev(`openSettings('general', 'language')`);
  await A.waitFor(`T.control('language')`, 5_000);
  await A.ev(`T.setValue(T.control('language'), 'en')`);
  await A.waitFor(`document.documentElement.lang === 'en'`, 5_000);
  await A.ev(`T.key('Escape', {}, document)`);
  await A.waitFor(`[...document.querySelectorAll('#messages .step .title')][0]?.textContent === 'Reading src/a.txt'`, 5_000, 'titres en anglais');
  assert.deepEqual((await titles()).slice(0, 3), ['Reading src/a.txt', 'Search for "x" — 3 results', 'Unknown tool: z']);
  assert.match(await A.ev(`document.querySelector('#messages .step[data-step="s3"]').textContent`), /"\.\.\/x": "\.\." is refused/);
  await A.ev(`openSettings('general', 'language')`);
  await A.waitFor(`T.control('language')`, 5_000);
  await A.ev(`T.setValue(T.control('language'), 'fr')`);
  await A.waitFor(`document.documentElement.lang === 'fr'`, 5_000);
  await A.ev(`T.key('Escape', {}, document)`);
});

test('le journal reste en anglais, même interface en français', async () => {
  await A.ev(`window.__TAURI__.core.invoke('open_folder', { path: 'Z:\\\\absent' }).catch((e) => (async () => (await import('./js/util.js')).toast((await import('./js/util.js')).errText(e), 'error'))()).then(() => true)`);
  await sleep(500);
  const logs = fs.readdirSync(path.join(A.home, 'logs')).map((f) => read(path.join(A.home, 'logs', f))).join('');
  assert.match(logs, /starting Nel Code/);
  assert.match(logs, /folder not found: Z:\\absent/);
  assert.doesNotMatch(logs, /dossier introuvable|démarrage de Nel Code/);
});
