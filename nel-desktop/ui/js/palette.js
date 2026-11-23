// Nel Code Desktop — palette.js : Les commandes / , leurs suggestions, la palette Ctrl+K et l'aide.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

// --- Commandes / -----------------------------------------------------------------------------------------

import { t } from './i18n.js';
import { $, dialog, errText, fold, h, invoke, paramsText, relDate, sizeText, toast } from './util.js';
import { S, UI } from './state.js';
import { chooseFolder, deleteSession, expandMentions, exportSession, importFlow, loadModel, openCompare, openFolder, openLeaderboard, openSession, renameSession, renderHeader, saveSession, send, startNew, titleOf, toggleTransparency, workFiles } from './conversation.js';
import { compactNow } from './summary.js';
import { startClaudeAgent, toggleAgent } from './agent.js';
import { checkUpdate, copyBugReport, openSettings, runBenchmark, showBenchmarks, showInfo } from './settings.js';
import { openCatalog } from './catalog.js';
import { projectName, recentProjects, selectProject } from './projects.js';
import { toggleFiles } from './files.js';
import { openWizard } from './onboarding.js';
import { openUsage } from './usage.js';
import { CATEGORIES, paletteItems } from './settings-page.js';

// Les commandes / : leur description et leurs arguments sont dans i18n/*.json (cmd.<nom>.desc, cmd.<nom>.args).
export const COMMANDS = [
  { name: 'new', run: () => startNew() },
  { name: 'claude-agent', run: () => startClaudeAgent() },
  { name: 'compare', run: () => openCompare() },
  { name: 'suivi', run: () => openUsage() },
  { name: 'classement', run: () => openLeaderboard() },
  { name: 'compact', args: true, run: (a) => compactNow(a) },
  { name: 'commands', run: () => showCommands() },
  { name: 'transparence', run: () => toggleTransparency() },
  { name: 'mcp', run: () => openSettings('mcp') },
  { name: 'agent', run: () => toggleAgent() },
  { name: 'model', args: true, run: (a) => a ? loadModel(a) : toast(t('palette.usage_model_nom'), 'warning') },
  { name: 'models', run: () => toast(S.models.length ? S.models.map((m) => h('div', { class: 'line' }, m.name === S.model.name ? icon('check') : h('span', { class: 'pad' }), `${m.name} — ${sizeText(m.bytes)}`)) : t('palette.aucun_modele'), '', 8000) },
  { name: 'import', args: true, run: (a) => importFlow(a || null) },
  { name: 'catalogue', run: () => openCatalog() },
  { name: 'temp', args: true, run: (a) => setSetting('temperature', a) },
  { name: 'topk', args: true, run: (a) => setSetting('topK', a) },
  { name: 'topp', args: true, run: (a) => setSetting('topP', a) },
  { name: 'max', args: true, run: (a) => setSetting('maxReplyTokens', a) },
  { name: 'rename', args: true, run: async (a) => { if (!a) return renameSession(S.current); S.current.title = a; await saveSession(S.current); renderHeader(); } },
  { name: 'export', args: true, run: (a) => exportSession(S.current, a !== 'txt') },
  { name: 'dir', run: () => chooseFolder() },
  { name: 'open', run: () => openFolder() },
  { name: 'delete', run: () => S.current.messages.length ? deleteSession(S.current) : null },
  { name: 'settings', args: true, run: (a) => openSettings(a || undefined) },
  { name: 'info', run: () => showInfo() },
  { name: 'help', run: () => showHelp() },
];

/** La description d'une commande /, et ses arguments (« [catégorie] », « <nom> »…), dans la langue affichée. */
export const cmdDesc = (c) => t(`cmd.${c.name}.desc`, { fileManager: S.info.fileManager, categories: CATEGORIES.map((x) => x.alias[0]).join(', ') });
export const cmdArgs = (c) => (c.args ? t(`cmd.${c.name}.args`) : '');


export async function runCommand(line) {
  const [, name, rest = ''] = line.match(/^\/(\S*)\s*(.*)$/s) ?? [];
  const cmd = COMMANDS.find((c) => c.name === name.toLowerCase());
  if (!cmd) {
    await refreshCustom();
    const custom = usable().find((c) => c.name === name.toLowerCase());
    if (!custom) return toast(t('palette.commande_inconnue_essaie_help', { name: name }), 'warning');
    return sendCustom(custom, rest.trim());
  }
  try { await cmd.run(rest.trim().replace(/^"(.*)"$/, '$1')); } catch (e) { toast(errText(e), 'error'); }
}

// --- Commandes personnalisées ----------------------------------------------------------------------------
// Les .md de .nelcode/commands/ (projet) et de %APPDATA%\NelCode\commands (globales) : un texte envoyé au modèle comme
// un message ordinaire (mode Agent compris : il valide tout comme d'habitude). Jamais à la place d'une commande intégrée.

export const CUSTOM = { dir: null, list: [], at: 0, loading: null };

export async function refreshCustom() {
  const dir = S.current?.workingDirectory || '';
  try { CUSTOM.list = await invoke('custom_commands', { dir }); } catch { CUSTOM.list = []; }
  Object.assign(CUSTOM, { dir, at: Date.now() });
}

const usable = () => CUSTOM.list.filter((c) => !COMMANDS.some((b) => b.name === c.name));
const originText = (c) => (c.origin === 'project' ? t('palette.origin.project') : t('palette.origin.global'));

// Les commandes utilisables ; la liste est relue si elle a plus de 10 s ou si le dossier de travail a changé.
export function customCommands() {
  const dir = S.current?.workingDirectory || '';
  if ((CUSTOM.dir !== dir || Date.now() - CUSTOM.at > 10_000) && !CUSTOM.loading) CUSTOM.loading = refreshCustom().finally(() => { CUSTOM.loading = null; updateSuggest(); });
  return CUSTOM.dir === dir ? usable() : [];
}

// $ARGUMENTS devient le texte tapé après la commande (sans $ARGUMENTS dans le fichier, il est ajouté à la fin).
export function fillCommand(body, args) {
  return body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', () => args) : args ? body + '\n\n' + args : body;
}

async function sendCustom(c, args) {
  const given = await expandMentions(args);   // les @fichiers tapés après la commande, pas ceux du fichier de la commande
  if (given === null) return;
  const text = fillCommand(c.body, given);
  if (!text.trim()) return toast(t('palette.commande_est_vide', { name: c.name }), 'warning');
  if (!(await send(text))) $('input').value ||= `/${c.name} ${args}`.trim();
}

function useCommand(c) {
  const input = $('input');
  input.value = `/${c.name} `;
  input.focus();
  updateSuggest();
}

export async function showCommands() {
  await refreshCustom();
  const rows = CUSTOM.list.flatMap((c) => [h('dt', {}, '/' + c.name),
    h('dd', {}, `${c.description || t('palette.sans_description')} · ${originText(c)}${COMMANDS.some((b) => b.name === c.name) ? t('palette.ignoree_commande_integree_porte_ce') : ''}`)]);
  const body = [rows.length ? h('dl', { class: 'info-grid' }, rows) : h('p', {}, t('palette.aucune_commande_personnalisee')),
    h('div', { class: 'hint' }, t('palette.fichier_md_par_commande_dans'))];
  if (await dialog(t('palette.commandes_personnalisees'), body, [{ label: t('palette.fermer'), value: null }, { label: t('palette.nouvelle_commande'), value: 'new', primary: true }]) === 'new') await newCommand();
}

// Le corps d'une nouvelle commande, sous son front matter (écrit tel quel par la partie Rust).
const COMMAND_TEMPLATE = 'palette.decris_ici_ce_que_modele';

async function newCommand() {
  const name = h('input', { class: 'text-input', spellcheck: 'false', placeholder: t('palette.review') });
  const description = h('input', { class: 'text-input', spellcheck: 'false', placeholder: t('palette.relire_code_modifie') });
  const dir = S.current?.workingDirectory;
  const scope = h('select', { class: 'text-input' }, dir ? h('option', { value: 'project' }, t('palette.ce_projet_nelcode_commands')) : null, h('option', { value: 'global' }, t('palette.toutes_conversations_appdata_nelcode_commands')));
  const body = [h('label', { class: 'field' }, h('div', { class: 'row' }, t('palette.nom_sans')), name), h('label', { class: 'field' }, h('div', { class: 'row' }, t('palette.description')), description), h('label', { class: 'field' }, h('div', { class: 'row' }, t('palette.texte_2')), scope)];
  if (!(await dialog(t('palette.nouvelle_commande_2'), body, [{ label: t('palette.annuler'), value: false }, { label: t('palette.creer'), value: true, primary: true }], name))) return;
  try {
    const path = await invoke('create_custom_command', { dir: dir || '', scope: scope.value, name: name.value, description: description.value, body: t(COMMAND_TEMPLATE) });
    toast(t('palette.command_created', { path }), 'success', 10000);
    await refreshCustom();
  } catch (e) { toast(errText(e), 'error', 8000); }
}

export async function setSetting(key, value) {
  const n = Number(String(value).replace(',', '.'));
  if (value === '' || !Number.isFinite(n)) return toast(t('palette.valeur_actuelle', { v0: S.settings[key] }), '');
  S.settings = await invoke('save_settings', { changes: { [key]: n } });
  toast(`${key} = ${S.settings[key]}`, 'success');
}

export function updateSuggest() {
  const v = $('input').value, box = $('suggest');
  let items = [];
  const m = v.match(/^\/(\S*)(\s+(.*))?$/s);
  if (m && !m[2]) {
    const q = m[1].toLowerCase();
    items = [...COMMANDS.filter((c) => c.name.startsWith(q)).map((c) => ({ label: '/' + c.name + (c.args ? ' ' + cmdArgs(c) : ''), desc: cmdDesc(c), fill: '/' + c.name + (c.args ? ' ' : '') })),
      ...customCommands().filter((c) => c.name.startsWith(q)).map((c) => ({ label: '/' + c.name, desc: `${c.description || t('palette.commande_personnalisee')} · ${originText(c)}`, fill: '/' + c.name + ' ' }))];
  }
  else if (m && m[1] === 'model') items = S.models.filter((x) => fold(x.name).startsWith(fold(m[3] ?? ''))).map((x) => ({ label: x.name, desc: x.name === S.model.name ? t('palette.charge') : paramsText(x.parameters), fill: '/model ' + x.name }));
  else {
    const input = $('input'), before = v.slice(0, input.selectionStart ?? v.length);
    const at = before.match(/(^|\s)@([^\s@]*)$/);
    if (at) {
      const q = fold(at[2]), start = before.length - at[2].length - 1;
      const score = (f) => { const base = fold(f.split('/').pop()); return base.startsWith(q) ? 0 : fold(f).startsWith(q) ? 1 : 2; };
      items = workFiles().filter((f) => fold(f).includes(q)).sort((a, b) => score(a) - score(b) || a.length - b.length).slice(0, 30)
        .map((f) => ({ label: '@' + f, desc: t('palette.fichier_dossier_travail'), fill: v.slice(0, start) + '@' + f + ' ' + v.slice(before.length).replace(/^\S*\s?/, '') }));
    }
  }
  UI.sugg = { items, sel: Math.min(UI.sugg.sel, Math.max(0, items.length - 1)) };
  box.hidden = !items.length;
  box.replaceChildren(...items.map((it, i) => h('div', { class: 'item' + (i === UI.sugg.sel ? ' sel' : ''), onmousedown: (e) => { e.preventDefault(); pickSuggest(i); } },
    h('span', { class: 'cmd' }, it.label), h('span', { class: 'desc' }, it.desc))));
  box.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

export function pickSuggest(i) {
  const input = $('input');
  input.value = UI.sugg.items[i].fill;
  input.focus();
  updateSuggest();
}

/** Les raccourcis clavier (aide « ? » et /help). */
export const SHORTCUTS = [
  ['Enter', 'send'], ['Shift+Enter', 'newline'], ['@', 'mention'], ['/', 'commands'],
  ['Esc', 'escape'], ['Ctrl+K', 'palette'], ['Ctrl+N', 'new'], ['Ctrl+Shift+N', 'compare'],
  ['Ctrl+,', 'settings'], ['F2', 'rename'], ['Ctrl+I', 'import'], ['Ctrl+Shift+E', 'files'],
  ['Ctrl+= / Ctrl+-', 'zoom'], ['Ctrl+0', 'zoom100'], ['?', 'help'],
];

/** Un raccourci dans la langue affichée : Maj / Shift, Entrée / Enter, Échap / Esc (keys.*). */
export const keyName = (combo) => combo.replace(/\b(Shift|Enter|Esc)\b/g, (k) => t('keys.' + k.toLowerCase()));

const keysEl = () => h('dl', { class: 'info-grid shortcuts' }, SHORTCUTS.flatMap(([k, d]) => [h('dt', {}, keyName(k).split(' / ').flatMap((x, i) => [i ? ' / ' : '', ...x.split('+').flatMap((p, j) => [j ? '+' : '', h('kbd', {}, p)])])), h('dd', {}, t('shortcut.' + d))]));

export function showHelp() {
  const rows = COMMANDS.flatMap((c) => [h('dt', {}, '/' + c.name + (c.args ? ' ' + cmdArgs(c) : '')), h('dd', {}, cmdDesc(c))]);
  dialog(t('palette.aide'), [h('dl', { class: 'info-grid' }, rows), h('h2', { style: 'margin-top:16px' }, t('palette.raccourcis')), keysEl()], [{ label: t('palette.fermer'), value: null, primary: true }]);
}

/** « ? » : l'aide des raccourcis. */
export function showShortcuts() {
  dialog(t('palette.raccourcis_clavier'), keysEl(), [{ label: t('palette.fermer'), value: null, primary: true }]);
}

// Palette Ctrl+K : actions, conversations et modèles, filtrés au fil de la frappe.
export async function openPalette() {
  if (UI.closeOverlay) return;
  await refreshCustom();
  if (UI.closeOverlay) return;
  const actions = [
    ['new', 'Ctrl+N', startNew], ['claude', '', startClaudeAgent], ['compare', 'Ctrl+Shift+N', openCompare], ['leaderboard', '', openLeaderboard], ['usage', '', openUsage],
    ['transparency', '', toggleTransparency], ['agent', '', toggleAgent], ['import', 'Ctrl+I', () => importFlow()], ['catalog', '', openCatalog], ['settings', 'Ctrl+,', () => openSettings()],
    ['rename', 'F2', () => renameSession(S.current)], ['exportMd', '', () => exportSession(S.current, true)],
    ['exportTxt', '', () => exportSession(S.current, false)], ['dir', '', () => chooseFolder()],
    ['openDir', '', () => openFolder()], ['delete', '', () => S.current.messages.length && deleteSession(S.current)],
    ['info', '', showInfo], ['help', '', showHelp], ['updates', '', () => checkUpdate(true)],
    ['bench', '', () => runBenchmark()], ['benchResults', '', () => showBenchmarks()], ['bugReport', '', copyBugReport],
    ['compact', '', () => compactNow()], ['customCommands', '', showCommands],
    ['files', 'Ctrl+Shift+E', () => toggleFiles()], ['shortcuts', '?', showShortcuts], ['wizard', '', openWizard],
  ].map(([id, key, run]) => [t('action.' + id), keyName(key), run]).concat(
    recentProjects().map((p) => [t('palette.projet', { value: projectName(p) }), '', () => selectProject(p)]), [[t('palette.tous_projets'), '', () => selectProject('')]],
  ).map(([text, key, run]) => ({ kind: t('palette.kind.action'), text, key, run }));
  const all = [
    ...actions,
    ...usable().map((c) => ({ kind: t('palette.kind.command'), text: `/${c.name} — ${c.description || t('palette.commande_personnalisee')} (${originText(c)})`, key: '', run: () => useCommand(c) })),
    ...S.models.map((m) => ({ kind: t('palette.kind.model'), text: m.name, key: m.name === S.model.name ? t('palette.charge') : '', run: () => loadModel(m.name) })),
    ...[...S.sessions].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).map((s) => ({ kind: t('palette.kind.conversation'), text: titleOf(s), key: relDate(s.date), run: () => openSession(s), search: s.messages.map((m) => m.content).join(' ') })),
    // En dernier : sans recherche, la palette montre d'abord les actions, les modèles et les conversations.
    ...paletteItems(),
  ];
  const input = h('input', { placeholder: t('palette.chercher_action_conversation_modele'), spellcheck: 'false' });
  const results = h('div', { class: 'results' });
  let shown = [], sel = 0;
  const draw = () => {
    const q = fold(input.value.trim());
    shown = all.filter((it) => !q || fold(it.text).includes(q) || fold(it.kind).includes(q) || (it.search && fold(it.search).includes(q))).slice(0, 60);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    results.replaceChildren(...(shown.length ? shown.map((it, i) => h('div', { class: 'item' + (i === sel ? ' sel' : ''), onmousemove: () => { if (sel !== i) { sel = i; draw(); } }, onclick: () => pick(i) },
      h('span', { class: 'kind' }, it.kind), h('span', { class: 'text' }, it.text), it.key ? h('kbd', {}, it.key) : null)) : [h('div', { class: 'empty-res' }, t('palette.rien_trouve'))]));
    results.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const ov = $('overlay');
  const close = () => { ov.hidden = true; ov.replaceChildren(); UI.closeOverlay = null; };
  const pick = (i) => { const it = shown[i]; close(); if (it) it.run(); else $('input').focus(); };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, shown.length); draw(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + shown.length) % Math.max(1, shown.length); draw(); }
    if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
  });
  ov.replaceChildren(h('div', { class: 'dialog palette' }, input, results));
  ov.hidden = false;
  ov.onmousedown = (e) => { if (e.target === ov) { close(); $('input').focus(); } };
  UI.closeOverlay = () => { close(); $('input').focus(); };
  draw();
  input.focus();
}
