// Nel Code Desktop — agent.js : Le mode Agent et Claude Agent : étapes, plan, NELCODE.md.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

// --- Mode Agent -----------------------------------------------------------------------------------------

import { locale, num, t, tr } from './i18n.js';
import { $, dialog, errText, h, invoke, toast } from './util.js';
import { S, UI } from './state.js';
import { closeEdit, newSession, renderAll, renderHeader, renderMessages, saveSession } from './conversation.js';
import { drawMarkdown, inlineMarkdown } from './markdown.js';
import { openSettings } from './settings.js';
import { refreshFiles } from './files.js';

// Le NELCODE.md modèle créé par le bouton de l'en-tête (écrit tel quel par la partie Rust).
const NELCODE_TEMPLATE = 'agent.nelcode_template';   // une clé : le modèle dans la langue de l'interface

export const AGENT_LOCAL = 'agent.mode_agent_demande_modele_distant';

// --- Claude Agent ---------------------------------------------------------------------------------------
// Une conversation menée par l'outil « claude » d'Anthropic installé sur le PC, avec une clé API.

export const money = (usd) => `${Number(usd ?? 0).toLocaleString(locale(), { minimumFractionDigits: 4, maximumFractionDigits: 4 })} $`;

export const claudeCost = (c) => [c.cost !== null && c.cost !== undefined && money(c.cost), c.durationMs && `${(c.durationMs / 1000).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`,
  c.turns && t('agent.turns', { n: c.turns })].filter(Boolean).join(' · ');

export async function startClaudeAgent() {
  if (S.gen) return toast(t('agent.attends_fin_reponse_stop'), 'warning');
  const st = S.claudeStatus = await invoke('claude_agent_status');
  if (!st.cli) {
    return dialog(t('agent.claude_agent'), [h('p', {}, t('agent.claude_agent_utilise_outil_ligne')),
      h('p', {}, t('agent.installe_puis_relance_nel_code')), h('div', { class: 'url' }, st.installUrl)],
    [{ label: t('agent.fermer'), value: null }, { label: t('agent.ouvrir_page_installation'), value: 'open', primary: true }]).then((v) => v && invoke('open_claude_install'));
  }
  if (!st.hasKey) {
    toast(t('agent.claude_agent_ajoute_abord_ta'), 'warning', 8000);
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
  const key = h('input', { class: 'text-input key', type: 'password', autocomplete: 'off', 'aria-label': t('agent.cle_api_anthropic'), placeholder: st.hasKey ? t('agent.cle_enregistree_vide_inchangee') : t('agent.sk_ant') });
  const btns = h('div', { class: 'row-btns' });
  const drawBtns = () => btns.replaceChildren(key, h('button', { class: 'btn', onclick: () => saveKey(key.value) }, t('agent.ranger_cle')),
    S.claudeStatus.hasKey ? h('button', { class: 'btn', onclick: () => saveKey('') }, t('agent.retirer_cle')) : null);
  const saveKey = async (value) => {
    try {
      await invoke('claude_agent_save_key', { key: value });
      key.value = '';
      S.claudeStatus = await invoke('claude_agent_status');
      key.placeholder = S.claudeStatus.hasKey ? t('agent.cle_enregistree_vide_inchangee') : t('agent.sk_ant');
      drawBtns();
      toast(value ? t('agent.cle_api_enregistree_dans', { keystore: S.info.keystore }) : t('agent.cle_api_retiree'), 'success', 3000);
    } catch (e) { toast(errText(e), 'error'); }
  };
  key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveKey(key.value); } });
  drawBtns();
  return h('div', { class: 'claude-field' },
    h('div', { class: 'hint cli' }, st.cli ? t('agent.outil_claude', { cli: st.cli }) : [t('agent.outil_claude_anthropic_introuvable'), h('a', { href: '#', onclick: (e) => { e.preventDefault(); invoke('open_claude_install'); } }, 'l\'installer')]),
    btns,
    h('div', { class: 'hint' }, t('agent.cle_api_anthropic_console_anthropic', { keystore: S.info.keystore })));
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
    ? (info.truncated ? t('agent.nelcode_used_truncated', { bytes: num(info.bytes), max: num(info.max) }) : t('agent.nelcode_used', { bytes: num(info.bytes) }))
    : t('agent.creer_nelcode_md_modele_racine');
}

export async function nelcodeChip() {
  const s = S.current;
  if ($('nelcode-chip').dataset.exists) return toast($('nelcode-chip').title, '', 6000);
  try {
    await invoke('create_nelcode_md', { dir: s.workingDirectory, text: t(NELCODE_TEMPLATE) });
    toast(t('agent.nelcode_created'), 'success', 6000);
  } catch (e) { toast(errText(e), 'error'); }
  refreshNelcode();
}

export function toggleAgent() {
  const s = S.current;
  if (s.claudeAgent) return toast(t('agent.conversation_claude_agent_deja_ses'), 'warning');
  if (!s.agent && !S.model.remote) return toast(t(AGENT_LOCAL), 'warning', 8000);
  if (s.compare) return toast(t('agent.mode_agent_ne_marche_pas'), 'warning');
  s.agent = !s.agent;
  if (!s.agent) delete s.agent;
  if (s.messages.length) saveSession(s);
  renderHeader();
  toast(s.agent ? t('agent.mode_agent_peut_lire_fichiers', { name: S.model.name, v1: s.workingDirectory || '(aucun dossier)' }) : t('agent.mode_agent_desactive'), '', 4000);
}

export const STEP_ICONS = { list: 'folder', read: 'eye', search: 'search', write: 'file-plus', edit: 'pencil', note: 'asterisk', error: 'circle-alert', command: 'terminal', plan: 'list-checks', explorer: 'bot', mcp: 'plug', worker: 'hammer', review: 'list-checks' };   // i18n-ignore (noms d'icônes)

// Les états d'une étape et d'une tâche du plan : des clés (step.status.*, plan.status.*), traduites à l'affichage.
export const STEP_STATUS = Object.fromEntries(['pending', 'accepted', 'rejected', 'undone', 'error', 'running', 'stopped', 'waiting', 'draft', 'discarded'].map((k) => [k, 'step.status.' + k]));

export function diffEl(lines) {
  return h('div', { class: 'diff' }, lines.map(([c, l]) => h('div', { class: { '+': 'add', '-': 'del', '…': 'skip' }[c] ?? 'ctx' }, h('span', { class: 'sign' }, c === '…' ? '' : c), l)));
}

// Le texte écrit par un modèle (message intermédiaire, rapport d'un sous-agent, résumé d'un explorateur) : en Markdown ;
// la sortie d'un outil reste telle quelle.
const isProse = (st) => st.status !== 'error' && st.status !== 'rejected' && (st.kind === 'explorer' || st.kind === 'worker' || (st.kind === 'note' && (!st.tool || st.tool === 'Task' || st.tool === 'Agent')));

function detailEl(st) {
  if (!isProse(st) || S.settings.markdown === false) return h('pre', { class: 'detail' }, tr(st.detail));
  const el = h('div', { class: 'detail' });
  drawMarkdown(el, tr(st.detail));
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
    const status = STEP_STATUS[st.status] ? h('span', { class: 'status ' + st.status }, t(STEP_STATUS[st.status])) : null;
    const body = h('div', { class: 'step-body' });
    const n = count[st.id];
    if (st.kind === 'worker' && st.files?.length) body.append(h('div', { class: 'hint worker-files' }, t('agent.worker_files', { files: st.files.join(', ') })));
    if (n) { subs.set(st.id, h('div', { class: 'substeps' })); body.append(subs.get(st.id)); }
    if (st.kind === 'review') body.append(reviewEl(st, m));
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
      h('button', { class: 'btn danger', onclick: (e) => decide('accept', e) }, st.kind === 'search' ? t('agent.parcourir_aussi_ces_fichiers') : write ? t('agent.autoriser_ecriture') : t('agent.autoriser_lecture')),
      h('button', { class: 'btn primary', onclick: (e) => decide('reject', e) }, t('agent.refuser'))));
    // Une commande : Lancer ou Refuser, à chaque fois (jamais « Accepter tout »).
    if (st.status === 'pending' && !m && st.kind === 'command') body.append(h('div', { class: 'row-btns' },
      h('button', { class: 'btn primary', onclick: (e) => decide('accept', e) }, icon('terminal'), t('agent.lancer')),
      h('button', { class: 'btn', onclick: (e) => decide('reject', e) }, t('agent.refuser'))));
    // Un outil MCP : Autoriser, Toujours autoriser cet outil (gardé), ou Refuser.
    if (st.status === 'pending' && !m && st.kind === 'mcp') body.append(h('div', { class: 'row-btns' },
      h('button', { class: 'btn primary', onclick: (e) => decide('accept', e) }, icon('check'), t('agent.autoriser')),
      h('button', { class: 'btn', title: t('agent.ne_plus_demander_pour_cet'), onclick: (e) => decide('always', e) }, t('agent.toujours_autoriser_cet_outil')),
      h('button', { class: 'btn', onclick: (e) => decide('reject', e) }, t('agent.refuser'))));
    if (st.status === 'pending' && !m && !st.protected && st.kind !== 'command' && st.kind !== 'mcp' && st.kind !== 'review') body.append(h('div', { class: 'row-btns' },
      h('button', { class: 'btn primary', onclick: (e) => decide('accept', e) }, icon('check'), t('agent.accepter')),
      h('button', { class: 'btn', onclick: (e) => decide('reject', e) }, t('agent.refuser')),
      h('button', { class: 'btn', title: t('agent.accepter_cette_ecriture_suivantes_cette'), onclick: (e) => decide('accept_all', e) }, t('agent.accepter_tout_pour_cette_demande'))));
    if (write && st.status === 'accepted' && m && !st.parent) body.append(h('div', { class: 'row-btns' },
      h('button', { class: 'btn', onclick: () => undoSteps(m, [st.id], () => invoke('agent_undo', { request: st.request, step: st.id }).then(() => [st.id])) }, icon('undo-2'), t('agent.annuler'))));
    (subs.get(st.parent) ?? box).append(h('details', { class: 'step ' + st.kind, 'data-step': st.id, 'data-status': st.status, open: (st.status === 'pending' || st.status === 'running') && !m },
      h('summary', {}, icon(STEP_ICONS[st.kind] ?? 'asterisk'), h('span', { class: 'title' }, st.kind === 'note' && !st.tool ? inlineMarkdown(tr(st.title)) : tr(st.title)),
        n ? h('span', { class: 'count' }, t('agent.steps', { n })) : null, st.kind === 'explorer' || st.kind === 'worker' ? explorerMeta(st) : null, status), body));
  }
  const undoable = m && steps.filter((st) => (st.kind === 'write' || st.kind === 'edit') && st.status === 'accepted' && !st.parent);
  if (undoable?.length) box.append(h('div', { class: 'row-btns undo-all' },
    h('button', { class: 'btn', onclick: () => undoSteps(m, undoable.map((st) => st.id), () => invoke('agent_undo_all', { request: m.agent.request })) }, icon('undo-2'), t('agent.annuler_toute_demande'))));
  return box;
}

// La revue groupée des brouillons des travailleurs : par travailleur puis par fichier, le diff et Accepter / Refuser ;
// « Valider » quand chaque fichier est décidé, « Tout accepter », « Tout refuser ». Rien n'est écrit avant. Les choix
// sont gardés pendant que les étapes se redessinent. Une revue finie montre la décision de chaque fichier.
const REVIEWS = new Map();   // « demande/étape » → Map(chemin → 'accepted' | 'rejected')

function reviewEl(st, m) {
  const live = st.status === 'pending' && !m;
  const key = `${st.request}/${st.id}`;
  if (!REVIEWS.has(key)) REVIEWS.set(key, new Map());
  const choice = REVIEWS.get(key);
  const paths = (st.workers ?? []).flatMap((g) => g.files.map((f) => f.path));
  const box = h('div', { class: 'review' });
  const redraw = () => box.replaceWith(reviewEl(st, m));
  if (live) box.append(h('div', { class: 'hint' }, t('agent.review.hint')));
  for (const g of st.workers ?? []) {
    box.append(h('div', { class: 'review-worker' }, h('span', { class: 'badge' }, g.worker), h('span', {}, g.task)));
    for (const f of g.files) {
      const decided = live ? choice.get(f.path) : f.decision;
      const pick = (d) => h('button', { class: 'btn' + (decided === d ? (d === 'accepted' ? ' primary' : ' on') : ''), 'data-choice': d, onclick: () => { choice.set(f.path, d); redraw(); } },
        d === 'accepted' ? icon('check') : null, t(d === 'accepted' ? 'agent.review.accept' : 'agent.review.reject'));
      box.append(h('div', { class: 'review-file', 'data-path': f.path, 'data-decision': decided ?? '' },
        h('div', { class: 'review-head' }, h('span', { class: 'path' }, f.path),
          h('span', { class: 'meta' }, `${t(f.created ? 'agent.review.created' : 'agent.review.modified')} +${f.added} −${f.removed}`),
          live ? h('span', { class: 'row-btns' }, pick('accepted'), pick('rejected'))
            : decided && STEP_STATUS[decided] ? h('span', { class: 'status ' + decided }, t(STEP_STATUS[decided])) : null),
        diffEl(f.diff)));
    }
  }
  if (!live) return box;
  const send = (cmd, args, e) => {
    const btns = [...(e?.currentTarget?.closest('.row-btns')?.querySelectorAll('button') ?? [])];
    for (const b of btns) b.disabled = true;
    invoke(cmd, { request: st.request, step: st.id, ...args }).then(() => REVIEWS.delete(key)).catch((err) => {
      for (const b of btns) b.disabled = false;
      toast(errText(err), 'error');
    });
  };
  const accepted = paths.filter((p) => choice.get(p) === 'accepted');
  const all = paths.every((p) => choice.has(p));
  box.append(h('div', { class: 'row-btns review-actions' },
    h('button', { class: 'btn primary', 'data-action': 'validate', disabled: !all, onclick: (e) => send('agent_review', { accepted }, e) }, icon('check'),
      t('agent.review.validate', { accepted: accepted.length, rejected: paths.length - accepted.length })),
    h('button', { class: 'btn', 'data-action': 'accept_all', onclick: (e) => send('agent_decide', { decision: 'accept_all' }, e) }, t('agent.review.accept_all')),
    h('button', { class: 'btn', 'data-action': 'reject_all', onclick: (e) => send('agent_decide', { decision: 'reject' }, e) }, t('agent.review.reject_all'))));
  return box;
}

// Un explorateur : sa durée et ses tokens (entrée + sortie), mis à jour à chaque tour.
function explorerMeta(st) {
  const tokens = (st.tokens?.input ?? 0) + (st.tokens?.output ?? 0);
  const text = [st.seconds !== undefined && `${st.seconds.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`,
    tokens && `${tokens.toLocaleString(locale())} tokens`].filter(Boolean).join(' · ');
  return text ? h('span', { class: 'meta', title: st.model ? t('agent.modele', { model: st.model }) : '' }, text) : null;
}

// Annule des écritures (le Rust refuse si un fichier a changé depuis), puis les marque « annulée » dans la conversation.
export async function undoSteps(m, ids, run) {
  if (S.gen) return toast(t('agent.attends_fin_reponse_stop'), 'warning');
  try {
    const done = await run();
    for (const st of m.agent.steps) if (done.includes(st.id)) st.status = 'undone';
    toast(done.length > 1 ? t('agent.undone_many', { n: done.length }) : t('agent.modification_annulee'), 'success');
  } catch (e) { toast(t('agent.annulation_impossible', { error: errText(e) }), 'error', 8000); }
  await saveSession(S.current);
  renderMessages();
  refreshFiles(true);
}

export const PLAN_ICONS = { todo: 'circle', in_progress: 'circle-dot', done: 'check' };

export const PLAN_STATUS = { todo: 'plan.status.todo', in_progress: 'plan.status.in_progress', done: 'plan.status.done' };

// Le panneau Plan, à droite de la conversation : le plan en cours, sinon le dernier gardé avec la conversation.
export function renderPlan() {
  const s = S.current, box = $('plan');
  const tasks = (S.gen?.session === s && S.gen.plan) || s?.plan?.tasks;
  box.hidden = !tasks?.length;
  if (box.hidden) return;
  const done = tasks.filter((tx) => tx.status === 'done').length;
  box.classList.toggle('collapsed', UI.planCollapsed);
  box.replaceChildren(
    h('button', { class: 'plan-head', title: UI.planCollapsed ? t('agent.deplier_plan') : t('agent.replier_plan'), 'aria-expanded': String(!UI.planCollapsed), onclick: () => { UI.planCollapsed = !UI.planCollapsed; renderPlan(); } },
      icon('list-checks'), h('span', { class: 'plan-title' }, t('agent.plan')), h('span', { class: 'plan-count' }, `${done}/${tasks.length}`), icon(UI.planCollapsed ? 'chevron-left' : 'chevron-right')),
    UI.planCollapsed ? '' : h('ol', { class: 'plan-tasks' }, tasks.map((tx) => {
      // Une tâche attribuée à un travailleur : son id et son état (en direct pendant la demande).
      const live = S.gen?.session === s && S.gen.steps?.find((st) => st.kind === 'worker' && st.worker === tx.worker)?.status;
      const ws = tx.worker ? (live || tx.workerStatus) : null;
      const worker = tx.worker ? h('span', { class: 'plan-worker', 'data-worker-status': ws ?? '', title: t('agent.plan_worker', { worker: tx.worker, status: STEP_STATUS[ws] ? t(STEP_STATUS[ws]) : '' }) }, tx.worker) : null;
      return h('li', { 'data-status': tx.status, 'data-worker': tx.worker ?? '', title: PLAN_STATUS[tx.status] ? t(PLAN_STATUS[tx.status]) : undefined }, icon(PLAN_ICONS[tx.status] ?? 'circle'), h('span', { class: 'plan-text' }, tx.title), worker);
    })));
}
