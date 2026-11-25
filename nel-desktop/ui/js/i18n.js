// Nel Code Desktop — i18n.js : Les traductions de l'interface : t('clé', { paramètres }), pluriels, nombres et dates
// selon la langue, messages codés de la partie Rust.
//
// Les textes sont dans ui/i18n/fr.json et ui/i18n/en.json, inclus dans l'exécutable et rendus par la commande Rust
// i18n_catalog (la CSP n'autorise aucun chargement de fichier par la page). Un texte est une chaîne avec des {param},
// ou, pour un pluriel, un objet { "one": "…", "other": "…" } choisi selon le paramètre n (Intl.PluralRules).
// « {{ » et « }} » : des accolades. Une clé absente (catalogue incomplet) : le texte français, sinon la clé elle-même.
//
// Les messages de la partie Rust (erreurs, étapes de l'agent…) arrivent codés et marqués du secret du lancement (voir
// nel-desktop/src/i18n.rs) ; fromRust() (appelé par invoke et listen de util.js) en fait des objets
// { $t: 'clé', p: {…} } (un texte qui en contient : { $parts: [texte, objet, …] }). tr() traduit ces objets,
// paramètres compris ; une chaîne est toujours du texte brut, affiché tel quel, même si elle contient {"$t":…}
// (réponse du modèle, fichier lu, sortie de commande, résultat MCP…). Les anciennes conversations (chaînes
// {"$t":…} sans secret) ne sont lues que dans les champs de confiance des étapes : stepText().

const { invoke } = window.__TAURI__.core;

export const LANGS = ['fr', 'en'];

const C = { lang: 'fr', locale: 'fr-CH', msgs: {}, fr: {}, en: {}, plural: new Intl.PluralRules('fr-CH') };

// Le début des messages codés de ce lancement : {"$t<secret>": (commande i18n_mark).
const RUST_MARK = invoke('i18n_mark').catch(() => null);
let rustMark = null;
RUST_MARK.then((m) => { rustMark = m; });

/** Ce qui vient de la partie Rust (résultat d'une commande, erreur, événement) : chaque message codé marqué devient un
 *  objet { $t, p } ; le reste est gardé tel quel. Le seul endroit où une chaîne peut devenir un message codé. */
export async function fromRust(v) {
  const mark = rustMark ?? await RUST_MARK;
  return mark ? convert(v, mark) : v;
}

function convert(v, mark) {
  if (typeof v === 'string') return v.includes(mark) ? decodeMarked(v, mark) : v;
  if (Array.isArray(v)) return v.map((x) => convert(x, mark));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, convert(x, mark)]));
  return v;
}

function decodeMarked(s, mark) {
  const field = mark.slice(2, -2);   // « $t<secret> »
  const parts = [];
  let i = 0, j;
  while ((j = s.indexOf(mark, i)) >= 0) {
    if (j > i) parts.push(s.slice(i, j));
    const end = jsonEnd(s, j);
    let m = null;
    if (end > 0) { try { m = JSON.parse(s.slice(j, end)); } catch { m = null; } }
    if (typeof m?.[field] !== 'string') { parts.push(s.slice(j, j + 1)); i = j + 1; continue; }
    const p = m.p && typeof m.p === 'object' ? Object.fromEntries(Object.entries(m.p).map(([k, x]) => [k, convert(x, mark)])) : {};
    parts.push({ $t: m[field], p });
    i = end;
  }
  if (i < s.length) parts.push(s.slice(i));
  return parts.length === 1 && typeof parts[0] === 'object' ? parts[0] : { $parts: parts };
}

/** Un message codé (objet venu de la partie Rust) ? */
export const isCoded = (x) => !!x && typeof x === 'object' && (typeof x.$t === 'string' || Array.isArray(x.$parts));

/** La langue de l'interface pour un réglage (« auto » : celle du système, sinon l'anglais). */
export function resolveLang(setting) {
  if (LANGS.includes(setting)) return setting;
  const sys = (navigator.languages?.length ? navigator.languages : [navigator.language]).map((l) => String(l).toLowerCase().slice(0, 2));
  return sys.find((l) => LANGS.includes(l)) ?? 'en';
}

/** Charge la langue (réglage « auto », « fr » ou « en ») ; rend la langue choisie. */
export async function loadLang(setting) {
  const lang = resolveLang(setting);
  if (!Object.keys(C.fr).length) C.fr = JSON.parse(await invoke('i18n_catalog', { lang: 'fr' }));
  if (!Object.keys(C.en).length) C.en = JSON.parse(await invoke('i18n_catalog', { lang: 'en' }));
  C.lang = lang;
  C.msgs = lang === 'en' ? C.en : C.fr;
  // La variante régionale du système si elle est de la même langue (fr-CH, en-GB…), sinon une par défaut.
  const sys = navigator.languages?.find((l) => String(l).toLowerCase().startsWith(lang));
  C.locale = sys ?? (lang === 'fr' ? 'fr-CH' : 'en-US');
  C.plural = new Intl.PluralRules(C.locale);
  document.documentElement.lang = lang;
  invoke('set_language', { lang }).catch(() => {});   // titres des fenêtres natives (choix de fichiers)
  return lang;
}

export const lang = () => C.lang;

/** La clé existe-t-elle (dans la langue affichée ou en français) ? */
export const has = (key) => key in C.msgs || key in C.fr;

/** La locale des nombres et des dates (Intl). */
export const locale = () => C.locale;

// Un paramètre : un message codé (objet) est rendu dans la même langue ; une chaîne est du texte brut.
function format(msgs, key, params = {}, plural = C.plural, which = 'ui') {
  let v = msgs[key] ?? C.fr[key];
  if (v === undefined) return key;
  if (typeof v === 'object' && v !== null) {
    const n = Number(params.n ?? params.count ?? 0);
    v = v[plural.select(n)] ?? v.other ?? '';
  }
  return String(v).replace(/\{\{|\}\}|\{(\w+)\}/g, (m, k) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    if (!(k in params)) return m;
    const p = params[k];
    return p === null || p === undefined ? '' : isCoded(p) ? renderMsg(p, which) : String(p);
  });
}

/** Le texte de la clé dans la langue de l'interface. */
export function t(key, params) {
  const s = format(C.msgs, key, params);
  if (C.lang !== 'en') remember(s, format(C.en, key, englishParams(params), EN_PLURAL, 'en'));
  return s;
}

/** Le texte en anglais (le journal et le rapport de bug restent en anglais). */
export const tEn = (key, params) => format(C.en, key, englishParams(params), EN_PLURAL, 'en');

const EN_PLURAL = new Intl.PluralRules('en');
const FR_PLURAL = new Intl.PluralRules('fr');
const englishParams = (p) => (p ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'string' ? toEnglish(v) : v])) : p);

// Les derniers textes traduits et leur version anglaise : une notification d'erreur va au journal en anglais.
const SEEN = new Map();
function remember(text, en) {
  if (text === en || text.length > 2000) return;
  SEEN.set(text, en);
  if (SEEN.size > 500) SEEN.delete(SEEN.keys().next().value);
}

/** Un texte affiché (ou un message codé), en anglais pour le journal (inchangé s'il n'est pas connu). */
export function toEnglish(text) {
  if (isCoded(text)) return renderMsg(text, 'en');
  const s = String(text);
  return SEEN.get(s) ?? s;
}

/** Un message codé rendu : 'ui' (langue affichée), 'en', 'fr'. */
function renderMsg(m, which) {
  if (Array.isArray(m.$parts)) return m.$parts.map((x) => (isCoded(x) ? renderMsg(x, which) : String(x ?? ''))).join('');
  const p = m.p && typeof m.p === 'object' ? m.p : {};
  return which === 'en' ? format(C.en, m.$t, p, EN_PLURAL, 'en') : which === 'fr' ? format(C.fr, m.$t, p, FR_PLURAL, 'fr') : t(m.$t, p);
}

/** La fin (exclue) de l'objet JSON qui commence à `from`, ou -1. */
function jsonEnd(s, from) {
  let depth = 0, inStr = false;
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (c === '\\') k++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return k + 1;
  }
  return -1;
}

/** Un message de la partie Rust : un message codé (objet) est traduit ; une chaîne (texte d'un programme, d'un
 *  serveur, du modèle…) est rendue telle quelle. */
export function tr(x) {
  return isCoded(x) ? renderMsg(x, 'ui') : x;
}

/** Comme tr(), en français : ce qui part au modèle (résumé des étapes). */
export function trFr(x) {
  return isCoded(x) ? renderMsg(x, 'fr') : x;
}

// --- Anciennes conversations ---------------------------------------------------------------------------------------
// Avant la version 2 des étapes (champ v), un message codé était une chaîne {"$t":"clé","p":{…}}, sans secret. Une
// telle chaîne n'est lue que dans un champ écrit par Nel Code : le titre (sauf une note : texte du modèle), le détail
// d'une demande de confirmation, d'un refus ou d'une erreur de Nel Code (pas d'une commande, d'un outil MCP, d'un
// explorateur ou d'un travailleur : texte d'un programme ou d'un serveur). Un paramètre qui recevait un texte non
// fiable (chemin, requête, commande, texte d'un outil…) n'est jamais décodé, et seule une clé connue l'est.
const LEGACY_MARK = '{"$t":';
const LEGACY_RAW_PARAMS = new Set(['text', 'query', 'command', 'args', 'path', 'task', 'name', 'server', 'tool', 'title', 'detail', 'content', 'url', 'output']);

function legacyTrusted(st, field) {
  if (field === 'title') return st.kind !== 'note';
  if (field !== 'detail') return false;
  if (st.status === 'pending' || st.status === 'rejected') return true;
  return st.status === 'error' && !['command', 'mcp', 'explorer', 'worker', 'note'].includes(st.kind);
}

function legacyDecode(s, depth = 0) {
  if (typeof s !== 'string' || !s.includes(LEGACY_MARK) || depth > 4) return s;
  const parts = [];
  let i = 0, j;
  while ((j = s.indexOf(LEGACY_MARK, i)) >= 0) {
    if (j > i) parts.push(s.slice(i, j));
    const end = jsonEnd(s, j);
    let m = null;
    if (end > 0) { try { m = JSON.parse(s.slice(j, end)); } catch { m = null; } }
    if (typeof m?.$t !== 'string' || !has(m.$t)) { parts.push(s.slice(j, j + 1)); i = j + 1; continue; }
    const p = Object.fromEntries(Object.entries(m.p && typeof m.p === 'object' ? m.p : {})
      .map(([k, x]) => [k, LEGACY_RAW_PARAMS.has(k) || typeof x !== 'string' || !x.startsWith(LEGACY_MARK) ? x : legacyDecode(x, depth + 1)]));
    parts.push({ $t: m.$t, p });
    i = end;
  }
  if (i < s.length) parts.push(s.slice(i));
  if (!parts.some(isCoded)) return s;
  return parts.length === 1 ? parts[0] : { $parts: parts };
}

/** Le texte d'un champ d'une étape de l'agent (title, detail…) : 'ui', 'fr' ou 'en'. Une étape d'avant la version 2
 *  (sans v) : une ancienne chaîne codée n'est lue que dans un champ de confiance. */
export function stepText(st, field, which = 'ui') {
  let v = st?.[field];
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' && !st.v && legacyTrusted(st, field)) v = legacyDecode(v);
  return isCoded(v) ? renderMsg(v, which) : String(v);
}

/** Un nombre selon la langue (Intl.NumberFormat). */
export const num = (x, opts) => Number(x ?? 0).toLocaleString(C.locale, opts);

/** Une date (et heure) selon la langue (Intl.DateTimeFormat). */
export const date = (d, opts) => new Date(d).toLocaleDateString(C.locale, opts);
export const dateTime = (d, opts) => new Date(d).toLocaleString(C.locale, opts);

/** Les textes fixes de index.html : data-i18n (texte), data-i18n-title, data-i18n-placeholder, data-i18n-aria-label. */
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const [attr, data] of [['title', 'i18nTitle'], ['placeholder', 'i18nPlaceholder'], ['aria-label', 'i18nAriaLabel']]) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.dataset[data]));
  }
}

/** Pour les tests : le catalogue d'une langue. */
export const catalog = (l) => (l === 'en' ? C.en : C.fr);
