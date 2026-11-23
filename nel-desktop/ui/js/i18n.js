// Nel Code Desktop — i18n.js : Les traductions de l'interface : t('clé', { paramètres }), pluriels, nombres et dates
// selon la langue, messages codés de la partie Rust.
//
// Les textes sont dans ui/i18n/fr.json et ui/i18n/en.json, inclus dans l'exécutable et rendus par la commande Rust
// i18n_catalog (la CSP n'autorise aucun chargement de fichier par la page). Un texte est une chaîne avec des {param},
// ou, pour un pluriel, un objet { "one": "…", "other": "…" } choisi selon le paramètre n (Intl.PluralRules).
// « {{ » et « }} » : des accolades. Une clé absente (catalogue incomplet) : le texte français, sinon la clé elle-même.
//
// Les messages de la partie Rust (erreurs, étapes de l'agent…) arrivent codés : {"$t":"clé","p":{…}} (voir
// nel-desktop/src/i18n.rs). tr() les traduit, paramètres compris (un paramètre peut être lui-même un message codé).

const { invoke } = window.__TAURI__.core;

export const LANGS = ['fr', 'en'];

const C = { lang: 'fr', locale: 'fr-CH', msgs: {}, fr: {}, en: {}, plural: new Intl.PluralRules('fr-CH') };

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

function format(msgs, key, params = {}, plural = C.plural) {
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
    return p === null || p === undefined ? '' : typeof p === 'string' ? tr(p) : String(p);
  });
}

/** Le texte de la clé dans la langue de l'interface. */
export function t(key, params) {
  const s = format(C.msgs, key, params);
  if (C.lang !== 'en') remember(s, format(C.en, key, englishParams(params), EN_PLURAL));
  return s;
}

/** Le texte en anglais (le journal et le rapport de bug restent en anglais). */
export const tEn = (key, params) => format(C.en, key, englishParams(params), EN_PLURAL);

const EN_PLURAL = new Intl.PluralRules('en');
const englishParams = (p) => (p ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'string' ? toEnglish(v) : v])) : p);

// Les derniers textes traduits et leur version anglaise : une notification d'erreur va au journal en anglais.
const SEEN = new Map();
function remember(text, en) {
  if (text === en || text.length > 2000) return;
  SEEN.set(text, en);
  if (SEEN.size > 500) SEEN.delete(SEEN.keys().next().value);
}

/** Un texte affiché, en anglais pour le journal (inchangé s'il n'est pas connu). */
export function toEnglish(text) {
  const s = String(text);
  if (s.includes(MARK)) return renderCoded(s, 'en');
  return SEEN.get(s) ?? s;
}

const MARK = '{"$t":';

/** Le texte où chaque message codé (tout le texte, ou inclus dedans) est rendu : 'ui' (langue affichée), 'en', 'fr'. */
function renderCoded(s, which) {
  let out = '', i = 0, j;
  while ((j = s.indexOf(MARK, i)) >= 0) {
    out += s.slice(i, j);
    const end = jsonEnd(s, j);
    let m = null;
    if (end > 0) { try { m = JSON.parse(s.slice(j, end)); } catch { m = null; } }
    if (typeof m?.$t !== 'string') { out += s[j]; i = j + 1; continue; }
    out += which === 'en' ? tEn(m.$t, m.p) : which === 'fr' ? format(C.fr, m.$t, m.p, FR_PLURAL) : t(m.$t, m.p);
    i = end;
  }
  return out + s.slice(i);
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

const FR_PLURAL = new Intl.PluralRules('fr');

/** Un message de la partie Rust : ses parties codées sont traduites ; le reste (texte d'un programme, d'un serveur…)
 *  est gardé tel quel. */
export function tr(s) {
  return typeof s === 'string' && s.includes(MARK) ? renderCoded(s, 'ui') : s;
}

/** Comme tr(), en français : ce qui part au modèle (résumé des étapes). */
export function trFr(s) {
  return typeof s === 'string' && s.includes(MARK) ? renderCoded(s, 'fr') : s;
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
