// Nel Code Desktop — agent.js : Le mode Agent et Claude Agent : étapes, plan, NELCODE.md.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

// --- Mode Agent -----------------------------------------------------------------------------------------

import { $, dialog, errText, h, invoke, toast } from './util.js';
import { S, UI } from './state.js';
import { closeEdit, newSession, renderAll, renderHeader, renderMessages, saveSession } from './conversation.js';
import { drawMarkdown, inlineMarkdown } from './markdown.js';
import { openSettings } from './settings.js';
import { refreshFiles } from './files.js';

// Le NELCODE.md modèle créé par le bouton de l'en-tête (écrit tel quel par la partie Rust).
const NELCODE_TEMPLATE = `# Instructions pour l'agent de Nel Code

Ce fichier est ajouté au message système de chaque demande en mode Agent (ses 20 000 premiers octets).
Écris ici ce que l'agent doit savoir sur ce projet.

## Le projet

- Langage et version : (par exemple C# 12, .NET 8)
- Ce que fait le programme :
- Dossiers importants : (par exemple \`src/\` pour le code, \`tests/\` pour les tests)

## Règles

- Style : (conventions de nommage, indentation…)
- Toujours lancer les tests après une modification : (par exemple \`dotnet test\`)
- Ne jamais modifier : (fichiers ou dossiers à laisser tels quels)

## Commandes utiles

- Compiler : \`dotnet build\`
- Tester : \`dotnet test\`
`;

export const AGENT_LOCAL = 'Le mode Agent demande un modèle distant qui gère les outils (llama.cpp lancé avec --jinja, Ollama avec Qwen3…) : les .nelmodel et les modèles GGUF de ce PC n\'y ont pas accès.';

// --- Claude Agent ---------------------------------------------------------------------------------------
// Une conversation menée par l'outil « claude » d'Anthropic installé sur le PC, avec une clé API.

export const money = (usd) => `${Number(usd ?? 0).toLocaleString('fr-CH', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} $`;

export const claudeCost = (c) => [c.cost !== null && c.cost !== undefined && money(c.cost), c.durationMs && `${(c.durationMs / 1000).toLocaleString('fr-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`,
  c.turns && `${c.turns} tour${c.turns > 1 ? 's' : ''}`].filter(Boolean).join(' · ');

export async function startClaudeAgent() {
  if (S.gen) return toast('Attends la fin de la réponse (ou Stop).', 'warning');
  const st = S.claudeStatus = await invoke('claude_agent_status');
  if (!st.cli) {
    return dialog('Claude Agent', [h('p', {}, 'Claude Agent utilise l\'outil en ligne de commande « claude » d\'Anthropic, introuvable sur ce PC (ni dans le PATH, ni dans %USERPROFILE%\\.local\\bin).'),
      h('p', {}, 'Installe-le, puis relance Nel Code :'), h('div', { class: 'url' }, st.installUrl)],
    [{ label: 'Fermer', value: null }, { label: 'Ouvrir la page d\'installation', value: 'open', primary: true }]).then((v) => v && invoke('open_claude_install'));
  }
  if (!st.hasKey) {
    toast('Claude Agent : ajoute d\'abord ta clé API Anthropic (Réglages → Claude Agent).', 'warning', 8000);
    return openSettings('claude');
  }
  closeEdit();
  S.current = { ...newSession(), claudeAgent: {} };
  S.lastSpeed = '';
  renderAll();
  $('input').focus();
}

// Réglages → Claude Agent : l'outil trouvé et la clé API (rangée tout de suite). Le modèle, le mode de permission, les
// outils autorisés et les réglages du projet sont des réglages ordinaires (settings.js).
export async function claudeKeyBlock() {
  const st = S.claudeStatus = await invoke('claude_agent_status');
  const key = h('input', { class: 'text-input key', type: 'password', autocomplete: 'off', 'aria-label': 'Clé API Anthropic', placeholder: st.hasKey ? 'clé enregistrée (vide : inchangée)' : 'sk-ant-…' });
  const btns = h('div', { class: 'row-btns' });
  const drawBtns = () => btns.replaceChildren(key, h('button', { class: 'btn', onclick: () => saveKey(key.value) }, 'Ranger la clé'),
    S.claudeStatus.hasKey ? h('button', { class: 'btn', onclick: () => saveKey('') }, 'Retirer la clé') : null);
  const saveKey = async (value) => {
    try {
      await invoke('claude_agent_save_key', { key: value });
      key.value = '';
      S.claudeStatus = await invoke('claude_agent_status');
      key.placeholder = S.claudeStatus.hasKey ? 'clé enregistrée (vide : inchangée)' : 'sk-ant-…';
      drawBtns();
      toast(value ? `Clé API enregistrée dans le ${S.info.keystore}.` : 'Clé API retirée.', 'success', 3000);
    } catch (e) { toast(errText(e), 'error'); }
  };
  key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveKey(key.value); } });
  drawBtns();
  return h('div', { class: 'claude-field' },
    h('div', { class: 'hint cli' }, st.cli ? `Outil « claude » : ${st.cli}` : [`Outil « claude » d'Anthropic introuvable : `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); invoke('open_claude_install'); } }, 'l\'installer')]),
    btns,
    h('div', { class: 'hint' }, `Clé API Anthropic (Console Anthropic), rangée dans le ${S.info.keystore} et passée à l'outil comme ANTHROPIC_API_KEY. Pas de connexion à un compte Claude.ai.`));
}

export async function refreshNelcode() {
  const chip = $('nelcode-chip'), s = S.current, ask = ++UI.nelcodeAsk;
  if (!s?.agent || !s.workingDirectory) { chip.hidden = true; return; }
  let info;
  try { info = await invoke('nelcode_md_info', { dir: s.workingDirectory }); } catch { chip.hidden = true; return; }
  if (ask !== UI.nelcodeAsk) return;   // une réponse plus récente est déjà là
  chip.hidden = false;
  chip.classList.toggle('on', info.exists);
  chip.dataset.exists = info.exists ? '1' : '';
  chip.replaceChildren(icon(info.exists ? 'file-text' : 'plus'), h('span', {}, 'NELCODE.md'));
  chip.title = info.exists
    ? `NELCODE.md pris en compte : ajouté au message système de chaque demande (${info.bytes.toLocaleString('fr-CH')} octets${info.truncated ? `, coupé aux ${info.max.toLocaleString('fr-CH')} premiers` : ''}).`
    : 'Créer un NELCODE.md modèle à la racine du dossier de travail : ses instructions seront ajoutées à chaque demande Agent.';
}

export async function nelcodeChip() {
  const s = S.current;
  if ($('nelcode-chip').dataset.exists) return toast($('nelcode-chip').title, '', 6000);
  try {
    await invoke('create_nelcode_md', { dir: s.workingDirectory, text: NELCODE_TEMPLATE });
    toast('NELCODE.md créé : complète-le, il sera ajouté à chaque demande Agent.', 'success', 6000);
  } catch (e) { toast(errText(e), 'error'); }
  refreshNelcode();
}

export function toggleAgent() {
  const s = S.current;
  if (s.claudeAgent) return toast('Une conversation Claude Agent a déjà ses propres outils.', 'warning');
  if (!s.agent && !S.model.remote) return toast(AGENT_LOCAL, 'warning', 8000);
  if (s.compare) return toast('Le mode Agent ne marche pas en conversation comparée.', 'warning');
  s.agent = !s.agent;
  if (!s.agent) delete s.agent;
  if (s.messages.length) saveSession(s);
  renderHeader();
  toast(s.agent ? `Mode Agent : ${S.model.name} peut lire les fichiers de « ${s.workingDirectory || '(aucun dossier)'} », et les modifier avec ton accord.` : 'Mode Agent désactivé.', '', 4000);
}

export const STEP_ICONS = { list: 'folder', read: 'eye', search: 'search', write: 'file-plus', edit: 'pencil', note: 'asterisk', error: 'circle-alert', command: 'terminal', plan: 'list-checks', explorer: 'bot', mcp: 'plug' };

export const STEP_STATUS = { pending: 'à valider', accepted: 'acceptée', rejected: 'refusée', undone: 'annulée', error: 'erreur', running: 'en cours', stopped: 'arrêtée', waiting: 'en attente' };

export function diffEl(lines) {
  return h('div', { class: 'diff' }, lines.map(([c, l]) => h('div', { class: { '+': 'add', '-': 'del', '…': 'skip' }[c] ?? 'ctx' }, h('span', { class: 'sign' }, c === '…' ? '' : c), l)));
}

// Le texte écrit par un modèle (message intermédiaire, rapport d'un sous-agent, résumé d'un explorateur) : en Markdown ;
// la sortie d'un outil reste telle quelle.
const isProse = (st) => st.status !== 'error' && st.status !== 'rejected' && (st.kind === 'explorer' || (st.kind === 'note' && (!st.tool || st.tool === 'Task' || st.tool === 'Agent')));

function detailEl(st) {
  if (!isProse(st) || S.settings.markdown === false) return h('pre', { class: 'detail' }, st.detail);
  const el = h('div', { class: 'detail' });
  drawMarkdown(el, st.detail);
  return el;
}

// Les étapes de l'agent. `m` : le message fini (Annuler y met à jour les étapes) ; null pendant la réponse.
// Une étape d'un sous-agent (Claude Agent) ou d'un explorateur (mode Agent) a `parent` (l'étape « Sous-agent : … » ou
// « Explorateur : … ») et s'affiche dans son corps.
export function stepsEl(steps, m) {
  const box = h('div', { class: 'steps' });
  const subs = new Map();   // id d'une étape → le conteneur de ses étapes de sous-agent
  const count = {};
  for (const st of steps) if (st.parent) count[st.parent] = (count[st.parent] ?? 0) + 1;
  for (const st of steps) {
    const write = st.kind === 'write' || st.kind === 'edit';
    const status = STEP_STATUS[st.status] ? h('span', { class: 'status ' + st.status }, STEP_STATUS[st.status]) : null;
    const body = h('div', { class: 'step-body' });
    const n = count[st.id];
    if (n) { subs.set(st.id, h('div', { class: 'substeps' })); body.append(subs.get(st.id)); }
    // La raison d'un refus ou d'une erreur (Claude Agent) accompagne le diff.
    if (st.detail && (!st.diff || st.protected || st.status === 'rejected' || st.status === 'error')) body.append(detailEl(st));
    if (st.diff) body.append(diffEl(st.diff));
    if (st.error) body.append(h('div', { class: 'warn-text' }, st.error));
    // Les boutons de la décision sont grisés dès le premier clic (un double clic décidait deux fois), rendus si erreur.
    const decide = (decision, e) => {
      const btns = [...(e?.currentTarget?.closest('.row-btns')?.querySelectorAll('button') ?? [])];
      if (btns.some((b) => b.disabled)) return;
      for (const b of btns) b.disabled = true;
      invoke('agent_decide', { request: st.request, step: st.id, decision }).catch((err) => {
        for (const b of btns) b.disabled = false;
        toast(errText(err), 'error');
      });
    };
    // Un fichier protégé : une confirmation à chaque fois (jamais « Accepter tout »).
    if (st.status === 'pending' && !m && st.protected) body.append(h('div', { class: 'row-btns' },
      h('button', { class: 'btn danger', onclick: (e) => decide('accept', e) }, st.kind === 'search' ? 'Parcourir aussi ces fichiers' : write ? 'Autoriser l\'écriture' : 'Autoriser la lecture'),
      h('button', { class: 'btn primary', onclick: (e) => decide('reject', e) }, 'Refuser')));
    // Une commande : Lancer ou Refuser, à chaque fois (jamais « Accepter tout »).
    if (st.status === 'pending' && !m && st.kind === 'command') body.append(h('div', { class: 'row-btns' },
      h('button', { class: 'btn primary', onclick: (e) => decide('accept', e) }, icon('terminal'), 'Lancer'),
      h('button', { class: 'btn', onclick: (e) => decide('reject', e) }, 'Refuser')));
    // Un outil MCP : Autoriser, Toujours autoriser cet outil (gardé), ou Refuser.
    if (st.status === 'pending' && !m && st.kind === 'mcp') body.append(h('div', { class: 'row-btns' },
      h('button', { class: 'btn primary', onclick: (e) => decide('accept', e) }, icon('check'), 'Autoriser'),
      h('button', { class: 'btn', title: 'Ne plus demander pour cet outil de ce serveur (tant que sa configuration ne change pas)', onclick: (e) => decide('always', e) }, 'Toujours autoriser cet outil'),
      h('button', { class: 'btn', onclick: (e) => decide('reject', e) }, 'Refuser')));
    if (st.status === 'pending' && !m && !st.protected && st.kind !== 'command' && st.kind !== 'mcp') body.append(h('div', { class: 'row-btns' },
      h('button', { class: 'btn primary', onclick: (e) => decide('accept', e) }, icon('check'), 'Accepter'),
      h('button', { class: 'btn', onclick: (e) => decide('reject', e) }, 'Refuser'),
      h('button', { class: 'btn', title: 'Accepter cette écriture et les suivantes de cette demande, sans redemander', onclick: (e) => decide('accept_all', e) }, 'Accepter tout pour cette demande')));
    if (write && st.status === 'accepted' && m) body.append(h('div', { class: 'row-btns' },
      h('button', { class: 'btn', onclick: () => undoSteps(m, [st.id], () => invoke('agent_undo', { request: st.request, step: st.id }).then(() => [st.id])) }, icon('undo-2'), 'Annuler')));
    (subs.get(st.parent) ?? box).append(h('details', { class: 'step ' + st.kind, 'data-step': st.id, 'data-status': st.status, open: (st.status === 'pending' || st.status === 'running') && !m },
      h('summary', {}, icon(STEP_ICONS[st.kind] ?? 'asterisk'), h('span', { class: 'title' }, st.kind === 'note' && !st.tool ? inlineMarkdown(st.title) : st.title),
        n ? h('span', { class: 'count' }, `${n} étape${n > 1 ? 's' : ''}`) : null, st.kind === 'explorer' ? explorerMeta(st) : null, status), body));
  }
  const undoable = m && steps.filter((st) => (st.kind === 'write' || st.kind === 'edit') && st.status === 'accepted');
  if (undoable?.length) box.append(h('div', { class: 'row-btns undo-all' },
    h('button', { class: 'btn', onclick: () => undoSteps(m, undoable.map((st) => st.id), () => invoke('agent_undo_all', { request: m.agent.request })) }, icon('undo-2'), 'Annuler toute la demande')));
  return box;
}

// Un explorateur : sa durée et ses tokens (entrée + sortie), mis à jour à chaque tour.
function explorerMeta(st) {
  const tokens = (st.tokens?.input ?? 0) + (st.tokens?.output ?? 0);
  const text = [st.seconds !== undefined && `${st.seconds.toLocaleString('fr-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`,
    tokens && `${tokens.toLocaleString('fr-CH')} tokens`].filter(Boolean).join(' · ');
  return text ? h('span', { class: 'meta', title: st.model ? `Modèle : ${st.model}` : '' }, text) : null;
}

// Annule des écritures (le Rust refuse si un fichier a changé depuis), puis les marque « annulée » dans la conversation.
export async function undoSteps(m, ids, run) {
  if (S.gen) return toast('Attends la fin de la réponse (ou Stop).', 'warning');
  try {
    const done = await run();
    for (const st of m.agent.steps) if (done.includes(st.id)) st.status = 'undone';
    toast(done.length > 1 ? `${done.length} modifications annulées.` : 'Modification annulée.', 'success');
  } catch (e) { toast('Annulation impossible : ' + errText(e), 'error', 8000); }
  await saveSession(S.current);
  renderMessages();
  refreshFiles(true);
}

export const PLAN_ICONS = { todo: 'circle', in_progress: 'circle-dot', done: 'check' };

export const PLAN_STATUS = { todo: 'à faire', in_progress: 'en cours', done: 'fait' };

// Le panneau Plan, à droite de la conversation : le plan en cours, sinon le dernier gardé avec la conversation.
export function renderPlan() {
  const s = S.current, box = $('plan');
  const tasks = (S.gen?.session === s && S.gen.plan) || s?.plan?.tasks;
  box.hidden = !tasks?.length;
  if (box.hidden) return;
  const done = tasks.filter((t) => t.status === 'done').length;
  box.classList.toggle('collapsed', UI.planCollapsed);
  box.replaceChildren(
    h('button', { class: 'plan-head', title: UI.planCollapsed ? 'Déplier le plan' : 'Replier le plan', 'aria-expanded': String(!UI.planCollapsed), onclick: () => { UI.planCollapsed = !UI.planCollapsed; renderPlan(); } },
      icon('list-checks'), h('span', { class: 'plan-title' }, 'Plan'), h('span', { class: 'plan-count' }, `${done}/${tasks.length}`), icon(UI.planCollapsed ? 'chevron-left' : 'chevron-right')),
    UI.planCollapsed ? '' : h('ol', { class: 'plan-tasks' }, tasks.map((t) => h('li', { 'data-status': t.status, title: PLAN_STATUS[t.status] }, icon(PLAN_ICONS[t.status] ?? 'circle'), h('span', {}, t.title)))));
}
