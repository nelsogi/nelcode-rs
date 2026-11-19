// Nel Code Desktop — usage.js : Le suivi : page Suivi (totaux, graphiques en barres SVG, temps de réponse, export CSV),
// tokens et coût de la conversation, budget mensuel, table de prix des réglages.
// Les textes (noms de modèles, projets) passent toujours par textContent, jamais par innerHTML.
// Toutes les sommes d'argent sont des estimations (table de prix, ou coût donné par Claude Agent).

import { $, confirmDialog, dialog, errText, h, invoke, toast } from './util.js';
import { S, UI } from './state.js';

// --- Formats ----------------------------------------------------------------------------------------------

const nf = (x, d = 0) => Number(x ?? 0).toLocaleString('fr-CH', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Un coût estimé : « ≈ 0,0123 $ » (4 décimales sous 1 $, 2 au-delà). */
export const usd = (x) => `≈ ${nf(x, Math.abs(x ?? 0) >= 1 ? 2 : 4)} $`;

/** Des tokens : « 950 », « 12,3 k », « 4,56 M ». */
export const tokensText = (n) => (n >= 1e6 ? nf(n / 1e6, 2) + ' M' : n >= 1e4 ? nf(n / 1e3, 1) + ' k' : nf(n));

export const KIND_LABEL = { chat: 'chat', agent: 'mode Agent', 'claude-agent': 'Claude Agent', api: 'serveur local (API)' };

const pad = (n) => String(n).padStart(2, '0');
/** Le jour local « AAAA-MM-JJ » d'une date. */
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const projectLabel = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() || p : '(sans projet)');

// --- Calculs (aussi utilisés par les tests de l'interface) -------------------------------------------------

/** Les jours [premier, dernier] (inclus) d'aujourd'hui, de la semaine (lundi → dimanche) et du mois. */
export function periods(now = new Date()) {
  const day = (d) => dayKey(d);
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const first = new Date(now.getFullYear(), now.getMonth(), 1), last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { today: [day(now), day(now)], week: [day(monday), day(sunday)], month: [day(first), day(last)] };
}

const inRange = (e, [a, b]) => { const d = String(e.date ?? '').slice(0, 10); return d >= a && d <= b; };

/** Les sommes d'une liste de lignes : réponses, tokens d'entrée et de sortie, durée, coût. */
export function totals(entries) {
  const t = { n: 0, input: 0, output: 0, seconds: 0, cost: 0 };
  for (const e of entries) { t.n += e.n ?? 1; t.input += e.input ?? 0; t.output += e.output ?? 0; t.seconds += e.seconds ?? 0; t.cost += e.cost ?? 0; }
  return t;
}

/** Les lignes regroupées par `key(e)`, triées par `metric` décroissant : [{ key, ...totals }]. */
export function groupBy(entries, key, metric = 'tokens') {
  const m = new Map();
  for (const e of entries) { const k = key(e); if (!m.has(k)) m.set(k, []); m.get(k).push(e); }
  return [...m].map(([k, list]) => ({ key: k, ...totals(list) })).sort((a, b) => value(b, metric) - value(a, metric));
}

const value = (t, metric) => (metric === 'cost' ? t.cost : t.input + t.output);

/** Par jour sur les `days` derniers jours (jours vides compris, du plus ancien au plus récent). */
export function byDay(entries, days, now = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i);
    const k = dayKey(d);
    out.push({ key: k, date: d, ...totals(entries.filter((e) => String(e.date ?? '').startsWith(k))) });
  }
  return out;
}

// --- Graphiques en barres (SVG fait à la main) ------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// Une barre au bout arrondi (4 px) du côté de la valeur, l'autre bout carré sur la ligne de base.
function columnPath(x, y, w, base) {
  const r = Math.min(4, w / 2, base - y);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}
function rowPath(x, y, w, hgt) {
  const r = Math.min(4, hgt / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
}

const fmt = (v, metric) => (metric === 'cost' ? usd(v) : tokensText(v) + ' tokens');

// Une valeur « ronde » au-dessus du maximum, pour la ligne du haut.
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** Colonnes par jour : une seule série (pas de légende), survol : le jour et sa valeur. */
export function dayChart(rows, metric) {
  const W = 840, H = 170, top = 18, base = 140, left = 4;
  const max = niceMax(Math.max(...rows.map((r) => value(r, metric))));
  const step = (W - left) / rows.length, bw = Math.max(2, Math.min(28, step - 2));
  const every = Math.ceil(rows.length / 10);
  const label = (d) => d.toLocaleDateString('fr-CH', { day: 'numeric', month: 'short' });
  const marks = rows.map((r, i) => {
    const v = value(r, metric), x = left + i * step + (step - bw) / 2, y = base - (base - top) * (v / max);
    const tip = `${r.date.toLocaleDateString('fr-CH', { weekday: 'short', day: 'numeric', month: 'long' })} : ${fmt(v, metric)} · ${nf(r.n)} réponse${r.n > 1 ? 's' : ''}`;
    return svg('g', { class: 'mark' },
      svg('title', {}, tip),
      svg('rect', { class: 'hit', x: left + i * step, y: top, width: step, height: base - top }),
      v > 0 ? svg('path', { class: 'bar', d: columnPath(x, Math.min(y, base - 1), bw, base) }) : null,
      i % every === 0 || i === rows.length - 1 ? svg('text', { class: 'axis', x: x + bw / 2, y: base + 16, 'text-anchor': 'middle' }, label(r.date)) : null);
  });
  return svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Par jour (${metric === 'cost' ? 'coût estimé' : 'tokens'})` },
    svg('line', { class: 'grid', x1: 0, x2: W, y1: top, y2: top }),
    svg('text', { class: 'axis', x: W, y: top - 5, 'text-anchor': 'end' }, fmt(max, metric)),
    svg('line', { class: 'baseline', x1: 0, x2: W, y1: base, y2: base }),
    marks);
}

/** Barres horizontales (fournisseur, modèle, projet) : 8 au plus, le reste dans « Autres ». */
export function rankChart(groups, metric, label = (k) => k) {
  let rows = groups.filter((g) => value(g, metric) > 0);
  if (rows.length > 8) {
    const rest = rows.slice(7);
    rows = [...rows.slice(0, 7), { key: null, ...totals(rest), others: rest.length }];
  }
  if (!rows.length) return h('div', { class: 'chart-empty' }, metric === 'cost' ? 'Aucun coût sur la période (modèles gratuits).' : 'Rien sur la période.');
  const W = 840, row = 26, bh = 14, lw = 220, vw = 150, H = rows.length * row;
  const max = Math.max(...rows.map((r) => value(r, metric)));
  return svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img' }, rows.map((r, i) => {
    const v = value(r, metric), y = i * row + (row - bh) / 2, w = Math.max(2, (W - lw - vw) * v / max);
    const name = r.key === null ? `Autres (${r.others})` : label(r.key);
    const short = name.length > 30 ? name.slice(0, 29) + '…' : name;
    return svg('g', { class: 'mark' },
      svg('title', {}, `${name} : ${fmt(v, metric)} · ${nf(r.n)} réponse${r.n > 1 ? 's' : ''}${r.key && r.key !== name ? '\n' + r.key : ''}`),
      svg('rect', { class: 'hit', x: 0, y: i * row, width: W, height: row }),
      svg('text', { class: 'label', x: 0, y: y + bh - 2 }, short),
      svg('path', { class: 'bar', d: rowPath(lw, y, w, bh) }),
      svg('text', { class: 'value', x: lw + w + 8, y: y + bh - 2 }, fmt(v, metric)));
  }));
}

// --- Page Suivi ----------------------------------------------------------------------------------------------

const VIEW = { metric: 'tokens', days: 30 };

export async function openUsage() {
  let entries, budget;
  try { [entries, budget] = await Promise.all([invoke('usage_entries'), invoke('budget_status', { model: null, claude: true })]); }
  catch (e) { return toast('Suivi : ' + errText(e), 'error'); }
  const box = h('div', { class: 'usage' });
  const draw = () => box.replaceChildren(...usageBody(entries, budget, draw));
  draw();
  const choice = await dialog('Suivi', box, [{ label: 'Exporter en CSV…', value: 'csv' }, { label: 'Fermer', value: null, primary: true }]);
  if (choice === 'csv') {
    try { const path = await invoke('save_usage_csv'); if (path) toast('Suivi exporté : ' + path, 'success'); } catch (e) { toast(errText(e), 'error'); }
  }
}

function usageBody(entries, budget, redraw) {
  const p = periods();
  const tile = (name, range) => {
    const t = totals(entries.filter((e) => inRange(e, range)));
    return h('div', { class: 'tile', 'data-period': name },
      h('div', { class: 'tile-name' }, { today: 'Aujourd\'hui', week: 'Cette semaine', month: 'Ce mois' }[name]),
      h('div', { class: 'tile-value' }, tokensText(t.input + t.output), h('span', {}, ' tokens')),
      h('div', { class: 'tile-meta' }, `${usd(t.cost)} · ${nf(t.n)} réponse${t.n > 1 ? 's' : ''}`),
      h('div', { class: 'tile-meta' }, `entrée ${tokensText(t.input)} · sortie ${tokensText(t.output)}`));
  };
  const seg = (key, options) => h('div', { class: 'seg', role: 'group' }, options.map(([v, text]) =>
    h('button', { class: VIEW[key] === v ? 'on' : '', 'aria-pressed': VIEW[key] === v ? 'true' : 'false', 'data-view': `${key}:${v}`, onclick: () => { VIEW[key] = v; redraw(); } }, text)));
  const from = dayKey(new Date(Date.now() - (VIEW.days - 1) * 864e5));
  const period = entries.filter((e) => String(e.date ?? '').slice(0, 10) >= from);
  const models = groupBy(period, (e) => e.model || '?', VIEW.metric);
  const section = (title, chart, cls) => h('section', { class: 'chart-box ' + (cls ?? '') }, h('h3', {}, title), chart);
  const out = [
    h('div', { class: 'tiles' }, tile('today', p.today), tile('week', p.week), tile('month', p.month)),
  ];
  if (budget.budget > 0) {
    const pc = budget.percent, state = pc >= 100 ? 'over' : pc >= 80 ? 'warn' : '';
    out.push(h('div', { class: 'budget ' + state, title: 'Fournisseurs payants seulement (coûts estimés)' },
      h('span', {}, `Budget du mois : ${usd(budget.monthCost)} sur ${nf(budget.budget, 2)} $ (${nf(pc)} %)`),
      h('div', { class: 'bar' }, h('div', { style: `width:${Math.min(100, pc)}%` }))));
  }
  if (!entries.length) {
    out.push(h('p', { class: 'hint' }, 'Pas encore de réponse enregistrée. Chaque réponse (chat, mode Agent, Claude Agent, serveur local) ajoute une ligne : date, projet, modèle, tokens, durée — jamais le texte des messages.'));
    return out;
  }
  out.push(
    h('div', { class: 'filters' }, seg('metric', [['tokens', 'Tokens'], ['cost', 'Coût estimé']]), seg('days', [[7, '7 jours'], [30, '30 jours'], [90, '90 jours']])),
    section('Par jour', dayChart(byDay(entries, VIEW.days), VIEW.metric), 'by-day'),
    section('Par fournisseur', rankChart(groupBy(period, (e) => e.provider || '?', VIEW.metric), VIEW.metric, (k) => (k === 'local' ? 'Ce PC' : k)), 'by-provider'),
    section('Par modèle', rankChart(models, VIEW.metric), 'by-model'),
    section('Par projet', rankChart(groupBy(period, (e) => e.project || '', VIEW.metric), VIEW.metric, projectLabel), 'by-project'),
    section('Temps de réponse par modèle', h('table', { class: 'board speed' },
      h('tr', {}, ['Modèle', 'Réponses', 'Temps moyen', 'Tokens/s', 'Tokens', 'Coût estimé'].map((t) => h('th', {}, t))),
      [...models].sort((a, b) => b.n - a.n).map((m) => h('tr', {},
        h('td', {}, m.key), h('td', {}, nf(m.n)), h('td', {}, nf(m.seconds / Math.max(1, m.n), 1) + ' s'),
        h('td', {}, m.seconds > 0 ? nf(m.output / m.seconds, 1) : '—'), h('td', {}, tokensText(m.input + m.output)), h('td', {}, usd(m.cost))))), 'by-speed'),
    h('div', { class: 'hint' }, `Les ${VIEW.days} derniers jours. Coûts estimés avec la table de prix des Réglages (0 pour les modèles de ce PC et ceux sans prix) ; Claude Agent donne son propre coût. Au-delà de 90 jours, les réponses sont regroupées par jour.`),
  );
  return out;
}

// --- Conversation : tokens et coût dans l'en-tête ----------------------------------------------------------

/** Ajoute à la conversation les tokens et le coût d'une réponse (`usage` de « gen-done »). */
export function addUsage(s, usage) {
  if (!s || !usage) return;
  const u = (s.usage ??= { input: 0, output: 0, cost: 0 });
  u.input += usage.input ?? 0; u.output += usage.output ?? 0; u.cost += usage.cost ?? 0;
}

export function renderUsageChip() {
  const chip = $('usage-chip'), u = S.current?.usage;
  chip.hidden = !u || !(u.input + u.output);
  if (chip.hidden) return;
  chip.replaceChildren(h('span', {}, `${tokensText(u.input + u.output)} tokens · ${usd(u.cost)}`));
  chip.title = `Conversation : ${nf(u.input)} tokens d'entrée, ${nf(u.output)} de sortie.\nCoût estimé : ${usd(u.cost)} (estimation, table de prix des Réglages). Clic : page Suivi.`;
}

// --- Budget mensuel -------------------------------------------------------------------------------------------

/** Avant une demande : `model` (distant) ou `claude`. À 80 % du budget, un avertissement discret (une fois par mois) ;
 *  à 100 %, une confirmation (sauf si désactivée dans les réglages). Rend false si l'utilisateur renonce. */
export async function budgetOk({ model = null, claude = false }) {
  let b;
  try { b = await invoke('budget_status', { model, claude }); } catch { return true; }
  if (!b.paid || !(b.budget > 0)) return true;
  if (b.percent >= 100) {
    if (!b.confirm) return true;
    return confirmDialog('Budget du mois atteint',
      `Ce mois-ci : ${usd(b.monthCost)} sur un budget de ${nf(b.budget, 2)} $ (estimation). Cette demande est payante : l'envoyer quand même ?`, 'Envoyer quand même');
  }
  warnBudget(b);
  return true;
}

/** Après une réponse payante : prévient si elle fait passer le mois au-dessus de 80 %. */
export async function afterPaid(usage) {
  if (!(usage?.cost > 0)) return;
  try { warnBudget(await invoke('budget_status', { model: null, claude: true })); } catch { /* sans gravité */ }
}

function warnBudget(b) {
  if (!(b.budget > 0) || b.percent < 80 || UI.budgetWarned === b.month) return;
  UI.budgetWarned = b.month;
  toast(`Budget du mois : ${nf(b.percent)} % utilisés (${usd(b.monthCost)} sur ${nf(b.budget, 2)} $).`, 'warning', 6000);
}

// --- Réglages : budget et table de prix ---------------------------------------------------------------------

const priceLines = (list) => list.map((p) => `${p.model}  ${p.input}  ${p.output}`).join('\n');

/** « modèle entrée sortie » par ligne → [{ model, input, output }] ; les lignes illisibles sont rendues à part. */
export function parsePrices(text) {
  const prices = [], bad = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
    const [model, i, o] = line.split(/\s+/), num = (x) => Number(String(x).replace(',', '.'));
    if (model && Number.isFinite(num(i)) && Number.isFinite(num(o)) && num(i) >= 0 && num(o) >= 0) prices.push({ model: model.toLowerCase(), input: num(i), output: num(o) });
    else bad.push(line);
  }
  return { prices, bad };
}

/** La section Suivi des réglages : rend { el, changes() } (enregistrée avec les autres réglages). */
export async function usageSection(s) {
  const info = await invoke('usage_prices');
  const budget = h('input', { class: 'text-input port budget', type: 'number', min: 0, step: 1, value: s.budgetMonthly || '', placeholder: 'aucun' });
  const confirm = h('input', { type: 'checkbox', checked: s.budgetConfirm !== false });
  const table = h('textarea', { class: 'text-input prices', rows: 6, spellcheck: 'false' });
  table.value = priceLines(info.prices);
  const checked = new Date(info.checked + 'T12:00:00').toLocaleDateString('fr-CH', { day: 'numeric', month: 'long', year: 'numeric' });
  const el = h('div', { class: 'field usage-field' }, h('div', { class: 'row' }, h('span', {}, 'Suivi : budget et prix')),
    h('label', { class: 'inline' }, 'Budget mensuel', budget, h('span', { class: 'hint' }, '$ (fournisseurs payants ; vide : aucun)')),
    h('label', { class: 'check' }, confirm, 'À 100 % du budget, demander confirmation avant chaque nouvelle demande payante'),
    h('div', { class: 'row' }, h('span', {}, 'Prix par million de tokens (modèle, entrée, sortie, en $)'),
      h('button', { class: 'btn', onclick: () => (table.value = priceLines(info.defaults)) }, 'Prix par défaut')),
    table,
    h('div', { class: 'hint prices-checked' }, `Prix des modèles Claude vérifiés le ${checked} sur la page officielle des tarifs d'Anthropic (${info.source}), tarif de base. `
      + 'Un nom couvre aussi ses variantes datées (claude-sonnet-4-5 → claude-sonnet-4-5-20250929). Tous les coûts sont des estimations ; modèles de ce PC et modèles sans prix : 0.'));
  const changes = () => {
    const { prices, bad } = parsePrices(table.value);
    if (bad.length) toast('Prix ignorés (format « modèle entrée sortie ») : ' + bad.join(' · '), 'warning', 8000);
    // La table par défaut : rien n'est gardé dans les réglages (elle suit celle de Nel Code).
    const key = (list) => JSON.stringify(list.map((p) => [p.model, Number(p.input), Number(p.output)]));
    const same = key(prices) === key(info.defaults);
    return { budgetMonthly: Number(budget.value) || 0, budgetConfirm: confirm.checked, prices: same ? null : prices };
  };
  return { el, changes };
}
