// Nel Code Desktop — projects.js : les projets (un projet = un dossier de travail) : sélecteur des projets récents,
// conversations rangées par projet.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

import { t } from './i18n.js';
import { $, h, invoke, showMenu, toast } from './util.js';
import { S } from './state.js';
import { newSession, renderAll } from './conversation.js';

/** Un chemin comparable (casse, séparateurs, « \ » final). */
export function normPath(p) {
  return (p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export function sameProject(a, b) {
  return normPath(a) === normPath(b);
}

/** Le nom d'un projet : le dernier dossier de son chemin. */
export function projectName(p) {
  return p ? p.split(/[\\/]/).filter(Boolean).pop() || p : t('projects.sans_dossier');
}

/** Le projet affiché ('' : tous les projets). */
export function currentProject() {
  return S.settings.currentProject || '';
}

/** Les projets récents ; au premier lancement, ceux des conversations (les plus récentes d'abord). */
export function recentProjects() {
  const list = [...(S.settings.recentProjects ?? [])];
  for (const s of [...S.sessions].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))) {
    if (s.workingDirectory && !list.some((p) => sameProject(p, s.workingDirectory))) list.push(s.workingDirectory);
  }
  return list.slice(0, 12);
}

/** Met `path` en tête des projets récents. */
export async function rememberProject(path) {
  if (!path) return;
  const list = [path, ...(S.settings.recentProjects ?? []).filter((p) => !sameProject(p, path))].slice(0, 12);
  try { S.settings = await invoke('save_settings', { changes: { recentProjects: list } }); } catch { /* sans gravité */ }
}

/** Affiche le projet `path` ('' : tous) : ses conversations seulement, et une conversation de ce projet. */
export async function selectProject(path) {
  if (S.gen) return toast(t('projects.attends_fin_reponse_stop'), 'warning');
  S.settings = await invoke('save_settings', { changes: { currentProject: path } });
  if (path) await rememberProject(path);
  if (path && !sameProject(S.current.workingDirectory, path)) S.current = newSession();
  renderAll();
  $('input').focus();
}

/** Le bouton du projet, en haut de la barre latérale. */
export function renderProject() {
  const p = currentProject();
  const b = $('project-btn');
  b.replaceChildren(icon('folder'), h('span', { class: 'label' }, p ? projectName(p) : t('projects.tous_projets')), icon('chevron-down'));
  b.title = p ? t('projects.projet_clic_changer_projet', { p: p }) : t('projects.toutes_conversations_rangees_par_projet');
}

/** Le menu des projets : récents, tous, ouvrir un dossier. */
export function projectMenu(e) {
  const cur = currentProject();
  const recent = recentProjects().map((p) => ({
    label: [sameProject(p, cur) ? icon('check') : h('span', { class: 'pad' }), h('span', { class: 'name' }, projectName(p)), h('span', { class: 'path' }, p)],
    run: () => selectProject(p),
  }));
  showMenu(e, [
    ...recent,
    ...(recent.length ? ['-'] : []),
    { label: [cur ? h('span', { class: 'pad' }) : icon('check'), t('projects.tous_projets')], run: () => selectProject('') },
    { label: [icon('plus'), t('projects.ouvrir_dossier')], run: async () => {
      const path = await invoke('pick_folder', { start: cur || S.current?.workingDirectory || S.info.home || '' });
      if (path) selectProject(path);
    } },
  ]);
  $('menu').classList.add('projects-menu');
}

/** Les conversations à afficher, et les projets à séparer par un titre (seulement s'il y en a plusieurs). */
export function sessionsByProject(list) {
  const cur = currentProject();
  const shown = cur ? list.filter((s) => sameProject(s.workingDirectory, cur)) : list;
  const groups = new Map();
  for (const s of shown) {
    const k = normPath(s.workingDirectory);
    if (!groups.has(k)) groups.set(k, { path: s.workingDirectory, sessions: [] });
    groups.get(k).sessions.push(s);
  }
  return { shown, groups: [...groups.values()], grouped: !cur && groups.size > 1 };
}
