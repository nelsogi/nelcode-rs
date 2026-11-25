// Nel Code Desktop — summary.js : Le résumé du contexte : automatique (seuil des réglages) ou à la main (/compact).
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.
//
// Les anciens échanges sont résumés par le modèle actif ; les 4 derniers restent tels quels. `s.summary` = { text, upTo }
// remplace, pour le modèle seulement, les messages avant l'indice upTo : ils restent dans la conversation (grisés).
// Pas pour les .nelmodel (contexte trop petit), ni pour Claude Agent (qui gère son propre contexte).

import { stepText, t } from './i18n.js';
import { h, invoke, toast } from './util.js';
import { S, UI } from './state.js';
import { historyOf, startGen, summaryOf } from './conversation.js';
import { drawMarkdown } from './markdown.js';
import { imageLines, imageTokens, vision } from './images.js';

export const KEEP_TURNS = 4;
// Ce qui part au modèle (consigne, transcription) n'est pas l'interface : pas traduit (« dans la langue des échanges »).
// i18n-ignore-start
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

// i18n-ignore-end
const clip = (tx, n) => (tx.length > n ? tx.slice(0, n) + '…' : tx);
const lines = (tx) => (tx ? tx.split('\n').length : 0);

// i18n-ignore-start
// L'étape d'un agent en une ligne (« fichier lu : src/Player.cs, 120 lignes ») : le contenu des fichiers et les sorties
// de commandes n'entrent pas dans le résumé.
export function stepLine(st) {
  switch (st.kind) {
    case 'read': return st.status === 'done' ? `fichier lu : ${st.path}, ${lines(st.detail)} lignes` : `lecture refusée : ${st.path}`;
    case 'write': case 'edit': return `${st.kind === 'write' ? 'fichier créé' : 'fichier modifié'} : ${st.path} (${{ accepted: 'accepté', undone: 'annulé' }[st.status] ?? 'refusé'})`;
    case 'command': return `commande : ${clip(st.command ?? stepText(st, 'title', 'fr'), 120)} (${st.status})`;
    case 'error': return `erreur : ${clip(stepText(st, 'title', 'fr'), 80)} — ${clip(stepText(st, 'detail', 'fr').replace(/\s+/g, ' '), 120)}`;
    case 'list': case 'search': return stepText(st, 'title', 'fr');
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
    // Une image n'entre pas dans le résumé : seulement « [image : nom] ».
    if (m.role === 'user') { parts.push('Utilisateur : ' + [imageLines(m), clip(m.content, 3000)].filter(Boolean).join('\n')); continue; }
    const steps = (m.agent?.steps ?? []).map(stepLine).filter(Boolean).slice(0, 30);
    parts.push('Assistant : ' + steps.map((l) => `[${l}]\n`).join('') + clip(m.content, 3000));
  }
  if (s.plan?.tasks?.length) parts.push('Plan en cours :\n' + s.plan.tasks.map((tx) => `- ${tx.title} (${tx.status})`).join('\n'));
  return parts.join('\n\n');
}
// i18n-ignore-end

// Les tokens du prochain envoi (réserve de la réponse comprise) et la taille du contexte (null si inconnue).
async function usage(s, text) {
  const history = historyOf(s);
  if (S.model.remote) return { used: Math.ceil((history.flat().join('').length + text.length) / 4) + (vision().ok ? imageTokens(s)[0] : 0), size: S.model.blockSize };
  const c = await invoke('context_info', { history, message: text });
  return { used: c.tokens + c.reserve, size: c.blockSize };
}

// Écrit le résumé avec le modèle actif ; 'ok', 'nothing' (rien à résumer), 'stopped' ou 'error'.
export async function summarize(s, { instruction = '', size } = {}) {
  const r = range(s);
  if (!r) return 'nothing';
  let text = transcript(s, r);
  const max = Math.floor((size || 8192) * 4 * 0.6);   // le texte à résumer doit tenir dans le contexte, avec la place du résumé
  if (text.length > max) text = '(début omis)\n' + text.slice(-max);   // i18n-ignore
  const question = `${PROMPT}${instruction.trim() ? `\nConsigne de l'utilisateur : ${instruction.trim()}` : ''}\n\n---\n${text}`;   // i18n-ignore
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
    if (result === 'ok') toast(t('summary.anciens_echanges_resumes_pour_garder'), '', 3500);
    return result !== 'stopped';
  } finally { UI.preparing = false; }
}

// /compact [consigne] : résumer à la main.
export async function compactNow(instruction = '') {
  const s = S.current;
  if (s.claudeAgent) return toast(t('summary.claude_agent_gere_lui_meme'), 'warning');
  if (s.compare) return toast(t('summary.pas_resume_dans_conversation_comparee'), 'warning');
  if (!S.model.name) return toast(t('summary.aucun_modele_charge_resume_est'), 'warning');
  if (!summarizable(s)) return toast(t('summary.pas_resume_avec_nelmodel_son'), 'warning');
  if (S.gen) return toast(t('summary.attends_fin_reponse_stop'), 'warning');
  const result = await summarize(s, { instruction, size: S.context?.blockSize ?? S.model.blockSize });
  if (result === 'nothing') toast(t('summary.rien_resumer_derniers_echanges_restent', { KEEP_TURNS: KEEP_TURNS }), 'warning');
  else if (result === 'ok') toast(t('summary.echanges_precedents_resumes'), 'success');
}

// Le bloc repliable, à la place des messages résumés.
export function summaryEl(sm) {
  const text = h('div', { class: 'think' });
  drawMarkdown(text, sm.text);
  return h('details', { class: 'reasoning summary-block' }, h('summary', {}, icon('chevron-right'), t('summary.resume_echanges_precedents')), text);
}
