// Nel Code Desktop — files.js : le panneau Fichiers, à droite : l'arborescence du dossier de travail, des badges sur les
// fichiers modifiés par l'agent dans la conversation, l'aperçu d'un fichier (avec coloration) et son diff de la session.
// Lecture seule : rien n'est écrit d'ici. Les textes passent toujours par textContent, jamais par innerHTML.

import { stepText, t } from './i18n.js';
import { $, codeBlock, confirmDialog, dialog, errText, h, invoke, toast } from './util.js';
import { S } from './state.js';
import { sameProject } from './projects.js';
import { EXT_LANG } from './conversation.js';
import { diffEl } from './agent.js';

/** L'état du panneau : ouvert, dossier listé, fichiers, dossiers dépliés, fichier affiché. */
export const FP = { dir: null, list: [], expanded: new Set(), selected: null, mode: 'content', loading: false, error: null };

const isOpen = () => !!S.settings.filesPanel;

/** Ouvre ou ferme le panneau (gardé dans les réglages). */
export async function toggleFiles(force) {
  const open = force ?? !isOpen();
  try { S.settings = await invoke('save_settings', { changes: { filesPanel: open } }); } catch (e) { return toast(errText(e), 'error'); }
  $('files-btn').classList.toggle('on', open);
  if (open) refreshFiles(true); else renderFiles();
}

/** Relit la liste des fichiers du dossier de travail (au plus une fois par appel en cours). */
export async function refreshFiles(force = false) {
  if (!isOpen()) return renderFiles();
  const dir = S.current?.workingDirectory || '';
  if (!force && FP.dir === dir && !FP.stale) return renderFiles();
  if (FP.dir !== dir) Object.assign(FP, { expanded: new Set(), selected: null, mode: 'content' });
  Object.assign(FP, { dir, loading: true, stale: false });
  renderFiles();
  try { FP.list = dir ? await invoke('list_files', { dir }) : []; FP.error = null; } catch (e) { FP.list = []; FP.error = errText(e); }
  FP.loading = false;
  renderFiles();
}

/** Les fichiers modifiés par l'agent dans la conversation : chemin → { kind: 'A' (créé) | 'M', steps, diffs }. */
export function sessionChanges(s = S.current) {
  const out = new Map();
  // Les étapes des réponses gardées, et celles de la réponse en cours.
  const live = S.gen?.session === s ? [{ agent: { steps: S.gen.steps ?? [] } }] : [];
  for (const m of [...(s?.messages ?? []), ...live]) {
    for (const st of m.agent?.steps ?? []) {
      if ((st.kind !== 'write' && st.kind !== 'edit') || !st.path || !['accepted', 'done'].includes(st.status)) continue;
      const path = st.path.replace(/\\/g, '/');
      const c = out.get(path) ?? { kind: st.kind === 'write' ? 'A' : 'M', steps: [], diffs: [] };
      c.steps.push([st.request, st.id]);
      if (st.diff) c.diffs.push({ title: stepText(st, 'title'), diff: st.diff });
      out.set(path, c);
    }
  }
  return out;
}

/** L'arborescence : { dirs: Map(nom → arbre), files: [nom] } à partir des chemins « a/b/c.txt ». */
function tree(paths) {
  const root = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    for (const d of parts.slice(0, -1)) {
      if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] });
      node = node.dirs.get(d);
    }
    node.files.push(parts.at(-1));
  }
  return root;
}

const BADGE_TITLE = { A: 'files.cree_par_agent_dans_cette', M: 'files.modifie_par_agent_dans_cette' };

function treeEl(node, prefix, changes, depth) {
  const items = [];
  for (const [name, sub] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
    const path = prefix + name;
    const open = FP.expanded.has(path);
    const changed = [...changes.keys()].some((p) => p.startsWith(path + '/'));
    items.push(h('li', { class: 'dir' + (open ? ' open' : ''), 'data-path': path },
      h('button', { class: 'row', style: `padding-left:${8 + depth * 14}px`, 'aria-expanded': String(open), onclick: () => { open ? FP.expanded.delete(path) : FP.expanded.add(path); renderFiles(); } },
        icon(open ? 'chevron-down' : 'chevron-right'), icon('folder'), h('span', { class: 'name' }, name), changed ? h('span', { class: 'dot changed', title: t('files.contient_fichiers_modifies_par_agent') }) : null),
      open ? h('ul', {}, treeEl(sub, path + '/', changes, depth + 1)) : null));
  }
  for (const name of [...node.files].sort((a, b) => a.localeCompare(b))) {
    const path = prefix + name;
    const c = changes.get(path);
    items.push(h('li', { class: 'file' + (FP.selected === path ? ' sel' : ''), 'data-path': path },
      h('button', { class: 'row', style: `padding-left:${22 + depth * 14}px`, onclick: () => selectFile(path) },
        icon('file'), h('span', { class: 'name' }, name), c ? h('span', { class: 'badge ' + c.kind, title: BADGE_TITLE[c.kind] ? t(BADGE_TITLE[c.kind]) : undefined }, c.kind) : null)));
  }
  return items;
}

/** Affiche un fichier (et déplie ses dossiers). */
export function selectFile(path) {
  FP.selected = path;
  FP.mode = 'content';
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) FP.expanded.add(parts.slice(0, i).join('/'));
  renderFiles();
  showPreview(path);
}

const langOfPath = (p) => EXT_LANG[p.split('.').pop().toLowerCase()] ?? '';

/** Un fichier .html ou .htm ? */
export const isHtml = (p) => /\.html?$/i.test(p || '');

/** Ouvre un fichier .html ou .htm du dossier de travail dans le navigateur par défaut. La partie Rust vérifie qu'il est
 *  dans le dossier et déjà écrit sur le disque (jamais un brouillon). Tant que « Ne plus demander pour ce projet » n'est
 *  pas coché : une confirmation (le fichier a pu être écrit par l'IA, son JavaScript s'exécutera dans le navigateur). */
export async function openInBrowser(dir, path) {
  if (!dir || !isHtml(path)) return;
  if (!(S.settings.htmlOpenNoAsk ?? []).some((p) => sameProject(p, dir))) {
    const noAsk = h('input', { type: 'checkbox', class: 'html-no-ask' });
    const ok = await dialog(t('files.open_browser_confirm_title'), [h('p', {}, t('files.open_browser_confirm', { path })), h('label', { class: 'check' }, noAsk, t('files.open_browser_no_ask'))],
      [{ label: t('util.annuler'), value: false }, { label: t('files.open_browser_ok'), value: true, primary: true }]);
    if (!ok) return;
    if (noAsk.checked) {
      try { S.settings = await invoke('save_settings', { changes: { htmlOpenNoAsk: [...(S.settings.htmlOpenNoAsk ?? []), dir] } }); } catch (e) { toast(errText(e), 'error'); }
    }
  }
  try { await invoke('open_in_browser', { dir, path }); } catch (e) { toast(errText(e), 'error'); }
}

/** Le bouton « Ouvrir dans le navigateur » d'un fichier .html ou .htm. */
export const browserButton = (dir, path, cls = 'icon-btn') => h('button', { class: cls + ' open-browser', title: t('files.open_browser_title', { path }), 'aria-label': t('files.open_browser'), onclick: () => openInBrowser(dir, path) },
  icon('external-link'), cls === 'icon-btn' ? null : t('files.open_browser'));

/** L'aperçu : le contenu colorié, ou le diff de la session. Un fichier protégé demande une confirmation. */
async function showPreview(path, confirm = false) {
  const box = $('files').querySelector('.preview');
  if (!box) return;
  const dir = FP.dir;
  const change = sessionChanges().get(path);
  const tabs = h('div', { class: 'tabs' },
    h('button', { class: FP.mode === 'content' ? 'on' : '', onclick: () => { FP.mode = 'content'; showPreview(path, confirm); } }, t('files.contenu')),
    change ? h('button', { class: FP.mode === 'diff' ? 'on' : '', onclick: () => { FP.mode = 'diff'; showPreview(path, confirm); } }, t('files.diff_session')) : null);
  const head = h('div', { class: 'preview-head' }, h('span', { class: 'path', title: path }, path), tabs,
    isHtml(path) ? browserButton(dir, path) : null,
    h('button', { class: 'icon-btn', title: t('files.fermer_apercu'), 'aria-label': t('files.fermer_apercu'), onclick: () => { FP.selected = null; renderFiles(); } }, icon('x')));
  box.replaceChildren(head, h('div', { class: 'hint' }, t('files.lecture')));
  if (FP.mode === 'diff' && change) {
    let full = null;
    try { full = await invoke('agent_session_diff', { dir, path, steps: change.steps }); } catch { /* repli sur les diffs des étapes */ }
    const body = full
      ? [h('div', { class: 'hint' }, full.created ? t('files.cree_dans_cette_conversation') : full.deleted ? t('files.supprime_depuis') : t('files.depuis_avant_premiere_modification_agent')), diffEl(full.diff)]
      : change.diffs.flatMap((d) => [h('div', { class: 'hint' }, d.title), diffEl(d.diff)]);
    return box.replaceChildren(head, ...body);
  }
  try {
    const content = await invoke('read_file', { dir, path, confirm });
    if (FP.selected !== path) return;
    box.replaceChildren(head, codeBlock(content, langOfPath(path)));
  } catch (e) {
    const [tag, pattern] = errText(e).split('\t');
    if (tag === 'PROTECTED') {
      return box.replaceChildren(head, h('div', { class: 'protected' }, icon('circle-alert'), h('span', {}, t('files.fichier_protege_il_peut_contenir', { pattern: pattern })),
        h('button', { class: 'btn', onclick: async () => {
          if (await confirmDialog(t('files.fichier_protege'), t('files.afficher_il_est_montre_qu', { path: path }), t('files.afficher'))) showPreview(path, true);
        } }, t('files.afficher_quand_meme'))));
    }
    box.replaceChildren(head, h('div', { class: 'warn-text' }, errText(e)));
  }
}

/** Le panneau entier. */
export function renderFiles() {
  const box = $('files');
  box.hidden = !isOpen();
  $('files-btn').classList.toggle('on', isOpen());
  if (box.hidden) return;
  const changes = sessionChanges();
  const count = changes.size;
  const head = h('div', { class: 'files-head' }, icon('folder-tree'), h('span', { class: 'files-title' }, t('files.fichiers')),
    count ? h('span', { class: 'files-count', title: t('files.modified_title', { n: count }) }, t('files.modified_count', { n: count })) : null,
    h('button', { class: 'icon-btn', title: t('files.relire_dossier'), 'aria-label': t('files.relire_dossier'), onclick: () => refreshFiles(true) }, icon('refresh-cw')),
    h('button', { class: 'icon-btn', title: t('files.fermer_panneau_ctrl_maj'), 'aria-label': t('files.fermer_panneau'), onclick: () => toggleFiles(false) }, icon('x')));
  const dir = h('div', { class: 'files-dir', title: FP.dir || '' }, FP.dir || t('files.aucun_dossier_travail'));
  const body = FP.loading ? h('div', { class: 'hint pad' }, t('files.lecture_dossier'))
    : FP.error ? h('div', { class: 'warn-text pad' }, FP.error)
      : FP.list.length ? h('ul', { class: 'tree' }, treeEl(tree(FP.list), '', changes, 0)) : h('div', { class: 'hint pad' }, t('files.dossier_vide'));
  box.replaceChildren(head, dir, body, FP.selected ? h('div', { class: 'preview' }) : '');
  if (FP.selected) showPreview(FP.selected);
}
