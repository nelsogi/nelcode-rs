// Nel Code Desktop — palette.js : Les commandes / , leurs suggestions, la palette Ctrl+K et l'aide.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

// --- Commandes / -----------------------------------------------------------------------------------------

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

export const COMMANDS = [
  { name: 'new', desc: 'Nouvelle conversation', run: () => startNew() },
  { name: 'claude-agent', desc: 'Nouvelle conversation Claude Agent (outil claude d\'Anthropic)', run: () => startClaudeAgent() },
  { name: 'compare', desc: 'Conversation comparée entre deux modèles', run: () => openCompare() },
  { name: 'suivi', desc: 'Suivi : tokens, coûts estimés, temps de réponse, export CSV', run: () => openUsage() },
  { name: 'classement', desc: 'Classement du mode comparaison', run: () => openLeaderboard() },
  { name: 'compact', args: '[consigne]', desc: 'Résumer les anciens échanges (les 4 derniers restent tels quels) ; ex. /compact garde surtout les tests', run: (a) => compactNow(a) },
  { name: 'commands', desc: 'Commandes personnalisées (.md) : liste, et création', run: () => showCommands() },
  { name: 'transparence', desc: 'Activer / désactiver le mode transparence', run: () => toggleTransparency() },
  { name: 'agent', desc: 'Activer / désactiver le mode Agent (modèle distant qui gère les outils)', run: () => toggleAgent() },
  { name: 'model', args: '<nom>', desc: 'Charger un modèle installé', run: (a) => a ? loadModel(a) : toast('Usage : /model <nom>', 'warning') },
  { name: 'models', desc: 'Lister les modèles installés', run: () => toast(S.models.length ? S.models.map((m) => h('div', { class: 'line' }, m.name === S.model.name ? icon('check') : h('span', { class: 'pad' }), `${m.name} — ${sizeText(m.bytes)}`)) : 'Aucun modèle.', '', 8000) },
  { name: 'import', args: '[fichier]', desc: 'Importer un .nelmodel ou un .gguf (chemin relatif au dossier de travail)', run: (a) => importFlow(a || null) },
  { name: 'catalogue', desc: 'Télécharger un modèle ouvert (Qwen2.5-Coder…)', run: () => openCatalog() },
  { name: 'temp', args: '<0.1 à 2>', desc: 'Température : bas = sage, haut = créatif', run: (a) => setSetting('temperature', a) },
  { name: 'topk', args: '<n>', desc: 'Tirage parmi les K tokens les plus probables (0 = sans limite)', run: (a) => setSetting('topK', a) },
  { name: 'topp', args: '<0.05 à 1>', desc: 'Tirage parmi les tokens qui font cette part des chances', run: (a) => setSetting('topP', a) },
  { name: 'max', args: '<16 à 128>', desc: 'Longueur maximale d\'une réponse d\'un .nelmodel, en tokens', run: (a) => setSetting('maxReplyTokens', a) },
  { name: 'rename', args: '[titre]', desc: 'Renommer la conversation', run: async (a) => { if (!a) return renameSession(S.current); S.current.title = a; await saveSession(S.current); renderHeader(); } },
  { name: 'export', args: '[md|txt]', desc: 'Exporter la conversation', run: (a) => exportSession(S.current, a !== 'txt') },
  { name: 'dir', desc: 'Changer le dossier de travail de la conversation', run: () => chooseFolder() },
  { name: 'open', desc: 'Ouvrir le dossier de travail dans l\'Explorateur', run: () => openFolder() },
  { name: 'delete', desc: 'Supprimer la conversation', run: () => S.current.messages.length ? deleteSession(S.current) : null },
  { name: 'settings', desc: 'Réglages de génération', run: () => openSettings() },
  { name: 'info', desc: 'Modèle, réglages, dossiers', run: () => showInfo() },
  { name: 'help', desc: 'Liste des commandes', run: () => showHelp() },
];

export async function runCommand(line) {
  const [, name, rest = ''] = line.match(/^\/(\S*)\s*(.*)$/s) ?? [];
  const cmd = COMMANDS.find((c) => c.name === name.toLowerCase());
  if (!cmd) {
    await refreshCustom();
    const custom = usable().find((c) => c.name === name.toLowerCase());
    if (!custom) return toast(`Commande inconnue : /${name} (essaie /help)`, 'warning');
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
const originText = (c) => (c.origin === 'project' ? 'projet' : 'globale');

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
  if (!text.trim()) return toast(`La commande /${c.name} est vide.`, 'warning');
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
    h('dd', {}, `${c.description || 'sans description'} · ${originText(c)}${COMMANDS.some((b) => b.name === c.name) ? ' · ignorée : une commande intégrée porte ce nom' : ''}`)]);
  const body = [rows.length ? h('dl', { class: 'info-grid' }, rows) : h('p', {}, 'Aucune commande personnalisée.'),
    h('div', { class: 'hint' }, 'Un fichier .md par commande, dans .nelcode/commands/ du dossier de travail (projet) ou %APPDATA%\\NelCode\\commands (globales) ; le nom du fichier est le nom de la commande. Une première ligne « description: … » entre deux lignes --- est facultative ; $ARGUMENTS est remplacé par le texte tapé après la commande. Une commande du projet remplace une globale du même nom, jamais une commande intégrée.')];
  if (await dialog('Commandes personnalisées', body, [{ label: 'Fermer', value: null }, { label: 'Nouvelle commande…', value: 'new', primary: true }]) === 'new') await newCommand();
}

async function newCommand() {
  const name = h('input', { class: 'text-input', spellcheck: 'false', placeholder: 'review' });
  const description = h('input', { class: 'text-input', spellcheck: 'false', placeholder: 'Relire le code modifié' });
  const dir = S.current?.workingDirectory;
  const scope = h('select', { class: 'text-input' }, dir ? h('option', { value: 'project' }, 'Ce projet (.nelcode/commands)') : null, h('option', { value: 'global' }, 'Toutes les conversations (%APPDATA%\\NelCode\\commands)'));
  const body = [h('label', { class: 'field' }, h('div', { class: 'row' }, 'Nom (sans /)'), name), h('label', { class: 'field' }, h('div', { class: 'row' }, 'Description'), description), h('label', { class: 'field' }, h('div', { class: 'row' }, 'Où'), scope)];
  if (!(await dialog('Nouvelle commande', body, [{ label: 'Annuler', value: false }, { label: 'Créer', value: true, primary: true }], name))) return;
  try {
    const path = await invoke('create_custom_command', { dir: dir || '', scope: scope.value, name: name.value, description: description.value });
    toast('Commande créée : ' + path + ' (modifie ce fichier pour écrire la commande)', 'success', 10000);
    await refreshCustom();
  } catch (e) { toast(errText(e), 'error', 8000); }
}

export async function setSetting(key, value) {
  const n = Number(String(value).replace(',', '.'));
  if (value === '' || !Number.isFinite(n)) return toast(`Valeur actuelle : ${S.settings[key]}`, '');
  S.settings = await invoke('save_settings', { changes: { [key]: n } });
  toast(`${key} = ${S.settings[key]}`, 'success');
}

export function updateSuggest() {
  const v = $('input').value, box = $('suggest');
  let items = [];
  const m = v.match(/^\/(\S*)(\s+(.*))?$/s);
  if (m && !m[2]) {
    const q = m[1].toLowerCase();
    items = [...COMMANDS.filter((c) => c.name.startsWith(q)).map((c) => ({ label: '/' + c.name + (c.args ? ' ' + c.args : ''), desc: c.desc, fill: '/' + c.name + (c.args ? ' ' : '') })),
      ...customCommands().filter((c) => c.name.startsWith(q)).map((c) => ({ label: '/' + c.name, desc: `${c.description || 'commande personnalisée'} · ${originText(c)}`, fill: '/' + c.name + ' ' }))];
  }
  else if (m && m[1] === 'model') items = S.models.filter((x) => fold(x.name).startsWith(fold(m[3] ?? ''))).map((x) => ({ label: x.name, desc: x.name === S.model.name ? 'chargé' : paramsText(x.parameters), fill: '/model ' + x.name }));
  else {
    const input = $('input'), before = v.slice(0, input.selectionStart ?? v.length);
    const at = before.match(/(^|\s)@([^\s@]*)$/);
    if (at) {
      const q = fold(at[2]), start = before.length - at[2].length - 1;
      const score = (f) => { const base = fold(f.split('/').pop()); return base.startsWith(q) ? 0 : fold(f).startsWith(q) ? 1 : 2; };
      items = workFiles().filter((f) => fold(f).includes(q)).sort((a, b) => score(a) - score(b) || a.length - b.length).slice(0, 30)
        .map((f) => ({ label: '@' + f, desc: 'fichier du dossier de travail', fill: v.slice(0, start) + '@' + f + ' ' + v.slice(before.length).replace(/^\S*\s?/, '') }));
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
  ['Entrée', 'envoyer'], ['Maj+Entrée', 'nouvelle ligne'], ['@', 'joindre un fichier du dossier de travail'], ['/', 'commandes'],
  ['Échap', 'arrêter la réponse, fermer une fenêtre'], ['Ctrl+K', 'palette'], ['Ctrl+N', 'nouvelle conversation'], ['Ctrl+Maj+N', 'conversation comparée'],
  ['Ctrl+,', 'réglages'], ['F2', 'renommer la conversation'], ['Ctrl+I', 'importer un modèle'], ['Ctrl+Maj+E', 'panneau Fichiers'],
  ['Ctrl+= / Ctrl+-', 'taille du texte'], ['Ctrl+0', 'taille du texte normale'], ['?', 'cette aide (hors d\'un champ de saisie, ou saisie vide)'],
];

const keysEl = () => h('dl', { class: 'info-grid shortcuts' }, SHORTCUTS.flatMap(([k, d]) => [h('dt', {}, k.split(' / ').flatMap((x, i) => [i ? ' / ' : '', ...x.split('+').flatMap((p, j) => [j ? '+' : '', h('kbd', {}, p)])])), h('dd', {}, d)]));

export function showHelp() {
  const rows = COMMANDS.flatMap((c) => [h('dt', {}, '/' + c.name + (c.args ? ' ' + c.args : '')), h('dd', {}, c.desc)]);
  dialog('Aide', [h('dl', { class: 'info-grid' }, rows), h('h2', { style: 'margin-top:16px' }, 'Raccourcis'), keysEl()], [{ label: 'Fermer', value: null, primary: true }]);
}

/** « ? » : l'aide des raccourcis. */
export function showShortcuts() {
  dialog('Raccourcis clavier', keysEl(), [{ label: 'Fermer', value: null, primary: true }]);
}

// Palette Ctrl+K : actions, conversations et modèles, filtrés au fil de la frappe.
export async function openPalette() {
  if (UI.closeOverlay) return;
  await refreshCustom();
  if (UI.closeOverlay) return;
  const actions = [
    ['Nouvelle conversation', 'Ctrl+N', startNew], ['Nouvelle conversation Claude Agent', '', startClaudeAgent], ['Conversation comparée…', 'Ctrl+Maj+N', openCompare], ['Classement', '', openLeaderboard], ['Suivi (tokens, coûts, temps de réponse)', '', openUsage],
    ['Mode transparence', '', toggleTransparency], ['Mode Agent', '', toggleAgent], ['Importer un modèle…', 'Ctrl+I', () => importFlow()], ['Catalogue de modèles', '', openCatalog], ['Réglages', 'Ctrl+,', openSettings],
    ['Renommer la conversation', 'F2', () => renameSession(S.current)], ['Exporter en Markdown', '', () => exportSession(S.current, true)],
    ['Exporter en texte', '', () => exportSession(S.current, false)], ['Changer le dossier de travail', '', () => chooseFolder()],
    ['Ouvrir le dossier de travail', '', () => openFolder()], ['Supprimer la conversation', '', () => S.current.messages.length && deleteSession(S.current)],
    ['Infos', '', showInfo], ['Aide', '', showHelp], ['Rechercher des mises à jour', '', () => checkUpdate(true)],
    ['Tester la vitesse', '', () => runBenchmark()], ['Résultats des tests de vitesse', '', () => showBenchmarks()], ['Copier un rapport de bug', '', copyBugReport],
    ['Résumer les anciens échanges', '', () => compactNow()], ['Commandes personnalisées', '', showCommands],
    ['Panneau Fichiers', 'Ctrl+Maj+E', () => toggleFiles()], ['Raccourcis clavier', '?', showShortcuts], ['Assistant de démarrage', '', openWizard],
    ...recentProjects().map((p) => ['Projet : ' + projectName(p), '', () => selectProject(p)]), ['Tous les projets', '', () => selectProject('')],
  ].map(([text, key, run]) => ({ kind: 'Action', text, key, run }));
  const all = [
    ...actions,
    ...usable().map((c) => ({ kind: 'Commande', text: `/${c.name} — ${c.description || 'commande personnalisée'} (${originText(c)})`, key: '', run: () => useCommand(c) })),
    ...S.models.map((m) => ({ kind: 'Modèle', text: m.name, key: m.name === S.model.name ? 'chargé' : '', run: () => loadModel(m.name) })),
    ...[...S.sessions].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).map((s) => ({ kind: 'Conversation', text: titleOf(s), key: relDate(s.date), run: () => openSession(s), search: s.messages.map((m) => m.content).join(' ') })),
  ];
  const input = h('input', { placeholder: 'Chercher une action, une conversation, un modèle…', spellcheck: 'false' });
  const results = h('div', { class: 'results' });
  let shown = [], sel = 0;
  const draw = () => {
    const q = fold(input.value.trim());
    shown = all.filter((it) => !q || fold(it.text).includes(q) || fold(it.kind).includes(q) || (it.search && fold(it.search).includes(q))).slice(0, 60);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    results.replaceChildren(...(shown.length ? shown.map((it, i) => h('div', { class: 'item' + (i === sel ? ' sel' : ''), onmousemove: () => { if (sel !== i) { sel = i; draw(); } }, onclick: () => pick(i) },
      h('span', { class: 'kind' }, it.kind), h('span', { class: 'text' }, it.text), it.key ? h('kbd', {}, it.key) : null)) : [h('div', { class: 'empty-res' }, 'Rien trouvé.')]));
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
