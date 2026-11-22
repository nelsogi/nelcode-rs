// Nel Code Desktop — util.js : Les petits outils de l'interface : appels au Rust, éléments du DOM, notifications, fenêtres, menus, coloration du code.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

import { UI } from './state.js';

export const { invoke } = window.__TAURI__.core;

export const { listen } = window.__TAURI__.event;

export const $ = (id) => document.getElementById(id);

// --- Petits outils ---------------------------------------------------------------------------------------

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const pad = (n, w = 2) => String(n).padStart(w, '0');

// Comme Nel Code C# : "2026-11-11_09-25-22-218"
export const newId = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;

// Date locale avec décalage, comme System.Text.Json : "2026-11-11T09:25:44.282+01:00"
export function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export const errText = (e) => String(e?.message ?? e);

export const sizeText = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + ' Go' : (b / 1e6).toFixed(0) + ' Mo';

export const paramsText = (p) => p ? (p / 1e6).toFixed(1) + ' M' : '';

export function relDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days === 1) return 'hier';
  if (days < 7) return d.toLocaleDateString('fr-CH', { weekday: 'short' });
  return d.toLocaleDateString('fr-CH', { day: 'numeric', month: 'short' });
}

// Une ligne du journal (%APPDATA%\NelCode\logs). Seulement des événements, jamais le texte d'une conversation.
export const logEvent = (message, level = 'info') => invoke('log_event', { level, message: String(message) }).catch(() => {});

/** Les notifications : discrètes, en bas à droite, 4 au plus (la plus ancienne part), une croix pour fermer.
 *  Durée par défaut selon le genre : succès 3 s, info 4,5 s, avertissement 6 s, erreur 9 s ; 0 : jusqu'à la croix. */
const TOAST_MS = { success: 3000, '': 4500, warning: 6000, error: 9000, busy: 0 };
const MAX_TOASTS = 4;
export function toast(text, kind = '', ms = TOAST_MS[kind] ?? 4500) {
  if (kind === 'error' && typeof text === 'string') logEvent(text, 'error');
  const box = $('toasts');
  const close = h('button', { class: 'toast-close', title: 'Fermer', 'aria-label': 'Fermer la notification', onclick: () => el.remove() }, icon('x'));
  const el = h('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' },
    kind === 'error' ? icon('circle-alert') : kind === 'success' ? icon('check') : kind === 'warning' ? icon('circle-alert') : null,
    h('div', { class: 'toast-text' }, text), close);
  box.append(el);
  while (box.children.length > MAX_TOASTS) box.firstElementChild.remove();
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

// --- Blocs de code ---------------------------------------------------------------------------------------
// Les blocs ``` d'un message : coloration par expressions régulières, un <span> par morceau (textContent, jamais
// innerHTML), et un bouton Copier. Un bloc pas encore fermé (réponse en cours) est déjà affiché comme du code.

export const KEYWORDS = {
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  cs: 'abstract as async await base bool break byte case catch char class const continue decimal default delegate do double else enum event false finally float for foreach get if in init int interface internal is lock long namespace new null object out override params private protected public readonly record ref return sealed set static string struct switch this throw true try typeof uint ulong using var virtual void while yield',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield',
  js: 'async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield',
};

export const LANG_ALIAS = { 'c#': 'cs', csharp: 'cs', rs: 'rust', python: 'py', javascript: 'js', ts: 'js', typescript: 'js', jsx: 'js', tsx: 'js', mjs: 'js', xml: 'html', htm: 'html', svg: 'html' };

export const LANG_NAMES = { rust: 'Rust', cs: 'C#', py: 'Python', js: 'JavaScript', html: 'HTML', css: 'CSS', json: 'JSON' };

export const RE_STR = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`;

export const RE_NUM = String.raw`\b0x[\da-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[a-zA-Z\d]*\b`;

export const words = (l) => String.raw`\b(?:${KEYWORDS[l].split(' ').join('|')})\b`;

export const C_COMMENT = String.raw`//.*|/\*[\s\S]*?(?:\*/|$)`;

// Par langage : [classe, expression], essayées dans l'ordre (la première qui commence le plus tôt gagne).
export const HL_RULES = {
  rust: [['com', C_COMMENT], ['str', String.raw`b?"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\\n])'`], ['kw', words('rust')], ['type', String.raw`\b[A-Z]\w*`], ['num', RE_NUM]],
  cs: [['com', C_COMMENT], ['str', String.raw`[$@]*"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])'`], ['kw', words('cs')], ['type', String.raw`\b[A-Z]\w*`], ['num', RE_NUM]],
  js: [['com', C_COMMENT], ['str', RE_STR + '|`(?:\\\\.|[^`\\\\])*`'], ['kw', words('js')], ['num', RE_NUM]],
  py: [['com', '#.*'], ['str', String.raw`"{3}[\s\S]*?(?:"{3}|$)|'{3}[\s\S]*?(?:'{3}|$)|[fbr]?(?:${RE_STR})`], ['kw', words('py')], ['num', RE_NUM]],
  html: [['com', String.raw`<!--[\s\S]*?(?:-->|$)`], ['kw', String.raw`</?[\w-]+|/?>`], ['attr', String.raw`[\w-]+(?==)`], ['str', RE_STR]],
  css: [['com', String.raw`/\*[\s\S]*?(?:\*/|$)`], ['str', RE_STR], ['kw', String.raw`@[\w-]+|!important`], ['attr', String.raw`[\w-]+(?=\s*:[^:{]*[;}])`], ['num', String.raw`#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?`]],
  json: [['attr', String.raw`"(?:\\.|[^"\\])*"(?=\s*:)`], ['str', String.raw`"(?:\\.|[^"\\])*"`], ['kw', String.raw`\b(?:true|false|null)\b`], ['num', String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`]],
};

export const HL_RE = Object.fromEntries(Object.entries(HL_RULES).map(([l, rules]) => [l, new RegExp(rules.map(([, r]) => `(${r})`).join('|'), 'g')]));

export const langOf = (info) => { const l = (info || '').trim().split(/\s+/)[0].toLowerCase(); return LANG_ALIAS[l] ?? l; };

// Le code colorié : des nœuds texte et des <span class="hl-…">.
export function highlight(code, lang) {
  const re = HL_RE[lang];
  if (!re) return [code];
  const out = [];
  let last = 0;
  for (const m of code.matchAll(re)) {
    if (!m[0]) continue;
    if (m.index > last) out.push(code.slice(last, m.index));
    const k = m.findIndex((g, i) => i > 0 && g !== undefined);
    out.push(h('span', { class: 'hl-' + HL_RULES[lang][k - 1][0] }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function codeBlock(code, info) {
  const lang = langOf(info);
  const text = h('code', {}, highlight(code, lang));
  const copy = h('button', { class: 'copy', title: 'Copier le code', onclick: async () => {
    await navigator.clipboard.writeText(text.textContent);   // le code affiché (il grandit pendant la réponse)
    copy.replaceChildren(icon('check'), 'Copié'); setTimeout(() => copy.replaceChildren(icon('copy'), 'Copier'), 1200);
  } }, icon('copy'), 'Copier');
  return h('div', { class: 'code-block', 'data-lang': lang },
    h('div', { class: 'code-head' }, h('span', {}, LANG_NAMES[lang] ?? (lang || 'code')), copy),
    h('pre', {}, text));
}

// Le texte d'un message, avec ses blocs ``` (langage facultatif après les ```).
export function richText(text) {
  const out = [];
  const re = /^(`{3,})([^\n`]*)\n([\s\S]*?)(?:\n\1[ \t]*(?:\n|$)|$(?![\s\S]))/gm;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index).replace(/\n$/, ''));
    out.push(codeBlock(m[3], m[2]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Une fenêtre : rend la valeur du bouton choisi (null : Échap, clic dehors).
export function dialog(title, body, buttons, focus) {
  return new Promise((resolve) => {
    const ov = $('overlay');
    const done = (v) => { ov.hidden = true; ov.replaceChildren(); UI.closeOverlay = null; resolve(v); $('input').focus(); };
    const btns = h('div', { class: 'buttons' });
    const refresh = () => btns.replaceChildren(...buttons.filter((b) => !b.show || b.show()).map((b) =>
      h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), onclick: () => done(b.value) }, b.label)));
    refresh();
    const box = h('div', { class: 'dialog', role: 'dialog', 'aria-label': title }, h('h2', {}, title), body, btns);
    box.addEventListener('input', refresh);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') { const p = buttons.find((b) => b.primary); if (p) { e.preventDefault(); done(p.value); } }
    });
    ov.replaceChildren(box);
    ov.hidden = false;
    ov.onmousedown = (e) => { if (e.target === ov) done(null); };
    UI.closeOverlay = () => done(null);
    setTimeout(() => (focus ?? box.querySelector('.btn.primary'))?.focus(), 0);
  });
}

export const confirmDialog = (title, text, label, danger) =>
  dialog(title, h('p', {}, text), [{ label: 'Annuler', value: false }, { label, value: true, primary: !danger, danger }]);

export async function promptDialog(title, value, hint) {
  const input = h('input', { class: 'text-input', spellcheck: 'false' });
  input.value = value;
  setTimeout(() => input.select(), 0);
  const ok = await dialog(title, [input, hint && h('div', { class: 'field' }, h('div', { class: 'hint' }, hint))], [{ label: 'Annuler', value: false }, { label: 'OK', value: true, primary: true }], input);
  return ok ? input.value : null;
}

// Menu contextuel (bouton « Plus » ou clic droit).
export function showMenu(e, items) {
  const menu = $('menu');
  menu.className = 'menu';
  menu.replaceChildren(...items.map((it) => it === '-' ? h('hr') : h('button', { class: it.danger ? 'danger' : '', onclick: () => { menu.hidden = true; it.run(); } }, it.label)));
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
}
