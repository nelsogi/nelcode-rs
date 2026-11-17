// Nel Code Desktop — summary.js : Le résumé du contexte : automatique (seuil des réglages) ou à la main (/compact).
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.
//
// Les anciens échanges sont résumés par le modèle actif ; les 4 derniers restent tels quels. `s.summary` = { text, upTo }
// remplace, pour le modèle seulement, les messages avant l'indice upTo : ils restent dans la conversation (grisés).
// Pas pour les .nelmodel (contexte trop petit), ni pour Claude Agent (qui gère son propre contexte).

import { h, invoke, toast } from './util.js';
import { S, UI } from './state.js';
import { historyOf, startGen, summaryOf } from './conversation.js';

export const KEEP_TURNS = 4;
const PROMPT = 'Résume les échanges ci-dessous pour qu\'une conversation puisse continuer sans eux. Garde : les décisions prises, les fichiers modifiés, le plan en cours et les erreurs non résolues. Écris seulement le résumé (une liste courte, sans introduction), dans la langue des échanges.';

// Le modèle actif peut-il résumer ? Un modèle distant (Claude compris) ou un GGUF.
export function summarizable(s = S.current) {
  if (!s || s.claudeAgent || s.compare || !S.model.name) return false;
  return !!S.model.remote || S.models.find((m) => m.name === S.model.name)?.weights === 'gguf';
}

// Les messages à résumer : de la fin du résumé actuel jusqu'aux 4 derniers échanges (toujours gardés).
const range = (s) => {
  const from = summaryOf(s)?.upTo ?? 0, to = (s.messages.length - 2 * KEEP_TURNS) & ~1;
  return to - from >= 2 ? { from, to } : null;
};

const clip = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);
const lines = (t) => (t ? t.split('\n').length : 0);

// L'étape d'un agent en une ligne (« fichier lu : src/Player.cs, 120 lignes ») : le contenu des fichiers et les sorties
// de commandes n'entrent pas dans le résumé.
export function stepLine(st) {
  switch (st.kind) {
    case 'read': return st.status === 'done' ? `fichier lu : ${st.path}, ${lines(st.detail)} lignes` : `lecture refusée : ${st.path}`;
    case 'write': case 'edit': return `${st.kind === 'write' ? 'fichier créé' : 'fichier modifié'} : ${st.path} (${{ accepted: 'accepté', undone: 'annulé' }[st.status] ?? 'refusé'})`;
    case 'command': return `commande : ${clip(st.command ?? st.title, 120)} (${st.status})`;
    case 'error': return `erreur : ${clip(st.title, 80)} — ${clip((st.detail ?? '').replace(/\s+/g, ' '), 120)}`;
    case 'list': case 'search': return st.title;
    default: return null;   // notes et plan : le plan est repris à part
  }
}

// Le texte à résumer : l'éventuel résumé précédent, les messages de from à to (étapes de l'agent en lignes courtes), le plan.
function transcript(s, { from, to }) {
  const parts = [];
  const prev = summaryOf(s);
  if (prev) parts.push('Résumé précédent :\n' + prev.text);
  for (let i = from; i < to; i++) {
    const m = s.messages[i];
    if (m.role === 'user') { parts.push('Utilisateur : ' + clip(m.content, 3000)); continue; }
    const steps = (m.agent?.steps ?? []).map(stepLine).filter(Boolean).slice(0, 30);
    parts.push('Assistant : ' + steps.map((l) => `[${l}]\n`).join('') + clip(m.content, 3000));
  }
  if (s.plan?.tasks?.length) parts.push('Plan en cours :\n' + s.plan.tasks.map((t) => `- ${t.title} (${t.status})`).join('\n'));
  return parts.join('\n\n');
}

// Les tokens du prochain envoi (réserve de la réponse comprise) et la taille du contexte (null si inconnue).
async function usage(s, text) {
  const history = historyOf(s);
  if (S.model.remote) return { used: Math.ceil((history.flat().join('').length + text.length) / 4), size: S.model.blockSize };
  const c = await invoke('context_info', { history, message: text });
  return { used: c.tokens + c.reserve, size: c.blockSize };
}

// Écrit le résumé avec le modèle actif ; 'ok', 'nothing' (rien à résumer), 'stopped' ou 'error'.
export async function summarize(s, { instruction = '', size } = {}) {
  const r = range(s);
  if (!r) return 'nothing';
  let text = transcript(s, r);
  const max = Math.floor((size || 8192) * 4 * 0.6);   // le texte à résumer doit tenir dans le contexte, avec la place du résumé
  if (text.length > max) text = '(début omis)\n' + text.slice(-max);
  const question = `${PROMPT}${instruction.trim() ? `\nConsigne de l'utilisateur : ${instruction.trim()}` : ''}\n\n---\n${text}`;
  return new Promise((resolve) => { startGen(s, { kind: 'summary', question, history: [], upTo: r.to, resolve }).then((ok) => ok || resolve('error')); });
}

// Avant un envoi : résume si le contexte dépasse le seuil des réglages (0 : jamais). Faux si l'utilisateur a arrêté.
export async function autoSummarize(s, text) {
  const percent = S.settings.summaryThreshold ?? 80;
  if (!percent || !summarizable(s) || !range(s)) return true;
  UI.preparing = true;
  try {
    let u;
    try { u = await usage(s, text); } catch { return true; }   // modèle en cours de changement
    if (!u.size || u.used * 100 < u.size * percent) return true;
    const result = await summarize(s, { size: u.size });
    if (result === 'ok') toast('Anciens échanges résumés pour garder le contexte.', '', 3500);
    return result !== 'stopped';
  } finally { UI.preparing = false; }
}

// /compact [consigne] : résumer à la main.
export async function compactNow(instruction = '') {
  const s = S.current;
  if (s.claudeAgent) return toast('Claude Agent gère lui-même son contexte.', 'warning');
  if (s.compare) return toast('Pas de résumé dans une conversation comparée.', 'warning');
  if (!S.model.name) return toast('Aucun modèle chargé : le résumé est écrit par le modèle actif.', 'warning');
  if (!summarizable(s)) return toast('Pas de résumé avec un .nelmodel : son contexte est trop petit.', 'warning');
  if (S.gen) return toast('Attends la fin de la réponse (ou Stop).', 'warning');
  const result = await summarize(s, { instruction, size: S.context?.blockSize ?? S.model.blockSize });
  if (result === 'nothing') toast(`Rien à résumer : les ${KEEP_TURNS} derniers échanges restent toujours tels quels.`, 'warning');
  else if (result === 'ok') toast('Échanges précédents résumés.', 'success');
}

// Le bloc repliable, à la place des messages résumés.
export function summaryEl(sm) {
  return h('details', { class: 'reasoning summary-block' }, h('summary', {}, icon('chevron-right'), 'Résumé des échanges précédents'), h('div', { class: 'think' }, sm.text));
}
