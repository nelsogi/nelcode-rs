// Nel Code Desktop — markdown.js : Le rendu Markdown des réponses (CommonMark, tableaux, listes de tâches, barré).
// markdown-it (vendor/, inclus dans l'application) découpe le texte en jetons ; chaque jeton devient ici un élément du
// DOM, créé un par un : jamais d'innerHTML, et une liste fermée d'éléments. Le HTML écrit par le modèle reste du texte.
// Les liens n'ont pas de href (rien ne s'ouvre dans la fenêtre) : un clic demande, puis la partie Rust ouvre le
// navigateur. Les images ne sont jamais chargées : un lien à la place.

import { t } from './i18n.js';
import MarkdownIt from '../vendor/markdown-it.js';
import { codeBlock, dialog, errText, h, highlight, invoke, langOf, toast } from './util.js';
import { S } from './state.js';

const md = new MarkdownIt({ html: false, linkify: true });
// Adresses écrites telles quelles : seulement http:// et https:// (pas « main.rs », ni « //commentaire »).
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
for (const schema of ['ftp:', '//', 'mailto:']) md.linkify.add(schema, null);

// --- Des jetons au DOM -----------------------------------------------------------------------------------

const TAGS = { paragraph: 'p', blockquote: 'blockquote', bullet_list: 'ul', ordered_list: 'ol', list_item: 'li', table: 'table', thead: 'thead', tbody: 'tbody', tr: 'tr', th: 'th', td: 'td', em: 'em', strong: 'strong', s: 's' };
const ALIGN = { 'text-align:left': 'al-left', 'text-align:center': 'al-center', 'text-align:right': 'al-right' };

/** L'adresse d'un lien qui peut s'ouvrir (http ou https, avec un hôte, sans identifiants), normalisée ; sinon null. */
export function webUrl(href) {
  if (!/^https?:\/\//i.test(href)) return null;
  let u;
  try { u = new URL(href); } catch { return null; }
  return /^https?:$/.test(u.protocol) && u.hostname && !u.username && !u.password && u.href.length <= 4096 ? u.href : null;
}

/** Un clic sur un lien : l'adresse complète, puis le navigateur (par la partie Rust) si l'utilisateur accepte. */
export async function openLink(url) {
  const ok = await dialog(t('markdown.ouvrir_ce_lien'), [
    h('p', {}, t('markdown.ce_lien_vient_reponse_modele')),
    h('div', { class: 'url link-url' }, url),
    h('div', { class: 'hint' }, t('markdown.site', { host: new URL(url).host })),
  ], [{ label: t('markdown.annuler'), value: false }, { label: t('markdown.ouvrir_dans_navigateur'), value: true, primary: true }]);
  if (!ok) return;
  try { await invoke('open_link', { url }); } catch (e) { toast(t('markdown.lien', { error: errText(e) }), 'error'); }
}

const clip = (tx) => (tx.length > 200 ? tx.slice(0, 200) + '…' : tx);

const textOf = (tokens) => (tokens ?? []).map((tx) => (tx.type === 'softbreak' || tx.type === 'hardbreak' ? ' ' : tx.children?.length ? textOf(tx.children) : tx.content)).join('');

// Un lien : cliquable en http(s) ; sinon son texte, avec l'adresse entre parenthèses (rien n'est caché).
function linkEl(href, kids, text) {
  const url = webUrl(href);
  if (url) {
    const open = (e) => { e.preventDefault(); openLink(url); };
    return h('a', { class: 'md-link', role: 'link', tabindex: '0', title: url, onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(e); } }, text ? kids : url);
  }
  const shown = md.normalizeLinkText(href);
  return h('span', { class: 'md-nolink' }, kids, text === shown || 'mailto:' + text === shown ? null : `${text ? ' ' : ''}(${clip(shown)})`);
}

// Une image : jamais chargée, un lien à la place.
function imageEl(tx, inLink) {
  const alt = textOf(tx.children), src = tx.attrGet('src') ?? '', kids = [icon('image'), alt || clip(webUrl(src) ?? 'image')];
  if (inLink) return h('span', { class: 'md-image' }, kids);
  if (/^data:/i.test(src)) return h('span', { class: 'md-image' }, kids, t('markdown.image_integree_non_affichee'));
  return h('span', { class: 'md-image' }, linkEl(src, kids, alt || 'image'));
}

// Les jetons → une liste de nœuds. Un jeton inconnu ne donne que son texte. `plain` : pas de lien cliquable (titres).
function build(tokens, plain = false) {
  const root = { kids: [] }, stack = [root];
  tokens.forEach((tx, k) => {
    const top = stack.at(-1);
    if (tx.nesting === 1) return stack.push({ token: tx, kids: [], from: k });
    if (tx.nesting === -1) return stack.length > 1 && close(stack.pop(), stack.at(-1), tokens.slice(0, k), plain);
    switch (tx.type) {
      case 'inline': {
        const kids = build(tx.children ?? [], plain);
        task(kids, stack);
        return top.kids.push(...kids);
      }
      case 'code_inline': return top.kids.push(h('code', { class: 'md-code' }, tx.content));
      case 'softbreak': case 'hardbreak': return top.kids.push(plain ? ' ' : h('br'));   // les retours à la ligne du modèle sont gardés
      case 'fence': case 'code_block': return top.kids.push(codeBlock(tx.content.replace(/\n$/, ''), tx.info));
      case 'hr': return top.kids.push(h('hr'));
      case 'image': return top.kids.push(imageEl(tx, plain || stack.some((f) => f.token?.type === 'link_open')));
      default: if (tx.content) top.kids.push(tx.content);
    }
  });
  while (stack.length > 1) close(stack.pop(), stack.at(-1), tokens, plain);
  return root.kids;
}

// La fin d'un élément : il entre dans celui qui le contient (ou seulement son contenu : liste serrée, jeton inconnu).
function close(frame, parent, tokens, plain) {
  const tx = frame.token, kind = tx.type.replace(/_open$/, '');
  let el = null;
  if (kind === 'link') el = plain ? h('span', {}, frame.kids) : linkEl(tx.attrGet('href') ?? '', frame.kids, textOf(tokens.slice(frame.from + 1)));
  else if (kind === 'heading') el = h(/^h[1-6]$/.test(tx.tag) ? tx.tag : 'p', {}, frame.kids);
  else if (!tx.hidden && Object.hasOwn(TAGS, kind)) {
    const props = {}, start = Number(tx.attrGet('start') ?? 1);
    if (frame.task) props.class = 'task';
    if (ALIGN[tx.attrGet('style')]) props.class = ALIGN[tx.attrGet('style')];
    if (kind === 'ordered_list' && start !== 1 && Number.isInteger(start)) props.start = String(start);
    el = h(TAGS[kind], props, frame.kids);
    if (kind === 'table') el = h('div', { class: 'table-wrap' }, el);
  }
  if (el) parent.kids.push(el); else parent.kids.push(...frame.kids);
}

// « [ ] » ou « [x] » au début d'un élément de liste : une case (non cliquable).
function task(kids, stack) {
  const p = stack.at(-1), li = stack.at(-2);
  if (p.token?.type !== 'paragraph_open' || li?.token?.type !== 'list_item_open' || li.kids.length || typeof kids[0] !== 'string') return;
  const m = kids[0].match(/^\[([ xX])\][ \t ]+/);
  if (!m) return;
  const done = m[1] !== ' ';
  li.task = true;
  kids.splice(0, 1, h('input', { type: 'checkbox', disabled: true, checked: done, 'aria-label': done ? t('markdown.done') : t('markdown.faire') }), kids[0].slice(m[0].length));
}

/** Une ligne (titre d'une étape) : seulement la mise en forme dans la ligne, sans lien cliquable. */
export function inlineMarkdown(text) {
  if (S.settings.markdown === false) return [text];
  try { return build(md.parseInline(closeInline(text.replace(/^(?:(?:#{1,6}|>|[-*+]|\d{1,9}[.)])\s+)+/, '')), {}), true); } catch { return [text]; }
}

// --- Pendant la génération ---------------------------------------------------------------------------------

// Le texte finit-il dans un bloc de code pas encore fermé ?
function inFence(lines) {
  let open = null;
  for (const l of lines) {
    const m = l.match(/^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*(`{3,}|~{3,})(.*)$/);
    if (!m) continue;
    if (!open) { if (m[1][0] === '~' || !m[2].includes('`')) open = m[1]; } else if (m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = null;
  }
  return !!open;
}

const cells = (row) => row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).length;

/** Une réponse en cours, complétée pour l'affichage seulement : la dernière ligne ne change pas de forme d'un morceau
 *  à l'autre (tableau dont la ligne « |---| » n'est pas finie, gras, code ou lien pas refermés, début de liste lu
 *  comme un titre). */
export function closeOpen(text) {
  const lines = text.split('\n'), line = lines.pop();
  const until = (more) => [...lines, ...more].join('\n');
  // Dans un bloc de code : rien ne change, sauf le début de la ligne qui le ferme.
  if (inFence(lines)) return until(/^\s*(`+|~+)\s*$/.test(line) ? [] : [line]);
  // Un tableau : l'en-tête seul, puis la ligne de séparation pas encore finie.
  const rule = (header) => '|' + ' --- |'.repeat(cells(header));
  const row = /^ {0,3}\|/;
  const prev = lines.at(-1) ?? '', first = prev.includes('|') && !(lines.at(-2) ?? '').includes('|');
  if (row.test(line) && /[^\s|:-]/.test(line) && !prev.includes('|')) return until([closeInline(line), rule(line)]);
  if (first && /^ {0,3}[\s|:-]*$/.test(line) && (row.test(prev) || line.includes('|'))) return until([line.trim().endsWith('|') && cells(line) === cells(prev) && /-\s*:?\s*\|$/.test(line) ? line : rule(prev)]);
  // Rien que des signes : leur sens n'est pas encore connu (« - » sous un texte en ferait un titre). Le début et la fin
  // (espaces, « > ») sont retirés d'abord : deux quantificateurs d'espaces à la suite prendraient un temps cubique
  // sur une longue ligne d'espaces (texte d'un modèle : non fiable).
  const core = line.replace(/^[\s>]+/, '').trimEnd();
  if (/^(?:[-*+]|\d{1,9}[.)])?\s*(?:\[[ xX]?\]?)?$/.test(core) || /^[-=*_#`~|]+$/.test(core)) return until([]);
  return until([closeInline(line)]);
}

// La dernière ligne : code, gras, barré, italique et lien pas encore refermés.
function closeInline(line) {
  line = line.replace(/(^|[\s|(«])(?:\*{1,3}|~{1,2})$/, '$1');   // l'ouverture seule
  if ((line.match(/`/g) ?? []).length % 2) return /`\s*$/.test(line) ? line.replace(/`\s*$/, '') : line + '`';
  const bare = line.replace(/`[^`]*`/g, (c) => 'x'.repeat(c.length)).replace(/^([\s>]*)\*(?=\s)/, '$1-');   // ni le code ni la puce ne comptent
  const link = bare.match(/!?\[([^[\]]*)\]\([^()\s]*$/);
  if (link) line = line.slice(0, link.index) + line.slice(link.index).replace(/^!?\[([^\]]*)\].*$/, '$1');
  for (const mark of ['**', '~~', '*']) {
    const parts = (mark === '*' ? bare.replaceAll('**', 'xx') : bare).split(mark);
    if (parts.length % 2) continue;
    const before = parts.at(-2), after = parts.at(-1);
    if ((before && !/[\s(«"'*_|]$/.test(before)) || !after.trim() || /^\s/.test(after)) continue;   // « 2**3 » n'ouvre pas de gras
    return line.trimEnd().replace(/[*~]$/, '').trimEnd() + mark;   // sans regex sur les espaces : temps linéaire
  }
  return line;
}

// --- L'affichage -------------------------------------------------------------------------------------------

const DRAWN = new WeakMap();   // élément → { refs, blocks: [{ key, el, fence }] }

// Les blocs de premier niveau, avec leur texte source (la clé : un bloc inchangé n'est pas redessiné).
function blocksOf(text) {
  const env = {}, tokens = md.parse(text, env), lines = text.split(/\r\n?|\n/), blocks = [];
  for (let i = 0; i < tokens.length;) {
    let j = i, depth = 0;
    do depth += tokens[j++].nesting; while (depth > 0 && j < tokens.length);
    const [from, to] = tokens[i].map ?? [0, lines.length];
    blocks.push({ key: tokens[i].type + '\n' + lines.slice(from, to).join('\n'), tokens: tokens.slice(i, j) });
    i = j;
  }
  return { refs: JSON.stringify(env.references ?? {}), blocks };
}

function blockEl({ tokens }) {
  const nodes = build(tokens);
  return nodes.length === 1 && nodes[0] instanceof Node ? nodes[0] : h('div', {}, nodes);
}

/** Affiche un texte Markdown dans `el`. `live` : réponse en cours ; seuls les blocs qui ont changé sont redessinés. */
export function drawMarkdown(el, text, live = false) {
  if (S.settings.markdown === false) return drawRaw(el, text);
  let next;
  try { next = blocksOf(live ? closeOpen(text) : text); } catch { return drawRaw(el, text); }
  const old = DRAWN.get(el);
  const same = old && old.refs === next.refs && old.blocks.length === el.childNodes.length && old.blocks.every((b) => b.el.parentNode === el);
  let k = 0;
  if (same) while (k < old.blocks.length && k < next.blocks.length && old.blocks[k].key === next.blocks[k].key) k++;
  else el.replaceChildren();
  const blocks = same ? old.blocks.slice(0, k) : [], stale = same ? old.blocks.slice(k) : [];
  for (const b of next.blocks.slice(k)) {
    const was = stale.shift(), fence = b.tokens[0].type === 'fence' ? langOf(b.tokens[0].info) : null;
    // Un bloc de code qui grandit garde son élément (défilement, bouton Copier).
    if (was && fence !== null && was.fence === fence) {
      was.el.querySelector('code').replaceChildren(...highlight(b.tokens[0].content.replace(/\n$/, ''), fence));
      blocks.push({ key: b.key, el: was.el, fence });
      continue;
    }
    const fresh = blockEl(b);
    if (was) {
      const x = was.el.scrollLeft;
      was.el.replaceWith(fresh);
      if (x) fresh.scrollLeft = x;   // un tableau large garde son défilement
    } else el.append(fresh);
    blocks.push({ key: b.key, el: fresh, fence });
  }
  for (const b of stale) b.el.remove();
  el.classList.add('md');
  DRAWN.set(el, { refs: next.refs, blocks });
}

function drawRaw(el, text) {
  DRAWN.delete(el);
  el.classList.remove('md');
  el.textContent = text;
}

// Une réponse en cours : redessinée au plus toutes les 100 ms (moins souvent si elle est très longue).
// `out` : { text } ; `target` rend l'élément où dessiner, ou rien (autre conversation, réponse finie) ; puis `after`.
const LIVE_MS = 100;

export function scheduleLive(out, target, after) {
  if (out.timer) return;
  out.timer = setTimeout(() => {
    out.timer = 0;
    const el = out.text && target();
    if (!el) return;
    const tx = performance.now();
    drawMarkdown(el, out.text.trimStart(), true);
    after();
    const now = performance.now();
    out.nextDraw = now + Math.max(LIVE_MS, 4 * (now - tx));
  }, Math.max(0, (out.nextDraw ?? 0) - performance.now()));
}
