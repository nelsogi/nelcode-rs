// Nel Code Desktop — files.js : le panneau Fichiers, à droite : l'arborescence du dossier de travail, des badges sur les
// fichiers modifiés par l'agent dans la conversation, l'aperçu d'un fichier (avec coloration) et son diff de la session.
// Lecture seule : rien n'est écrit d'ici. Les textes passent toujours par textContent, jamais par innerHTML.

import { $, codeBlock, confirmDialog, errText, h, invoke, toast } from './util.js';
import { S } from './state.js';
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
      if (st.diff) c.diffs.push({ title: st.title, diff: st.diff });
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

const BADGE_TITLE = { A: 'créé par l\'agent dans cette conversation', M: 'modifié par l\'agent dans cette conversation' };

function treeEl(node, prefix, changes, depth) {
  const items = [];
  for (const [name, sub] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
    const path = prefix + name;
    const open = FP.expanded.has(path);
    const changed = [...changes.keys()].some((p) => p.startsWith(path + '/'));
    items.push(h('li', { class: 'dir' + (open ? ' open' : ''), 'data-path': path },
      h('button', { class: 'row', style: `padding-left:${8 + depth * 14}px`, 'aria-expanded': String(open), onclick: () => { open ? FP.expanded.delete(path) : FP.expanded.add(path); renderFiles(); } },
        icon(open ? 'chevron-down' : 'chevron-right'), icon('folder'), h('span', { class: 'name' }, name), changed ? h('span', { class: 'dot changed', title: 'contient des fichiers modifiés par l\'agent' }) : null),
      open ? h('ul', {}, treeEl(sub, path + '/', changes, depth + 1)) : null));
  }
  for (const name of [...node.files].sort((a, b) => a.localeCompare(b))) {
    const path = prefix + name;
    const c = changes.get(path);
    items.push(h('li', { class: 'file' + (FP.selected === path ? ' sel' : ''), 'data-path': path },
      h('button', { class: 'row', style: `padding-left:${22 + depth * 14}px`, onclick: () => selectFile(path) },
        icon('file'), h('span', { class: 'name' }, name), c ? h('span', { class: 'badge ' + c.kind, title: BADGE_TITLE[c.kind] }, c.kind) : null)));
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

/** L'aperçu : le contenu colorié, ou le diff de la session. Un fichier protégé demande une confirmation. */
async function showPreview(path, confirm = false) {
  const box = $('files').querySelector('.preview');
  if (!box) return;
  const dir = FP.dir;
  const change = sessionChanges().get(path);
  const tabs = h('div', { class: 'tabs' },
    h('button', { class: FP.mode === 'content' ? 'on' : '', onclick: () => { FP.mode = 'content'; showPreview(path, confirm); } }, 'Contenu'),
    change ? h('button', { class: FP.mode === 'diff' ? 'on' : '', onclick: () => { FP.mode = 'diff'; showPreview(path, confirm); } }, 'Diff de la session') : null);
  const head = h('div', { class: 'preview-head' }, h('span', { class: 'path', title: path }, path), tabs,
    h('button', { class: 'icon-btn', title: 'Fermer l\'aperçu', 'aria-label': 'Fermer l\'aperçu', onclick: () => { FP.selected = null; renderFiles(); } }, icon('x')));
  box.replaceChildren(head, h('div', { class: 'hint' }, 'Lecture…'));
  if (FP.mode === 'diff' && change) {
    let full = null;
    try { full = await invoke('agent_session_diff', { dir, path, steps: change.steps }); } catch { /* repli sur les diffs des étapes */ }
    const body = full
      ? [h('div', { class: 'hint' }, full.created ? 'Créé dans cette conversation.' : full.deleted ? 'Supprimé depuis.' : 'Depuis avant la première modification de l\'agent dans cette conversation.'), diffEl(full.diff)]
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
      return box.replaceChildren(head, h('div', { class: 'protected' }, icon('circle-alert'), h('span', {}, `Fichier protégé (${pattern}) : il peut contenir des mots de passe ou des clés.`),
        h('button', { class: 'btn', onclick: async () => {
          if (await confirmDialog('Fichier protégé', `Afficher « ${path} » ? Il n'est montré qu'ici, rien n'est envoyé au modèle.`, 'Afficher')) showPreview(path, true);
        } }, 'Afficher quand même')));
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
  const head = h('div', { class: 'files-head' }, icon('folder-tree'), h('span', { class: 'files-title' }, 'Fichiers'),
    count ? h('span', { class: 'files-count', title: `${count} fichier(s) modifié(s) par l'agent dans cette conversation` }, `${count} modifié${count > 1 ? 's' : ''}`) : null,
    h('button', { class: 'icon-btn', title: 'Relire le dossier', 'aria-label': 'Relire le dossier', onclick: () => refreshFiles(true) }, icon('refresh-cw')),
    h('button', { class: 'icon-btn', title: 'Fermer le panneau (Ctrl+Maj+E)', 'aria-label': 'Fermer le panneau', onclick: () => toggleFiles(false) }, icon('x')));
  const dir = h('div', { class: 'files-dir', title: FP.dir || '' }, FP.dir || 'Aucun dossier de travail');
  const body = FP.loading ? h('div', { class: 'hint pad' }, 'Lecture du dossier…')
    : FP.error ? h('div', { class: 'warn-text pad' }, FP.error)
      : FP.list.length ? h('ul', { class: 'tree' }, treeEl(tree(FP.list), '', changes, 0)) : h('div', { class: 'hint pad' }, 'Dossier vide.');
  box.replaceChildren(head, dir, body, FP.selected ? h('div', { class: 'preview' }) : '');
  if (FP.selected) showPreview(FP.selected);
}
