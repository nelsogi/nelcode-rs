// Nel Code Desktop — settings-page.js : La page Réglages : catégories à gauche, réglages à droite, recherche dans toutes
// les catégories, enregistrement automatique, valeurs par défaut, liens directs (barre d'état, puce MCP, /settings,
// palette), export et import en JSON (sans aucun secret : voir store::PORTABLE_SETTINGS).
// Les textes (noms, valeurs, messages) passent toujours par textContent, jamais par innerHTML.

import { has, locale, num, t } from './i18n.js';
import { $, confirmDialog, dialog, errText, fold, h, invoke, toast } from './util.js';
import { S, UI } from './state.js';
import { loadModel, refreshContext, renderMessages, renderModels, renderStatus } from './conversation.js';
import { claudeKeyBlock } from './agent.js';
import { providersSection } from './providers.js';
import { openUsage, pricesBlock } from './usage.js';
import { mcpPanel, refreshMcp } from './mcp.js';
import { applyDensity, applyLanguage, applyTextSize, applyTheme, calcBlock, checkUpdate, copyBugReport, serverBlock } from './settings.js';

// Les catégories et les réglages : leurs textes sont dans i18n/*.json, sous des clés tirées de leur id :
// set.cat.<id> (catégorie), set.<id>.label, set.<id>.hint, set.<id>.placeholder, set.<id>.keywords (mots en plus pour la
// recherche), set.<clé>.opt.<valeur> (choix d'une liste), set.group.<groupe> (intertitre). Traduits à l'affichage.
export const CATEGORIES = [
  { id: 'general', icon: 'settings', alias: ['general', 'langue', 'language', 'theme', 'zoom'] },
  { id: 'models', icon: 'asterisk', alias: ['modeles', 'modele', 'models', 'model', 'generation', 'contexte', 'context'] },
  { id: 'providers', icon: 'arrow-left-right', alias: ['fournisseurs', 'fournisseur', 'providers', 'provider', 'distants', 'remote'] },
  { id: 'agent', icon: 'bot', alias: ['agent', 'explorateurs', 'explorers', 'travailleurs', 'workers', 'commandes', 'commands'] },
  { id: 'claude', icon: 'terminal', alias: ['claude', 'claude-agent'] },
  { id: 'mcp', icon: 'plug', alias: ['mcp'] },
  { id: 'images', icon: 'image', alias: ['images', 'image'] },
  { id: 'calc', icon: 'gauge', alias: ['calcul', 'compute', 'gpu', 'cpu'] },
  { id: 'usage', icon: 'chart-column', alias: ['suivi', 'usage', 'budget', 'prix', 'prices'] },
  { id: 'server', icon: 'external-link', alias: ['serveur', 'server', 'api'] },
  { id: 'advanced', icon: 'file-text', alias: ['avance', 'advanced', 'journal', 'log', 'bug', 'a-propos', 'about', 'export'] },
];

const catOf = (id) => CATEGORIES.find((c) => c.id === id);
export const catLabel = (c) => t('set.cat.' + (c.id ?? c));

/** Une catégorie par son id, son nom (dans la langue affichée) ou un alias (/settings gpu, /settings fournisseurs…),
 *  sans accents ni casse. */
export function findCategory(text) {
  const q = fold(String(text ?? '').trim()).replace(/\s+/g, '-');
  if (!q) return null;
  const name = (c) => fold(catLabel(c)).replace(/\s+/g, '-');
  return CATEGORIES.find((c) => c.id === q || name(c) === q || c.alias.includes(q))
    ?? CATEGORIES.find((c) => name(c).startsWith(q) || c.alias.some((a) => a.startsWith(q))) ?? null;
}

// --- Les réglages ----------------------------------------------------------------------------------------
// type : switch | select | range (curseur + champ numérique) | number | text | lines (une valeur par ligne).
// def : la valeur par défaut (celle de store::normalize) ; after : ce qui suit un changement (thème, zoom, modèle…).

const reloadModel = () => { if (S.model.name && !S.model.remote) loadModel(S.model.name); };
const reloadGguf = () => { if (S.model.name && S.models.find((m) => m.name === S.model.name)?.weights === 'gguf') loadModel(S.model.name); };
const claudeStatus = async () => { S.claudeStatus = await invoke('claude_agent_status').catch(() => S.claudeStatus); renderStatus(); };
const applyServer = async () => {
  try { S.server.port = await invoke('server_apply'); } catch (e) { S.server.port = null; toast(t('set.server.error', { error: errText(e) }), 'error', 8000); }
  renderStatus();
  UI.serverRedraw?.();
};
// Les choix d'une liste, traduits : set.<clé>.opt.<valeur>.
const opts = (key, values) => () => values.map((v) => [v, t(`set.${key}.opt.${v}`)]);

const modelOptions = () => [['', t('set.defaultModel.opt.last')], ...S.models.map((m) => [m.name, t('set.defaultModel.opt.local', { name: m.name })]),
  ...S.providers.flatMap((p) => (p.models ?? []).map((m) => [`remote:${p.id}/${m.id}`, `${m.id} — ${p.name}`]))];
const explorerKey = (v) => (v?.provider && v?.model ? JSON.stringify({ provider: v.provider, model: v.model }) : '');

export const SETTINGS = [
  // Général
  { key: 'language', cat: 'general', type: 'select', def: 'auto', options: opts('language', ['auto', 'fr', 'en']), after: applyLanguage },
  { key: 'theme', cat: 'general', type: 'select', def: 'dark', options: opts('theme', ['dark', 'light']), after: applyTheme },
  { key: 'accent', cat: 'general', type: 'select', def: 'red', options: opts('accent', ['red', 'orange']), after: applyTheme },
  { key: 'textSize', cat: 'general', type: 'range', def: 100, min: 80, max: 150, step: 10, after: applyTextSize },
  { key: 'density', cat: 'general', type: 'select', def: 'normal', options: opts('density', ['compact', 'normal', 'comfortable']), after: applyDensity },
  { key: 'markdown', cat: 'general', type: 'switch', def: true, after: () => { if (UI.editing === null) renderMessages(); } },
  { key: 'autoUpdate', cat: 'general', group: 'updates', type: 'switch', def: true, sensitive: true },
  { id: 'update-now', cat: 'general', group: 'updates', block: () => h('button', { class: 'btn', onclick: () => checkUpdate(true) }, icon('refresh-cw'), t('set.update-now.button')) },

  // Modèles
  { key: 'defaultModel', cat: 'models', type: 'select', def: '', options: modelOptions, cls: 'default-model' },
  { key: 'temperature', cat: 'models', group: 'generation', type: 'range', def: 0.8, min: 0.1, max: 2, step: 0.05 },
  { key: 'topK', cat: 'models', group: 'generation', type: 'range', def: 20, min: 0, max: 100, step: 1 },
  { key: 'topP', cat: 'models', group: 'generation', type: 'range', def: 0.9, min: 0.05, max: 1, step: 0.01 },
  { key: 'maxReplyTokens', cat: 'models', group: 'generation', type: 'range', def: 80, min: 16, max: 128, step: 1 },
  { key: 'repetitionPenalty', cat: 'models', group: 'generation', type: 'range', def: 1.15, min: 1, max: 2, step: 0.01 },
  { key: 'contextLimit', cat: 'models', group: 'context', type: 'range', def: 8192, min: 512, max: 32768, step: 512, after: () => { reloadGguf(); refreshContext(); } },
  { key: 'summaryThreshold', cat: 'models', group: 'context', type: 'range', def: 80, min: 0, max: 95, step: 5 },

  // Fournisseurs
  { id: 'providers', cat: 'providers', wide: true, block: providersSection },

  // Agent
  { key: 'agentMaxTurns', cat: 'agent', type: 'range', def: 10, min: 1, max: 50, step: 1 },
  { key: 'commandTimeout', cat: 'agent', group: 'commands', type: 'range', def: 120, min: 5, max: 600, step: 5 },
  { key: 'allowedCommands', cat: 'agent', group: 'commands', type: 'lines', def: [], cls: 'commands', sensitive: true },
  { key: 'protectedFiles', cat: 'agent', group: 'protected', type: 'lines', def: [], cls: 'protected', sensitive: true },
  { key: 'explorerConcurrency', cat: 'agent', group: 'explorers', type: 'range', def: 2, min: 1, max: 8, step: 1 },
  { key: 'explorerMax', cat: 'agent', group: 'explorers', type: 'range', def: 5, min: 0, max: 20, step: 1 },
  { key: 'explorerTurns', cat: 'agent', group: 'explorers', type: 'range', def: 6, min: 1, max: 20, step: 1 },
  { key: 'explorerModel', cat: 'agent', group: 'explorers', type: 'select', def: null, cls: 'explorer-model', encode: explorerKey, decode: (v) => (v ? JSON.parse(v) : null),
    options: () => [['', t('set.explorerModel.opt.same')], ...S.providers.flatMap((p) => (p.models ?? []).map((m) => [JSON.stringify({ provider: p.id, model: m.id }), `${m.id} — ${p.name}`]))] },
  { key: 'workerConcurrency', cat: 'agent', group: 'workers', type: 'range', def: 2, min: 1, max: 8, step: 1 },
  { key: 'workerMax', cat: 'agent', group: 'workers', type: 'range', def: 4, min: 0, max: 10, step: 1 },
  { key: 'workerTurns', cat: 'agent', group: 'workers', type: 'range', def: 10, min: 1, max: 30, step: 1 },
  { key: 'workerModel', cat: 'agent', group: 'workers', type: 'select', def: null, cls: 'worker-model', encode: explorerKey, decode: (v) => (v ? JSON.parse(v) : null),
    options: () => [['', t('set.workerModel.opt.same')], ...S.providers.flatMap((p) => (p.models ?? []).map((m) => [JSON.stringify({ provider: p.id, model: m.id }), `${m.id} — ${p.name}`]))] },

  // Claude Agent
  { id: 'claude-key', cat: 'claude', block: claudeKeyBlock },
  { key: 'claudeModel', cat: 'claude', type: 'text', def: '', cls: 'model', list: ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    validate: (v) => (!v || /^[A-Za-z0-9._\[\]-]{1,100}$/.test(v) ? null : t('set.claudeModel.invalid')), after: claudeStatus },
  { key: 'claudePermissionMode', cat: 'claude', type: 'select', def: 'default', cls: 'mode', options: opts('claudePermissionMode', ['default', 'acceptEdits']), after: claudeStatus, sensitive: true },
  { key: 'claudeAllowedTools', cat: 'claude', type: 'lines', def: [], cls: 'claude-tools', after: claudeStatus, sensitive: true },
  { key: 'claudeProjectSettings', cat: 'claude', type: 'switch', def: false, cls: 'project-settings', after: claudeStatus, sensitive: true },

  // MCP
  { key: 'mcpStartTimeout', cat: 'mcp', type: 'range', def: 30, min: 5, max: 300, step: 5 },
  { key: 'mcpCallTimeout', cat: 'mcp', type: 'range', def: 60, min: 5, max: 600, step: 5 },
  { id: 'mcp-servers', cat: 'mcp', wide: true, block: mcpPanel },

  // Images
  { key: 'imageMaxSide', cat: 'images', type: 'range', def: 1568, min: 512, max: 4096, step: 32 },
  { id: 'vision', cat: 'images', block: () => h('button', { class: 'btn', onclick: () => go('providers', 'providers') }, icon('image'), t('set.vision.button')) },

  // Calcul
  { key: 'device', cat: 'calc', type: 'select', def: 'auto', cls: 'device', options: opts('device', ['auto', 'cpu', 'gpu']), after: reloadModel },
  { id: 'gpu', cat: 'calc', block: calcBlock },

  // Suivi et budget
  { key: 'budgetMonthly', cat: 'usage', type: 'number', def: 0, min: 0, max: 1e6, step: 0.01, cls: 'budget', sensitive: true },
  { key: 'budgetConfirm', cat: 'usage', type: 'switch', def: true, sensitive: true },
  { id: 'prices', cat: 'usage', resets: { prices: null }, wide: true, block: pricesBlock, sensitive: true },
  { id: 'usage-page', cat: 'usage', block: () => h('button', { class: 'btn', onclick: () => { closeSettings(); openUsage(); } }, icon('chart-column'), t('set.usage-page.button')) },

  // Serveur local
  { key: 'serverEnabled', cat: 'server', type: 'switch', def: false, after: applyServer, sensitive: true },
  { key: 'serverPort', cat: 'server', type: 'number', def: 8765, min: 1024, max: 65535, step: 1, cls: 'port', after: applyServer },
  { id: 'server-key', cat: 'server', wide: true, block: serverBlock },

  // Avancé
  { id: 'export', cat: 'advanced', block: () => h('div', { class: 'row-btns' },
    h('button', { class: 'btn', onclick: exportSettings }, icon('download'), t('set.export.export')), h('button', { class: 'btn', onclick: importSettings }, icon('file'), t('set.export.import'))) },
  { id: 'log', cat: 'advanced', block: () => h('button', { class: 'btn', onclick: () => invoke('open_folder', { path: S.info.logs }).catch((e) => toast(errText(e), 'error')) }, icon('folder'), t('set.log.button')) },
  { id: 'bug', cat: 'advanced', block: () => h('button', { class: 'btn', onclick: copyBugReport }, icon('copy'), t('set.bug.button')) },
  { id: 'about', cat: 'advanced', block: () => h('dl', { class: 'info-grid about' },
    h('dt', {}, t('set.about.version')), h('dd', {}, S.info.version), h('dt', {}, t('set.about.data')), h('dd', {}, S.info.root), h('dt', {}, t('set.about.system')), h('dd', {}, S.info.os ?? '')) },
];

for (const d of SETTINGS) d.id ??= d.key;

// Les textes d'un réglage, dans la langue affichée.
const label = (d) => t(`set.${d.id}.label`);
const hint = (d) => (has(`set.${d.id}.hint`) ? t(`set.${d.id}.hint`) : '');
const groupLabel = (g) => t(`set.group.${g}`);
const searchText = (d) => [label(d), hint(d), has(`set.${d.id}.keywords`) ? t(`set.${d.id}.keywords`) : '', d.group ? groupLabel(d.group) : '', catLabel(d.cat)].join(' ');

/** Les valeurs par défaut, par clé (aussi celles des blocs, comme la table de prix). */
export const DEFAULTS = Object.fromEntries(SETTINGS.flatMap((d) => (d.key ? [[d.key, d.def]] : Object.entries(d.resets ?? {}))));

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const valueOf = (d) => S.settings[d.key] ?? d.def;
const isDefault = (d) => (d.key ? same(valueOf(d), d.def) : Object.entries(d.resets ?? {}).every(([k, v]) => same(S.settings[k], v)));
const shown = (d) => !d.show || d.show();
// Les nombres des champs : virgule décimale, sans séparateur de milliers (relus tels quels par parseNumber).
const nf = (x) => Number(x).toLocaleString(locale(), { maximumFractionDigits: 4, useGrouping: false });
const FIRST_CONTROL = '.setting-control input:not([tabindex="-1"]), .setting-control select, .setting-control textarea, .setting-control button';

// --- Enregistrement --------------------------------------------------------------------------------------
// Une modification à la fois, dans l'ordre (chacune rend tous les réglages : la dernière réponse est la plus récente).

let queue = Promise.resolve();
let savedTimer = 0;

function savedIndicator(state) {
  const el = $('settings-saved');
  if (!el) return;
  clearTimeout(savedTimer);
  el.dataset.state = state;
  el.replaceChildren(...(state === 'saving' ? [t('settings-page.enregistrement')] : state === 'saved' ? [icon('check'), t('settings-page.enregistre')] : []));
  if (state === 'saved') savedTimer = setTimeout(() => { el.dataset.state = ''; el.replaceChildren(); }, 1800);
}
UI.settingsSaved = () => savedIndicator('saved');

/** Enregistre des changements ({ clé: valeur }) et lance leurs suites ; rend une erreur (texte) ou null. */
export function commit(changes) {
  const run = async () => {
    savedIndicator('saving');
    const before = { ...S.settings };
    try {
      S.settings = await invoke('save_settings', { changes });
    } catch (e) { savedIndicator(''); return errText(e); }
    savedIndicator('saved');
    for (const k of Object.keys(changes)) {
      const d = SETTINGS.find((x) => x.key === k);
      if (d?.after && !same(before[k], S.settings[k])) { try { await d.after(S.settings[k], before[k]); } catch (e) { toast(errText(e), 'error'); } }
    }
    for (const k of Object.keys(changes)) P.rows.get(k)?.refresh();
    return null;
  };
  const p = queue.then(run);
  queue = p.catch(() => {});
  return p;
}

// --- Une ligne de réglage --------------------------------------------------------------------------------

/** Le texte avec la recherche surlignée (<mark>), sans accents ni casse ; textContent seulement. */
function marked(text, q) {
  if (!q) return [text];
  const chars = [...text], folded = chars.map((c) => fold(c)).join('');
  const out = [];
  let from = 0, i;
  // Les index de `folded` suivent ceux de `chars` (fold d'un caractère accentué précomposé : un caractère).
  if (folded.length !== chars.length) return [text];
  while ((i = folded.indexOf(q, from)) >= 0) {
    if (i > from) out.push(chars.slice(from, i).join(''));
    out.push(h('mark', {}, chars.slice(i, i + q.length).join('')));
    from = i + q.length;
  }
  if (from < chars.length) out.push(chars.slice(from).join(''));
  return out;
}

const parseNumber = (raw) => Number(String(raw).trim().replace(',', '.'));

function numberError(d, raw) {
  const n = parseNumber(raw);
  if (String(raw).trim() === '' || !Number.isFinite(n)) return t('settings-page.nombre_il_te_plait');
  if (n < d.min || n > d.max) return t('settings-page.entre', { nf: nf(d.min), nf2: nf(d.max) });
  if (Number.isInteger(d.step) && !Number.isInteger(n)) return t('settings-page.nombre_entier');
  if (Number.isInteger(d.step) && d.step > 1 && (n - d.min) % d.step) return t('settings-page.par_pas', { nf: nf(d.step), nf2: nf(d.min), nf3: nf(d.min + d.step), nf4: nf(d.min + 2 * d.step) });
  return null;
}

function settingRow(d, q) {
  const id = 'set-' + d.id;
  const err = h('div', { class: 'setting-error', role: 'alert', id: id + '-err', hidden: true });
  const dot = h('span', { class: 'modified', title: t('settings-page.different_valeur_par_defaut'), 'aria-label': t('settings-page.modifie') });
  const reset = h('button', { class: 'icon-btn reset', title: t('settings-page.valeur_par_defaut'), 'aria-label': t('settings-page.valeur_par_defaut_2', { label: label(d) }), onclick: () => resetOne(d) }, icon('undo-2'));
  const showError = (text) => { err.hidden = !text; err.textContent = text ?? ''; ctl?.setAttribute('aria-invalid', text ? 'true' : 'false'); };
  // refreshValue(force) : la valeur affichée suit S.settings ; un champ en cours de saisie n'est remis à jour que si
  // le changement vient d'ailleurs (force : Ctrl + / − pendant que le champ du zoom a le focus).
  let ctl = null, control, refreshValue = () => {};
  const save = async (value) => { const e = await commit({ [d.key]: value }); showError(e); };

  if (!d.key) {
    // Un bloc (fournisseurs, clé, GPU…) : rendu à part, parfois après un appel au Rust.
    control = h('div', { class: 'setting-block' });
    Promise.resolve().then(() => d.block()).then((el) => control.replaceChildren(el ?? '')).catch((e) => control.replaceChildren(h('div', { class: 'warn-text' }, errText(e))));
  } else if (d.type === 'switch') {
    ctl = h('input', { type: 'checkbox', role: 'switch', class: 'switch ' + (d.cls ?? ''), id: id + '-ctl' });
    ctl.addEventListener('change', () => save(ctl.checked));
    refreshValue = () => { ctl.checked = !!valueOf(d); };
    control = ctl;
  } else if (d.type === 'select') {
    ctl = h('select', { class: 'text-input ' + (d.cls ?? ''), id: id + '-ctl' });
    const enc = d.encode ?? ((v) => String(v ?? ''));
    refreshValue = () => {
      const opts = d.options();
      ctl.replaceChildren(...opts.map(([v, label]) => h('option', { value: v }, label)));
      const cur = enc(valueOf(d));
      // Une valeur qui n'est plus proposée (modèle supprimé) : l'option par défaut.
      ctl.value = opts.some(([v]) => v === cur) ? cur : enc(d.def);
    };
    ctl.addEventListener('change', () => save(d.decode ? d.decode(ctl.value) : ctl.value));
    control = ctl;
  } else if (d.type === 'range') {
    const range = h('input', { type: 'range', min: d.min, max: d.max, step: d.step, 'aria-label': label(d), tabindex: -1 });
    ctl = h('input', { type: 'text', inputmode: 'decimal', class: 'text-input num ' + (d.cls ?? ''), id: id + '-ctl', 'aria-describedby': id + '-err' });
    let timer = 0;
    range.addEventListener('input', () => { ctl.value = nf(range.value); showError(null); });
    range.addEventListener('change', () => save(Number(range.value)));
    ctl.addEventListener('input', () => {
      clearTimeout(timer);
      const e = numberError(d, ctl.value);
      showError(e);
      if (e) return;
      range.value = parseNumber(ctl.value);
      timer = setTimeout(() => save(parseNumber(ctl.value)), 500);
    });
    ctl.addEventListener('keydown', (e) => {
      // Flèches : un pas, comme le curseur.
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const n = Math.min(d.max, Math.max(d.min, (Number.isFinite(parseNumber(ctl.value)) ? parseNumber(ctl.value) : valueOf(d)) + (e.key === 'ArrowUp' ? 1 : -1) * d.step));
      const v = Number(n.toFixed(4));
      ctl.value = nf(v); range.value = v; showError(null);
      clearTimeout(timer); timer = setTimeout(() => save(v), 300);
    });
    ctl.addEventListener('blur', () => { if (!numberError(d, ctl.value)) { clearTimeout(timer); if (!same(parseNumber(ctl.value), valueOf(d))) save(parseNumber(ctl.value)); } });
    refreshValue = (force) => { if (force || document.activeElement !== ctl) { ctl.value = nf(valueOf(d)); range.value = valueOf(d); } };
    control = h('div', { class: 'range-pair' }, range, ctl);
    ctl.range = range;
  } else if (d.type === 'number') {
    ctl = h('input', { type: 'text', inputmode: 'decimal', class: 'text-input num ' + (d.cls ?? ''), id: id + '-ctl', 'aria-describedby': id + '-err' });
    let timer = 0;
    ctl.addEventListener('input', () => {
      clearTimeout(timer);
      const e = numberError(d, ctl.value);
      showError(e);
      if (!e) timer = setTimeout(() => save(parseNumber(ctl.value)), 600);
    });
    ctl.addEventListener('blur', () => { if (!numberError(d, ctl.value) && !same(parseNumber(ctl.value), valueOf(d))) { clearTimeout(timer); save(parseNumber(ctl.value)); } });
    refreshValue = (force) => { if (force || document.activeElement !== ctl) ctl.value = nf(valueOf(d)); };
    control = ctl;
  } else {
    // text, lines
    const lines = d.type === 'lines';
    ctl = h(lines ? 'textarea' : 'input', { class: 'text-input ' + (d.cls ?? ''), id: id + '-ctl', spellcheck: 'false', rows: lines ? 3 : undefined, placeholder: has(`set.${d.id}.placeholder`) ? t(`set.${d.id}.placeholder`) : undefined, list: d.list ? id + '-list' : undefined, 'aria-describedby': id + '-err' });
    const read = () => (lines ? ctl.value.split('\n').map((l) => l.trim()).filter(Boolean) : ctl.value.trim());
    let timer = 0;
    const flush = () => {
      clearTimeout(timer);
      const v = read(), e = d.validate?.(v);
      showError(e);
      if (!e && !same(v, valueOf(d))) save(v);
    };
    ctl.addEventListener('input', () => { clearTimeout(timer); const e = d.validate?.(read()); showError(e); if (!e) timer = setTimeout(flush, 700); });
    ctl.addEventListener('blur', flush);
    // Entrée dans un champ d'une ligne : enregistré tout de suite.
    if (!lines) ctl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); flush(); } });
    refreshValue = (force) => { if (force || document.activeElement !== ctl) ctl.value = lines ? (valueOf(d) ?? []).join('\n') : valueOf(d) ?? ''; };
    control = d.list ? h('div', {}, ctl, h('datalist', { id: id + '-list' }, ...d.list.map((m) => h('option', { value: m })))) : ctl;
  }

  const head = h('div', { class: 'setting-text' },
    h(ctl ? 'label' : 'div', { class: 'setting-label', for: ctl ? ctl.id : undefined }, dot, h('span', {}, marked(label(d), q))),
    h('div', { class: 'setting-hint', id: id + '-hint' }, marked(hint(d), q)), err);
  if (ctl && !ctl.getAttribute('aria-describedby')) ctl.setAttribute('aria-describedby', id + '-hint ' + id + '-err');
  const el = h('div', { class: 'setting' + (d.wide || d.type === 'lines' ? ' wide' : '') + (d.key ? '' : ' block'), id, 'data-key': d.key ?? '', 'data-id': d.id },
    head, h('div', { class: 'setting-control' }, control, (d.key || d.resets) ? reset : null));
  const refresh = (force) => {
    refreshValue(force);
    const def = isDefault(d);
    el.classList.toggle('changed', !def);
    reset.disabled = def;
  };
  el.refresh = refresh;
  refresh();
  if (d.key) P.rows.set(d.key, el);
  else for (const k of Object.keys(d.resets ?? {})) P.rows.set(k, el);
  return el;
}

async function resetOne(d) {
  const changes = d.key ? { [d.key]: d.def } : { ...d.resets };
  const e = await commit(changes);
  if (e) return toast(e, 'error');
  if (!d.key) draw();   // un bloc (table de prix) : redessiné avec ses valeurs par défaut
  P.rows.get(d.key)?.querySelector('input, select, textarea')?.focus();
}

async function resetCategory(cat) {
  const defs = SETTINGS.filter((d) => d.cat === cat.id && (d.key || d.resets) && !isDefault(d));
  if (!defs.length) return toast(t('settings-page.tout_est_deja_valeur_par', { label: catLabel(cat) }), '', 3000);
  const ok = await confirmDialog(t('settings-page.reinitialiser', { label: catLabel(cat) }), t('settings-page.ces_reglages_reprennent_leur_valeur', { v0: defs.map(label).join(', ') }), t('settings-page.tout_reinitialiser'), true);
  if (!ok) return;
  const changes = Object.assign({}, ...defs.map((d) => (d.key ? { [d.key]: d.def } : d.resets)));
  const e = await commit(changes);
  if (e) return toast(e, 'error');
  toast(t('settings-page.valeurs_par_defaut', { label: catLabel(cat) }), 'success', 2500);
  draw();
}

// --- La page ---------------------------------------------------------------------------------------------

const P = { cat: 'general', query: '', rows: new Map() };

/** Après un changement de langue : la page (ouverte) est reconstruite dans la nouvelle, sur la même catégorie. */
export function relabelSettings() {
  const el = $('settings');
  if (!el.firstChild) return;
  const open = !el.hidden, focusId = document.activeElement?.id;
  el.replaceChildren();
  if (!open) return;
  page();
  go(P.cat);
  (focusId && $(focusId) ? $(focusId) : $('cat-' + P.cat))?.focus();
}

/** Une ligne affichée à remettre à jour (Ctrl + / − pendant que la page est ouverte). */
export const refreshRow = (key) => P.rows.get(key)?.refresh(true);

function page() {
  let el = $('settings');
  if (el.firstChild) return el;
  const search = h('input', { id: 'settings-search', class: 'search', type: 'search', placeholder: t('settings-page.rechercher_dans_reglages_ctrl'), spellcheck: 'false', 'aria-label': t('settings-page.rechercher_dans_reglages'), 'aria-controls': 'settings-content' });
  search.addEventListener('input', () => { P.query = search.value; draw(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); $('settings-content').querySelector(FIRST_CONTROL)?.focus(); }
    if (e.key === 'Escape' && search.value) { e.preventDefault(); e.stopPropagation(); search.value = ''; P.query = ''; draw(); }
  });
  const nav = h('nav', { class: 'settings-nav', id: 'settings-nav', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('settings-page.categories') },
    CATEGORIES.map((c) => h('button', { class: 'cat', role: 'tab', id: 'cat-' + c.id, 'data-cat': c.id, 'aria-controls': 'settings-content', onclick: () => go(c.id) }, icon(c.icon), h('span', {}, catLabel(c)))));
  nav.addEventListener('keydown', (e) => {
    const i = CATEGORIES.findIndex((c) => c.id === P.cat);
    const j = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: CATEGORIES.length - 1 }[e.key];
    if (j !== undefined) { e.preventDefault(); go(CATEGORIES[(j + CATEGORIES.length) % CATEGORIES.length].id); $('cat-' + P.cat).focus(); }
    if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); $('settings-content').querySelector(FIRST_CONTROL)?.focus(); }
  });
  el.append(
    h('header', { class: 'settings-head' }, h('h1', {}, icon('settings'), t('settings-page.reglages')), search,
      h('span', { id: 'settings-saved', class: 'saved', role: 'status', 'aria-live': 'polite' }),
      h('button', { class: 'icon-btn close', title: t('settings-page.fermer_echap'), 'aria-label': t('settings-page.fermer_reglages'), onclick: closeSettings }, icon('x'))),
    h('div', { class: 'settings-body' }, nav, h('main', { id: 'settings-content', class: 'settings-content', role: 'tabpanel', tabindex: -1 })));
  el.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.focus(); search.select(); }
  });
  return el;
}

/** Dessine la catégorie choisie, ou les résultats de la recherche (toutes catégories). */
function draw() {
  const content = $('settings-content');
  if (!content) return;
  P.rows.clear();
  UI.mcpRedraw = null;
  UI.serverRedraw = null;
  const q = fold(P.query.trim());
  for (const b of $('settings-nav').querySelectorAll('.cat')) {
    const on = !q && b.dataset.cat === P.cat;
    b.classList.toggle('sel', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = b.dataset.cat === P.cat ? 0 : -1;
  }
  if (q) {
    const hits = SETTINGS.filter((d) => shown(d) && fold(searchText(d)).includes(q));
    const groups = CATEGORIES.map((c) => [c, hits.filter((d) => d.cat === c.id)]).filter(([, l]) => l.length);
    content.replaceChildren(h('div', { class: 'settings-results', 'aria-live': 'polite' }, hits.length ? t('settings-page.found', { n: hits.length }) : t('settings-page.aucun_reglage_ne_correspond', { query: P.query.trim() })),
      ...groups.map(([c, list]) => h('section', { class: 'settings-section cat-' + c.id },
        h('h2', {}, h('button', { class: 'link', onclick: () => go(c.id) }, catLabel(c))),
        // Les blocs (fournisseurs, GPU…) : un lien vers leur catégorie, pas leur contenu en double.
        list.map((d) => (d.key ? settingRow(d, q) : linkRow(d, q))))));
    return;
  }
  const cat = catOf(P.cat);
  const defs = SETTINGS.filter((d) => d.cat === cat.id && shown(d));
  const out = [];
  let group = null;
  for (const d of defs) {
    if (d.group && d.group !== group) out.push(h('h3', {}, groupLabel(d.group)));
    group = d.group ?? group;
    out.push(settingRow(d, ''));
  }
  const resettable = defs.some((d) => d.key || d.resets);
  content.replaceChildren(h('section', { class: 'settings-section cat-' + cat.id },
    h('div', { class: 'section-head' }, h('h2', {}, catLabel(cat)),
      resettable ? h('button', { class: 'btn reset-all', onclick: () => resetCategory(cat) }, icon('undo-2'), t('settings-page.tout_reinitialiser')) : null),
    out));
  content.scrollTop = 0;
}

function linkRow(d, q) {
  return h('div', { class: 'setting block link-row', 'data-id': d.id },
    h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, h('span', {}, marked(label(d), q))), h('div', { class: 'setting-hint' }, marked(hint(d), q))),
    h('div', { class: 'setting-control' }, h('button', { class: 'btn', onclick: () => go(d.cat, d.id) }, t('settings-page.ouvrir', { label: catLabel(d.cat) }), icon('chevron-right'))));
}

/** Montre une catégorie ; `id` : un réglage à faire voir (défilé jusqu'à lui, surligné, avec le focus). */
export function go(cat, id) {
  P.cat = catOf(cat) ? cat : 'general';
  P.query = '';
  const search = $('settings-search');
  if (search) search.value = '';
  draw();
  if (id) highlight(id);
}

function highlight(id) {
  const el = $('settings-content').querySelector(`.setting[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  (el.querySelector('.setting-control input:not([tabindex="-1"]), .setting-control select, .setting-control textarea') ?? el.querySelector('button'))?.focus({ preventScroll: true });
}

/** Ouvre la page Réglages : `cat` (id, nom ou alias, comme /settings gpu), `id` : un réglage à montrer. */
export async function openSettings(cat, id) {
  if (typeof cat !== 'string') cat = undefined;   // clic sur un bouton : l'événement
  const c = cat ? findCategory(cat) : null;
  if (cat && !c) toast(t('settings-page.categorie_inconnue_categories', { cat: cat, v1: CATEGORIES.map((x) => x.alias[0]).join(', ') }), 'warning', 6000);
  UI.closeOverlay?.();
  if (S.providers.length === 0) S.providers = await invoke('list_providers').catch(() => []);
  const el = page();
  el.hidden = false;
  $('app').inert = true;
  UI.page = { close: closeSettings };
  go(c?.id ?? (cat ? 'general' : P.cat), id);
  if (!id) (c ? $('cat-' + P.cat) : $('settings-search')).focus();
}

export function closeSettings() {
  const el = $('settings');
  if (!el || el.hidden) return;
  // Un champ en cours de saisie : enregistré avant de fermer.
  document.activeElement?.blur?.();
  el.hidden = true;
  $('app').inert = false;
  UI.page = null;
  UI.mcpRedraw = null;
  UI.serverRedraw = null;
  $('settings-content').replaceChildren();
  P.rows.clear();
  refreshMcp();
  renderModels();
  renderStatus();
  refreshContext();
  $('input').focus();
}

// --- Export et import ------------------------------------------------------------------------------------

async function exportSettings() {
  try {
    const path = await invoke('export_settings');
    if (path) toast(t('settings-page.reglages_exportes', { path: path }), 'success', 6000);
  } catch (e) { toast(t('settings-page.export_impossible', { error: errText(e) }), 'error'); }
}

async function importSettings() {
  let r;
  try { r = await invoke('import_settings'); } catch (e) { return toast(t('settings-page.import_impossible', { error: errText(e) }), 'error', 8000); }
  if (r) await applyImport(r);
}

/** Montre ce que l'import change (les réglages qui touchent à la sécurité en premier), puis l'enregistre. */
export async function applyImport({ changes, ignored = [] }) {
  // Un réglage par sa clé, ou un bloc par son id (la table de prix : « prices »).
  const defOf = (k) => SETTINGS.find((x) => x.key === k) ?? SETTINGS.find((x) => !x.key && x.id === k);
  const nameOf = (k) => { const d = defOf(k); return d ? label(d) : k; };
  // Tout est montré en clair : un objet en JSON, jamais « [object Object] ».
  const plain = (x) => (x !== null && typeof x === 'object' ? JSON.stringify(x) : String(x));
  const show = (k, v) => {
    const d = defOf(k);
    if (k === 'prices' && Array.isArray(v)) return v.length ? v.map((p) => t('settings-page.import_price', { model: plain(p?.model), input: num(p?.input), output: num(p?.output) })).join(' ; ') : t('settings-page.empty_list');
    if (Array.isArray(v)) return v.length ? v.map(plain).join(', ') : t('settings-page.empty_list');
    if (d?.type === 'switch') return v ? t('settings-page.active') : t('settings-page.desactive');
    if (d?.type === 'select') return d.options().find(([o]) => o === (d.encode ?? String)(v ?? ''))?.[1] ?? String(v ?? '—');
    if (v === null || v === undefined) return t('settings-page.par_defaut');
    return plain(v);
  };
  const diff = Object.entries(changes).filter(([k, v]) => !same(S.settings[k] ?? DEFAULTS[k], v ?? DEFAULTS[k]));
  if (!diff.length) return toast(t('settings-page.ces_reglages_sont_deja_tiens'), '', 4000);
  const sensitive = (k) => defOf(k)?.sensitive;
  diff.sort(([a], [b]) => Number(!!sensitive(b)) - Number(!!sensitive(a)));
  const rows = diff.map(([k, v]) => h('li', { class: sensitive(k) ? 'sensitive' : '' }, sensitive(k) ? icon('circle-alert') : null,
    h('b', {}, nameOf(k)), t('settings-page.change_line', { from: show(k, S.settings[k] ?? DEFAULTS[k]), to: show(k, v) })));
  const body = [h('p', {}, t('settings-page.changes', { n: diff.length })), h('ul', { class: 'import-diff' }, rows),
    diff.some(([k]) => sensitive(k)) ? h('p', { class: 'warn-text' }, icon('circle-alert'), t('settings-page.reglages_marques_touchent_securite_commandes')) : null,
    ignored.length ? h('p', { class: 'hint' }, t('settings-page.ignores_pas_preferences_portables', { ignored: ignored.join(', ') })) : null];
  if (await dialog(t('settings-page.importer_reglages'), body, [{ label: t('settings-page.annuler'), value: false }, { label: t('settings-page.importer_2'), value: true, primary: true }]) !== true) return;
  const e = await commit(Object.fromEntries(diff));
  if (e) return toast(t('settings-page.import', { value: e }), 'error');
  toast(t('settings-page.imported', { n: diff.length }), 'success');
  draw();
}

/** La palette Ctrl+K : chaque catégorie et chaque réglage. */
export function paletteItems() {
  return [...CATEGORIES.map((c) => ({ kind: t('palette.kind.settings'), text: t('settings-page.reglages_2', { label: catLabel(c) }), key: '', run: () => openSettings(c.id) })),
    ...SETTINGS.filter((d) => d.key || d.block).map((d) => ({ kind: t('palette.kind.setting'), text: t('settings-page.palette_setting', { label: label(d), cat: catLabel(d.cat) }), key: '', search: searchText(d), run: () => openSettings(d.cat, d.id) }))];
}
