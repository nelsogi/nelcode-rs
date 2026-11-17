// Nel Code Desktop — conversation.js : Les conversations : liste, modèles, fichiers @, génération, réflexion, transparence, comparaison, affichage, saisie.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

// --- Conversations ---------------------------------------------------------------------------------------

import { $, confirmDialog, dialog, errText, fold, h, invoke, localIso, newId, paramsText, promptDialog, relDate, richText, showMenu, sizeText, toast } from './util.js';
import { S, UI } from './state.js';
import { AGENT_LOCAL, claudeCost, money, refreshNelcode, renderPlan, stepsEl } from './agent.js';
import { U } from './settings.js';
import { openCatalog } from './catalog.js';
import { runCommand, updateSuggest } from './palette.js';
import { projectName, rememberProject, renderProject, sameProject, sessionsByProject } from './projects.js';
import { refreshFiles } from './files.js';

export const TITLE_LENGTH = 40;

// Comme Sidebar.TitleOf de Nel Code C#.
export function titleOf(s) {
  if (s.title && s.title.trim()) return s.title;
  const first = (s.messages.find((m) => m.role === 'user')?.content ?? '').replace(/\s+/g, ' ').trim();
  if (!first) return 'Nouvelle conversation';
  if (first.length <= TITLE_LENGTH) return first;
  const cut = first.lastIndexOf(' ', TITLE_LENGTH);
  return first.slice(0, cut > TITLE_LENGTH / 2 ? cut : TITLE_LENGTH) + '…';
}

// Les tours (question, réponse) de messages[0..end], comme Session.Turns : par paires, user puis assistant.
export function turnsOf(messages, end = messages.length) {
  const turns = [];
  for (let i = 0; i + 1 < end; i += 2)
    if (messages[i].role === 'user' && messages[i + 1].role === 'assistant') turns.push([messages[i].content, messages[i + 1].content]);
  return turns;
}

export function newSession() {
  return {
    id: newId(),
    model: S.model.name ?? '',
    // Le projet affiché, sinon le dossier de la conversation en cours.
    workingDirectory: S.settings.currentProject || S.current?.workingDirectory || S.info.home || '',
    date: localIso(),
    messages: [],
  };
}

export async function saveSession(s) {
  if (!s.messages.length) return;   // comme en C# : une conversation vide n'est pas gardée
  try {
    await invoke('save_session', { session: s });
    if (!S.sessions.includes(s)) S.sessions.push(s);
  } catch (e) { toast('Sauvegarde impossible : ' + errText(e), 'error'); }
  renderSessions();
}

export function touch(s) { s.date = localIso(); if (s.compare) s.model = s.compare.a; else if (S.model.name) s.model = S.model.name; }

export function openSession(s) {
  if (S.current === s) return;
  closeEdit();
  S.current = s;
  renderAll();
  $('input').focus();
}

export function startNew() {
  if (S.current && !S.current.messages.length && !S.current.compare) { $('input').focus(); return; }
  openSession(newSession());
}

export async function deleteSession(s) {
  const ok = await confirmDialog('Supprimer la conversation ?', `« ${titleOf(s)} » sera supprimée définitivement.`, 'Supprimer', true);
  if (!ok) return;
  if (S.gen?.session === s) await invoke('stop_generation');
  try { await invoke('delete_session', { id: s.id }); } catch (e) { return toast(errText(e), 'error'); }
  S.sessions = S.sessions.filter((x) => x !== s);
  if (S.current === s) { S.current = null; openSession(newSession()); } else renderSessions();
}

export async function renameSession(s) {
  const name = await promptDialog('Renommer la conversation', titleOf(s), 'Laisser vide : titre tiré du premier message.');
  if (name === null) return;
  if (name.trim()) s.title = name.trim(); else delete s.title;
  await saveSession(s);
  renderHeader();
}

// Comme Export de Nel Code C# : "> question" / "● réponse", ou Markdown.
export async function exportSession(s, markdown) {
  if (!s.messages.length) return toast('Conversation vide : rien à exporter.', 'warning');
  const title = titleOf(s);
  const about = `${new Date(s.date).toLocaleString('fr-CH', { dateStyle: 'short', timeStyle: 'short' })} · ${s.model}`;
  let text = (markdown ? `# ${title}` : title) + '\n\n' + (markdown ? `*${about}*` : about) + '\n\n';
  for (const m of s.messages) {
    const user = m.role === 'user';
    if (m.compare) { text += `● [${m.model}] ${m.content}\n\n● [${m.compare.model}] ${m.compare.content}\n\n`; continue; }
    text += markdown ? `${user ? '**Moi**' : '**MiniChat**'}\n\n${m.content}\n\n` : `${user ? '>' : '●'} ${m.content}\n\n`;
  }
  const fileName = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + (markdown ? '.md' : '.txt');
  try {
    const path = await invoke('export_session', { fileName, content: text, markdown, directory: s.workingDirectory || '' });
    if (path) toast('Conversation exportée : ' + path, 'success');
  } catch (e) { toast(errText(e), 'error'); }
}

export async function chooseFolder(s = S.current) {
  const path = await invoke('pick_folder', { start: s.workingDirectory || S.info.home || '' });
  if (!path) return;
  s.workingDirectory = path;
  await rememberProject(path);
  // Un projet est affiché : il suit le dossier de la conversation (sinon elle disparaîtrait de la liste).
  if (S.settings.currentProject && !sameProject(S.settings.currentProject, path)) S.settings = await invoke('save_settings', { changes: { currentProject: path } });
  await saveSession(s);
  renderAll();
  toast('Dossier de travail : ' + path);
}

// --- Modèles ---------------------------------------------------------------------------------------------

export async function refreshModels() {
  S.models = await invoke('list_models');
  renderModels();
}

// Un modèle distant devient le modèle actif (rien à charger : les appels partent au fournisseur).
export async function selectRemote(p, m) {
  if (S.gen) return toast('Attends la fin de la réponse (ou Stop).', 'warning');
  Object.assign(S.model, { name: m.id, blockSize: m.contextLength ?? null, device: `réseau · ${p.name}`, remote: { provider: p.id, model: m.id } });
  S.lastSpeed = '';
  renderModels(); renderStatus(); refreshContext();
  try { S.settings = await invoke('save_settings', { changes: { lastModel: `remote:${p.id}/${m.id}` } }); } catch { /* sans gravité */ }
  toast(`${m.id} (${p.name}) : modèle distant.`, 'success', 2500);
}

export async function loadModel(name) {
  if (S.model.loading) return toast(`Chargement de ${S.model.loading} en cours…`, 'warning');
  if (S.gen) return toast('Attends la fin de la réponse (ou Stop).', 'warning');
  try { await invoke('load_model', { name }); } catch (e) { toast(errText(e), 'error'); }
}

export async function deleteModel(name) {
  const ok = await confirmDialog('Supprimer le modèle ?', `Le dossier du modèle « ${name} » sera supprimé (aussi pour Nel Code C#).`, 'Supprimer', true);
  if (!ok) return;
  try {
    await invoke('delete_model', { name });
    if (S.model.name === name) Object.assign(S.model, { name: null, blockSize: null });
    toast(`Modèle « ${name} » supprimé.`, 'success');
  } catch (e) { toast(errText(e), 'error'); }
  await refreshModels();
  renderStatus(); refreshContext();
}

// Import : vérifie le paquet, montre ses infos, demande le nom (et quoi faire s'il est pris), puis importe.
export async function importFlow(path) {
  if (!path) path = await invoke('pick_nelmodel');   // .nelmodel ou .gguf
  if (!path) return;
  if (!/^[a-zA-Z]:[\\/]|^\\\\/.test(path) && S.current?.workingDirectory) path = S.current.workingDirectory.replace(/[\\/]$/, '') + '\\' + path;
  let pkg;
  try { pkg = await invoke('inspect_package', { path }); } catch (e) { return toast('Import refusé : ' + errText(e), 'error', 8000); }
  const i = pkg.info;
  const nameInput = h('input', { class: 'text-input', value: pkg.name, spellcheck: 'false' });
  const warn = h('div', { class: 'warn-text' });
  const rows = pkg.gguf ? [
    ['Modèle', i.name], ['Architecture', i.architecture], ['Paramètres', i.parameters?.toLocaleString('fr-CH')],
    ['Contexte', `${i.contextLength?.toLocaleString('fr-CH')} tokens (Nel Code en utilise au plus ${S.settings.contextLimit})`],
    ['Format de chat', i.chatFormat], ['Tokenizer', i.tokenizer], ['Licence', i.license ?? 'non indiquée dans le fichier : vérifie-la avant de t\'en servir'],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '') : [
    ['Nom proposé', i.name], ['Architecture', i.architecture], ['Paramètres', i.parameters?.toLocaleString('fr-CH')],
    ['Loss', i.valLoss?.toFixed?.(3)], ['Pas', i.trainingSteps], ['Créé le', i.createdAt && new Date(i.createdAt).toLocaleString('fr-CH')],
    ['Description', i.description], ['Format', 'version ' + i.formatVersion],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  const body = [
    h('dl', { class: 'info-grid' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    h('label', { class: 'field' }, h('div', { class: 'row' }, 'Installer sous le nom'), nameInput), warn,
  ];
  const check = () => {
    const n = nameInput.value.trim();
    const taken = S.models.some((m) => m.name.toLowerCase() === n.toLowerCase());
    warn.textContent = taken ? `Un modèle « ${n} » existe déjà : « Remplacer » l'écrase une fois le nouveau vérifié.` : '';
    return taken;
  };
  nameInput.addEventListener('input', check);
  check();
  const choice = await dialog('Importer un modèle', body, [
    { label: 'Annuler', value: null },
    { label: 'Remplacer', value: 'replace', danger: true, show: () => check() },
    { label: 'Importer', value: 'import', primary: true },
  ], nameInput);
  if (!choice) return;
  const name = nameInput.value.trim();
  if (choice === 'import' && check()) return toast('Ce nom est déjà pris : choisis-en un autre, ou « Remplacer ».', 'warning');
  try { await invoke('import_model', { path, name, replace: choice === 'replace' }); } catch (e) { toast(errText(e), 'error'); }
}

// --- Fichiers du dossier de travail (@) ------------------------------------------------------------------
// « @chemin » dans la saisie : le fichier (lu, jamais modifié) est ajouté au message dans un bloc de code.

export const F = { dir: null, list: [], at: 0, loading: null };

export const EXT_LANG = { rs: 'rust', cs: 'csharp', py: 'python', js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx', html: 'html', htm: 'html', css: 'css', json: 'json', xml: 'xml', md: 'markdown', toml: 'toml', yml: 'yaml', yaml: 'yaml', sh: 'bash', ps1: 'powershell' };

// La liste des fichiers du dossier de travail, gardée 10 s.
export function workFiles() {
  const dir = S.current?.workingDirectory;
  if (!dir) return [];
  if ((F.dir !== dir || Date.now() - F.at > 10_000) && !F.loading) {
    F.loading = invoke('list_files', { dir }).then((list) => { Object.assign(F, { dir, list, at: Date.now() }); }, () => Object.assign(F, { dir, list: [], at: Date.now() }))
      .finally(() => { F.loading = null; updateSuggest(); });
  }
  return F.dir === dir ? F.list : [];
}

export const MENTION = /(^|\s)@([^\s@]+)/g;

// Le message avec le contenu des fichiers cités. `quiet` : un fichier illisible ou protégé est ignoré (barre de
// contexte) ; sinon l'erreur est affichée et rien n'est rendu. Un fichier protégé (.env, *.pem…) n'est lu qu'après
// une confirmation explicite.
export async function expandMentions(text, quiet = false) {
  const dir = S.current?.workingDirectory;
  const paths = [...new Set([...text.matchAll(MENTION)].map((m) => m[2]))];
  if (!dir || !paths.length) return text;
  let out = text;
  for (const path of paths) {
    try {
      let content;
      try { content = await invoke('read_file', { dir, path }); } catch (e) {
        const [tag, pattern, rel] = errText(e).split('\t');
        if (tag !== 'PROTECTED' || quiet) throw e;
        const ok = await confirmDialog('Fichier protégé', `« ${rel} » est protégé (${pattern}) : il peut contenir des mots de passe ou des clés. Le lire et l'envoyer au modèle avec ce message ?`, 'Lire et envoyer', true);
        if (!ok) { toast(`« ${rel} » n'a pas été lu : le message n'est pas envoyé.`, 'warning'); return null; }
        content = await invoke('read_file', { dir, path, confirm: true });
      }
      const lang = EXT_LANG[path.split('.').pop().toLowerCase()] ?? '';
      const fence = content.includes('```') ? '````' : '```';
      out += `\n\n${path} :\n${fence}${lang}\n${content.replace(/\n$/, '')}\n${fence}`;
    } catch (e) {
      if (quiet) continue;
      // Un @ qui ne ressemble pas à un fichier (adresse, décorateur…) reste du texte ; un nom refusé (NUL…) non.
      if (!/[./\\]/.test(path) && /introuvable/.test(errText(e))) continue;
      toast(errText(e), 'error', 6000);
      return null;
    }
  }
  return out;
}

// --- Génération ------------------------------------------------------------------------------------------

export function genOptions() {
  const s = S.settings;
  return { temperature: s.temperature, topK: s.topK, topP: s.topP, maxReplyTokens: s.maxReplyTokens, repetitionPenalty: s.repetitionPenalty, transparency: !!s.transparency };
}

export function canGenerate() {
  if (S.gen) return false;
  if (S.bench) { toast('Test de vitesse en cours…', 'warning'); return false; }
  if (U.state === 'installing') { toast('Installation de la mise à jour en cours…', 'warning'); return false; }
  if (!S.model.name && !S.current?.compare && !S.current?.claudeAgent) {
    toast(S.model.loading ? `Le modèle ${S.model.loading} se charge…` : 'Aucun modèle chargé : choisis-en un à gauche, importe un .nelmodel ou un .gguf, ou ouvre le catalogue.', 'warning');
    return false;
  }
  return true;
}

export async function send(text) {
  text = text.trim();
  if (!text || !canGenerate()) return false;
  const s = S.current;
  const history = turnsOf(s.messages);
  s.messages.push({ role: 'user', content: text });
  if (s.compare) return startGen(s, { kind: 'compare', question: text, history, historyB: turnsOf(s.messages.map((m) => m.compare ? { role: 'assistant', content: m.compare.content } : m), s.messages.length - 1), a: { text: '', tokens: [] }, b: { text: '', tokens: [] }, side: 'a' });
  return startGen(s, { kind: 'send', index: s.messages.length, question: text, history });
}

export async function regenerate(index) {
  const s = S.current;
  if (!canGenerate() || s.compare || s.messages[index]?.role !== 'assistant') return;
  const question = s.messages[index - 1].content;
  s.messages.splice(index + 1);          // la suite de la conversation est retirée
  await saveSession(s);
  return startGen(s, { kind: 'regen', index, question, history: turnsOf(s.messages, index - 1), old: s.messages[index] });
}

export async function startGen(s, g) {
  S.gen = { ...g, session: s, text: '', tokens: [], reasoning: '', thinkStart: null, thinkEnd: null, steps: [] };
  renderMessages();
  renderComposer();
  renderStatus();
  try {
    const r = S.model.remote;
    if (g.kind === 'compare')
      await invoke('compare_generate', { a: s.compare.a, b: s.compare.b, historyA: g.history, historyB: g.historyB, message: g.question, options: genOptions() });
    else if (s.claudeAgent) {
      // Claude Agent : l'outil claude reprend sa propre session ; l'historique n'est pas renvoyé.
      if (!s.workingDirectory) throw new Error('Claude Agent : choisis d\'abord un dossier de travail (/dir).');
      await invoke('claude_agent_send', { sessionId: s.claudeAgent.sessionId ?? null, message: g.question, dir: s.workingDirectory });
    } else if (s.agent) {
      // Le mode Agent : seulement un modèle distant qui gère les outils ; jamais un .nelmodel ni un GGUF local.
      if (!r) throw new Error(AGENT_LOCAL);
      if (!s.workingDirectory) throw new Error('Mode Agent : choisis d\'abord un dossier de travail (/dir).');
      await invoke('agent_generate', { provider: r.provider, model: r.model, history: g.history, message: g.question, dir: s.workingDirectory, options: genOptions() });
    } else if (r) await invoke('remote_generate', { provider: r.provider, model: r.model, history: g.history, message: g.question, options: genOptions() });
    else await invoke('generate', { history: g.history, message: g.question, options: genOptions() });
    return true;
  } catch (e) {
    S.gen = null;
    U.idle?.();
    if (g.kind !== 'regen') s.messages.pop();
    toast(errText(e), 'error');
    renderAll();
    return false;
  }
}

// p : { text, side, choices? } ; side "a" / "b" en mode comparaison.
export function onToken(p) {
  const g = S.gen;
  if (!g) return;
  const out = g.kind === 'compare' ? g[p.side] : g;
  if (g.reasoning && !g.thinkEnd && p.text) { g.thinkEnd = Date.now(); showReasoning(); }
  out.text += p.text;
  if (p.choices) out.tokens.push([p.text, p.choices.map(([t, pr]) => [t, +pr.toFixed(4)])]);
  const el = g.kind === 'compare' ? g.el?.querySelector(`[data-side=${p.side}]`) : g.el;
  if (el && S.current === g.session) {
    el.classList.remove('thinking');
    el.classList.add('streaming');
    el.querySelector('.body').replaceChildren(...richText(out.text.trimStart()));
    followEnd();
  }
}

export async function onDone(p) {
  const g = S.gen;
  if (!g) return;
  S.gen = null;
  const s = g.session;
  if (g.kind === 'compare') return onCompareDone(g, s, p);
  let text = (p.text ?? '').trim();
  // Mode Agent : les étapes restent dans la conversation même sans réponse finale (pour voir et annuler les écritures).
  if (p.agent?.steps?.length && (p.error || !text)) {
    if (p.error) toast('Agent : ' + p.error, 'error', 10000);
    text = text || (p.stopped ? '(arrêté)' : '(pas de réponse finale)');
    p.error = null;
  }
  if (p.limit) toast(`Agent : nombre maximal de tours atteint (${p.limit}). Augmente-le dans les Réglages si besoin.`, 'warning', 8000);
  if (p.error || !text) {
    if (g.kind === 'send') { s.messages.pop(); if (S.current === s) $('input').value ||= g.question; }
    toast(p.error ? 'Erreur pendant la réponse : ' + p.error : 'Le modèle n\'a rien répondu.', p.error ? 'error' : 'warning');
  } else {
    // La réflexion d'un modèle distant : gardée avec la réponse, jamais renvoyée au modèle (turnsOf ne prend que content).
    const thought = p.reasoning?.trim() ? { reasoning: p.reasoning.trim(), reasoningSeconds: p.reasoningSeconds ?? 0 } : { reasoning: undefined, reasoningSeconds: undefined };
    thought.agent = p.agent ?? undefined;
    if (g.kind === 'send') s.messages.push({ role: 'assistant', content: text, tokens: g.tokens.length ? g.tokens : undefined, ...thought });
    else {
      const versions = g.old.versions ? [...g.old.versions] : [g.old.content];
      versions.push(text);
      // Les probabilités ne suivent que la dernière version écrite (bodyEl vérifie qu'elles collent au texte).
      s.messages[g.index] = { ...g.old, content: text, versions, tokens: g.tokens.length ? g.tokens : g.old.tokens, ...thought };
    }
  }
  // Le plan de l'agent : le dernier, gardé avec la conversation.
  if (Array.isArray(p.plan) && p.plan.length) s.plan = { request: p.agent?.request, tasks: p.plan, date: localIso() };
  // Claude Agent : la session à reprendre, et le coût et la durée de la demande.
  if (p.claude && s.claudeAgent) {
    if (p.claude.sessionId) s.claudeAgent.sessionId = p.claude.sessionId;
    const last = s.messages.at(-1);
    if (last?.role === 'assistant') last.claude = { cost: p.claude.cost, durationMs: p.claude.durationMs, turns: p.claude.turns };
    s.claudeAgent.cost = (s.claudeAgent.cost ?? 0) + (p.claude.cost ?? 0);
  }
  if (text) { touch(s); await saveSession(s); }
  if (!p.error && p.tokens) {
    S.lastSpeed = `${p.tokens} tokens · ${(p.tokens / p.seconds).toFixed(1)} tokens/s${p.stopped ? ' · arrêtée' : ''}`;
  }
  if (p.claude) {
    S.lastSpeed = claudeCost(p.claude) + (p.stopped ? ' · arrêtée' : '');
  }
  renderAll();
}

export async function onCompareDone(g, s, p) {
  const a = (p.a.text ?? '').trim(), b = (p.b.text ?? '').trim();
  const error = p.a.error || p.b.error;
  if (error) toast('Erreur pendant la réponse : ' + error, 'error');
  if (!a && !b) {
    s.messages.pop();
    if (S.current === s) $('input').value ||= g.question;
    if (!error) toast('Les modèles n\'ont rien répondu.', 'warning');
  } else {
    const tokens = (x) => x.tokens.length ? x.tokens : undefined;
    s.messages.push({ role: 'assistant', content: a, model: s.compare.a, tokens: tokens(g.a), compare: { model: s.compare.b, content: b, tokens: tokens(g.b) } });
    touch(s);
    await saveSession(s);
  }
  renderAll();
}

export function stop() { if (S.gen) invoke('stop_generation'); }

// --- Réflexion (modèles distants) ------------------------------------------------------------------------

// Le bloc « Réflexion » repliable, au-dessus de la réponse ; ouvert pendant qu'elle s'écrit.
export function reasoningEl(text, seconds, live) {
  const label = live ? 'Réflexion…' : `Réflexion · ${Number(seconds ?? 0).toLocaleString('fr-CH', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} s`;
  return h('details', { class: 'reasoning', open: live }, h('summary', {}, icon('chevron-right'), label), h('div', { class: 'think' }, text));
}

// La réflexion en cours dans la réponse qui s'écrit (l'état replié ou déplié choisi est gardé).
export function showReasoning() {
  const g = S.gen;
  if (!g?.el || S.current !== g.session) return;
  const old = g.el.querySelector('.reasoning');
  const live = !g.thinkEnd;
  const el = reasoningEl(g.reasoning, (g.thinkEnd - g.thinkStart) / 1000, live);
  if (old && !live) el.open = false; else if (old) el.open = old.open;
  old ? old.replaceWith(el) : g.el.prepend(el);
  followEnd();
}

// --- Mode transparence -----------------------------------------------------------------------------------

export async function toggleTransparency() {
  try { S.settings = await invoke('save_settings', { changes: { transparency: !S.settings.transparency } }); } catch (e) { return toast(errText(e), 'error'); }
  toast(S.settings.transparency ? 'Transparence activée : survole les mots des prochaines réponses.' : 'Transparence désactivée.', '', 2500);
  renderHeader(); renderMessages();
}

// Probabilité du token écrit parmi ses 5 choix (0 s'il n'y est pas : tiré plus loin par top-k/top-p).
export const chosenProb = ([text, choices]) => choices.find(([t]) => t === text)?.[1] ?? 0;

// Le texte d'une réponse ; en mode transparence, un <span> par token, teinté selon la confiance.
export function bodyEl(content, tokens) {
  const body = h('div', { class: 'body' });
  if (!S.settings.transparency || !tokens || tokens.map(([t]) => t).join('').trim() !== content) { body.append(...richText(content)); return body; }
  let lead = true;
  tokens.forEach((tok, k) => {
    const text = lead ? tok[0].trimStart() : tok[0];
    if (!text) return;
    lead = false;
    const p = chosenProb(tok);
    body.append(h('span', { class: 'tok' + (p >= 0.6 ? ' sure' : p < 0.3 ? ' unsure' : ''), 'data-k': k }, text));
  });
  body.tokens = tokens;
  return body;
}

export const visible = (t) => t.replace(/\n/g, '↵').replace(/ /g, '·') || '∅';

// --- Mode comparaison ------------------------------------------------------------------------------------

export async function openCompare() {
  if (S.gen) return toast('Attends la fin de la réponse (ou Stop).', 'warning');
  if (S.models.length < 2) return toast('Il faut au moins deux modèles installés pour comparer.', 'warning');
  const select = (value) => {
    const el = h('select', { class: 'text-input' }, S.models.map((m) => h('option', { value: m.name }, m.name)));
    el.value = value;
    return el;
  };
  const a = select(S.model.name ?? S.models[0].name);
  const b = select(S.models.find((m) => m.name !== a.value).name);
  const body = [h('label', { class: 'field' }, h('div', { class: 'row' }, 'Modèle A'), a), h('label', { class: 'field' }, h('div', { class: 'row' }, 'Modèle B'), b),
    h('div', { class: 'hint' }, 'Chaque message part aux deux modèles ; les réponses s\'écrivent l\'une après l\'autre.')];
  if (!(await dialog('Conversation comparée', body, [{ label: 'Annuler', value: false }, { label: 'Comparer', value: true, primary: true }], a))) return;
  if (a.value === b.value) return toast('Choisis deux modèles différents.', 'warning');
  closeEdit();
  S.current = { ...newSession(), compare: { a: a.value, b: b.value } };
  renderAll();
  $('input').focus();
}

export async function vote(i, winner) {
  const s = S.current, m = s.messages[i];
  try { await invoke('arena_vote', { vote: { id: `${s.id}#${i}`, a: m.model, b: m.compare.model, winner, date: localIso() } }); } catch (e) { return toast(errText(e), 'error'); }
  m.vote = winner;
  await saveSession(s);
  renderMessages();
}

export function sideEl(side, model, content, tokens, won) {
  return h('div', { class: 'side' + (won ? ' won' : ''), 'data-side': side }, h('div', { class: 'who' }, `${side.toUpperCase()} · ${model}`), bodyEl(content || '(pas de réponse)', tokens));
}

export function compareEl(m, i) {
  const busy = !!S.gen;
  const btn = (winner, label) => h('button', { class: m.vote === winner ? 'on' : '', disabled: busy, onclick: () => vote(i, winner) }, label);
  return h('div', { class: 'msg compare' },
    h('div', { class: 'pair' }, sideEl('a', m.model, m.content, m.tokens, m.vote === 'a'), sideEl('b', m.compare.model, m.compare.content, m.compare.tokens, m.vote === 'b')),
    h('div', { class: 'votes' }, btn('a', [icon('chevron-left'), 'A est meilleur']), btn('tie', [icon('equal'), 'Égalité']), btn('b', ['B est meilleur', icon('chevron-right')])));
}

export function compareStreamingEl() {
  const g = S.gen, s = g.session.compare;
  const side = (k, model) => h('div', { class: 'side ' + (g[k].text ? 'streaming' : 'thinking'), 'data-side': k }, h('div', { class: 'who' }, `${k.toUpperCase()} · ${model}`), h('div', { class: 'body' }, g[k].text ? richText(g[k].text.trimStart()) : waiting('en attente…')));
  return h('div', { class: 'msg compare' }, h('div', { class: 'pair' }, side('a', s.a), side('b', s.b)));
}

// Classement : Elo (départ 1000, K = 32) rejoué dans l'ordre des votes, et pourcentage de victoires (égalité : ni l'un ni l'autre).
export function ranking(votes) {
  const r = {};
  const of = (m) => (r[m] ??= { name: m, elo: 1000, w: 0, t: 0, l: 0 });
  for (const v of [...votes].sort((x, y) => Date.parse(x.date) - Date.parse(y.date))) {
    const a = of(v.a), b = of(v.b);
    const sa = v.winner === 'a' ? 1 : v.winner === 'tie' ? 0.5 : 0;
    const delta = 32 * (sa - 1 / (1 + 10 ** ((b.elo - a.elo) / 400)));
    a.elo += delta; b.elo -= delta;
    if (sa === 0.5) { a.t++; b.t++; } else if (sa === 1) { a.w++; b.l++; } else { a.l++; b.w++; }
  }
  return Object.values(r).sort((x, y) => y.elo - x.elo);
}

export async function openLeaderboard() {
  const { votes } = await invoke('arena');
  const rows = ranking(votes);
  const body = rows.length
    ? h('table', { class: 'board' }, h('tr', {}, ['', 'Modèle', 'Score', 'Victoires', 'V / N / D'].map((t) => h('th', {}, t))),
      rows.map((m, k) => h('tr', {}, h('td', {}, k + 1), h('td', {}, m.name), h('td', {}, Math.round(m.elo)), h('td', {}, Math.round(100 * m.w / (m.w + m.t + m.l)) + ' %'), h('td', {}, `${m.w} / ${m.t} / ${m.l}`))))
    : h('p', {}, 'Pas encore de vote. Ctrl+Maj+N ouvre une conversation comparée.');
  dialog(`Classement · ${votes.length} vote(s)`, body, [{ label: 'Fermer', value: null, primary: true }]);
}

export function stepVersion(index, delta) {
  const s = S.current, m = s.messages[index];
  if (S.gen || !m.versions || m.versions.length < 2) return;
  const shown = Math.min(Math.max(m.versions.indexOf(m.content) + delta, 0), m.versions.length - 1);
  s.messages[index] = { ...m, content: m.versions[shown] };
  saveSession(s);
  renderMessages();
  refreshContext();
}   // index du message en modification

export function startEdit(index) {
  if (S.gen) return;
  UI.editing = index;
  renderMessages();
}

export function closeEdit() { UI.editing = null; }

export async function submitEdit(index, text) {
  if (!text.trim() || !canGenerate()) return;
  const s = S.current;
  s.messages.splice(index);   // la conversation repart de ce message
  UI.editing = null;
  await send(text);
}

// --- Affichage -------------------------------------------------------------------------------------------

export function renderAll() {
  renderSessions(); renderModels(); renderHeader(); renderMessages(); renderComposer(); renderStatus(); refreshContext(); renderPlan();
  renderProject(); refreshFiles();
}

export function renderSessions() {
  const q = fold($('search').value.trim());
  const has = (t) => fold(t).includes(q);
  const all = [...S.sessions]
    .filter((s) => !q || has(titleOf(s)) || s.messages.some((m) => has(m.content)))
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  // Rangées par projet : celles du projet affiché, ou toutes, avec le nom du projet au-dessus de chaque groupe.
  const { groups, grouped } = sessionsByProject(all);
  const ul = $('sessions');
  ul.replaceChildren();
  if (S.current && !S.current.messages.length && !q)
    ul.append(h('li', { class: 'active' }, h('span', { class: 'label' }, 'Nouvelle conversation')));
  for (const s of groups.flatMap((g) => g.sessions)) {
    if (grouped && !q && groups.find((g) => g.sessions[0] === s)) ul.append(h('li', { class: 'group', title: s.workingDirectory || '' }, icon('folder'), h('span', { class: 'label' }, projectName(s.workingDirectory))));
    const more = h('button', { class: 'more', title: 'Plus…', 'aria-label': 'Plus', onclick: (e) => { e.stopPropagation(); sessionMenu(s, e); } }, icon('ellipsis'));
    ul.append(h('li', {
      class: s === S.current ? 'active' : '', title: titleOf(s),
      onclick: () => openSession(s), oncontextmenu: (e) => { e.preventDefault(); sessionMenu(s, e); },
      ondblclick: () => renameSession(s),
    }, h('span', { class: 'label' }, s.compare ? icon('arrow-left-right') : s.claudeAgent ? icon('bot') : null, titleOf(s)), S.gen?.session === s ? h('span', { class: 'spinner' }) : h('span', { class: 'meta' }, relDate(s.date)), more));
  }
  if (!ul.children.length) ul.append(h('li', { class: 'none' }, q ? 'Aucun résultat.' : S.settings.currentProject ? 'Pas encore de conversation dans ce projet.' : 'Pas encore de conversation.'));
}

export function renderModels() {
  const ul = $('models');
  ul.replaceChildren();
  for (const m of S.models) {
    const active = m.name === S.model.name && !S.model.remote, loading = m.name === S.model.loading;
    const tip = [m.name, sizeText(m.bytes), m.parameters && `${m.parameters.toLocaleString('fr-CH')} paramètres`, m.blockSize && `contexte ${m.blockSize} tokens`, { 'weights.dat': 'poids TorchSharp (weights.dat)', gguf: 'modèle GGUF' }[m.weights] ?? 'poids safetensors', m.license && `licence ${m.license}`].filter(Boolean).join('\n');
    ul.append(h('li', {
      class: (active ? 'active ' : '') + (loading ? 'loading' : ''), title: tip,
      onclick: () => !active && loadModel(m.name), oncontextmenu: (e) => { e.preventDefault(); modelMenu(m, e); },
    }, h('span', { class: 'dot' }), h('span', { class: 'label' }, m.name), h('span', { class: 'meta' }, loading ? 'chargement…' : paramsText(m.parameters)),
    h('button', { class: 'more', title: 'Plus…', 'aria-label': 'Plus', onclick: (e) => { e.stopPropagation(); modelMenu(m, e); } }, icon('ellipsis'))));
  }
  for (const p of S.providers) for (const m of p.models ?? []) {
    const active = S.model.remote?.provider === p.id && S.model.remote?.model === m.id;
    const tip = [`${m.label ?? m.id} · ${p.name}`, p.url, m.contextLength && `contexte ${m.contextLength} tokens`, m.temperature !== undefined && `température ${m.temperature}`,
      m.topP !== undefined && `top-p ${m.topP}`, m.maxTokens && `max ${m.maxTokens} tokens`].filter(Boolean).join('\n');
    ul.append(h('li', { class: 'remote' + (active ? ' active' : ''), title: tip, 'data-provider': p.id, 'data-model': m.id, onclick: () => !active && selectRemote(p, m) },
      h('span', { class: 'dot' }), h('span', { class: 'label' }, m.id), h('span', { class: 'badge' }, 'réseau'), h('span', { class: 'meta' }, p.name)));
  }
  if (!S.models.length && !S.providers.some((p) => p.models?.length)) ul.append(h('li', { class: 'none', onclick: () => openCatalog() }, 'Aucun modèle. Glisse un .nelmodel ou un .gguf ici, ou ouvre le catalogue ', icon('download'), '.'));
}

export function renderHeader() {
  const s = S.current;
  $('title').textContent = titleOf(s);
  const dir = s.workingDirectory || '';
  $('folder-name').textContent = dir ? dir.split(/[\\/]/).filter(Boolean).pop() || dir : 'aucun dossier';
  $('folder-chip').title = 'Dossier de travail : ' + (dir || '(aucun)') + '\nClic : changer';
  document.title = `${titleOf(s)} — Nel Code`;
  $('compare-chip').hidden = !s.compare;
  $('claude-chip').hidden = !s.claudeAgent;
  if (s.claudeAgent) $('claude-chip').replaceChildren(icon('bot'), h('span', {}, `Claude Agent${s.claudeAgent.cost ? ' · ' + money(s.claudeAgent.cost) : ''}`));
  $('agent-btn').hidden = !!s.claudeAgent;
  if (s.compare) $('compare-chip').replaceChildren(`A ${s.compare.a}`, icon('arrow-left-right'), h('span', {}, `B ${s.compare.b}`));
  $('transp-btn').classList.toggle('on', !!S.settings.transparency);
  $('agent-btn').classList.toggle('on', !!s.agent);
  refreshNelcode();
  renderPlan();
}

export function followEnd() {
  const sc = $('scroller');
  if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160) sc.scrollTop = sc.scrollHeight;
}

export function actionButton(label, title, onclick, disabled = false) {
  return h('button', { title, onclick, disabled }, label);
}

export function renderMessages() {
  const s = S.current, box = $('messages'), g = S.gen?.session === s ? S.gen : null;
  box.replaceChildren();
  $('empty').hidden = s.messages.length > 0 || !!g;
  box.classList.toggle('wide', !!s.compare);
  $('tip').hidden = true;
  // Les tours que le modèle ne voit plus (contexte plein) sont grisés.
  const turns = turnsOf(s.messages).length;
  const fadedTurns = S.context && !g && !s.compare ? Math.max(0, turns - S.context.keptTurns) : 0;
  const fadedEnd = fadedTurns * 2;
  s.messages.forEach((m, i) => {
    if (fadedEnd && i === fadedEnd) box.append(h('div', { class: 'faded-sep' }, 'au-dessus : hors de la mémoire du modèle'));
    if (g?.kind === 'regen' && i === g.index) return box.append(g.el = streamingEl());
    box.append(m.compare ? compareEl(m, i) : messageEl(m, i, i < fadedEnd));
  });
  if (g?.kind === 'send') box.append(g.el = streamingEl());
  if (g?.kind === 'compare') box.append(g.el = compareStreamingEl());
  if (g) { const sc = $('scroller'); sc.scrollTop = sc.scrollHeight; }
}

export const waiting = (text) => h('span', { class: 'waiting' }, icon('asterisk'), text);

export function streamingEl() {
  const g = S.gen;
  return h('div', { class: 'msg assistant ' + (g.text ? 'streaming' : 'thinking') },
    g.reasoning ? reasoningEl(g.reasoning, ((g.thinkEnd ?? Date.now()) - g.thinkStart) / 1000, !g.thinkEnd) : null,
    g.steps.length ? stepsEl(g.steps, null) : null,
    h('div', { class: 'body' }, g.text ? richText(g.text.trimStart()) : waiting('réfléchit…')));
}

export function messageEl(m, i, faded) {
  const user = m.role === 'user';
  const el = h('div', { class: `msg ${user ? 'user' : 'assistant'}${faded ? ' faded' : ''}` });
  if (user) el.append(h('span', { class: 'marker' }, icon('chevron-right')));
  if (user && UI.editing === i) {
    const ta = h('textarea', { class: 'edit-box', spellcheck: 'false' });
    ta.value = m.content;
    const go = () => submitEdit(i, ta.value);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
      if (e.key === 'Escape') { e.stopPropagation(); closeEdit(); renderMessages(); }
    });
    el.append(ta, h('div', { class: 'edit-actions' },
      h('button', { class: 'btn', onclick: () => { closeEdit(); renderMessages(); } }, 'Annuler'),
      h('button', { class: 'btn primary', onclick: go }, 'Envoyer')));
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); autoGrow(ta); }, 0);
    return el;
  }
  if (!user && m.reasoning) el.append(reasoningEl(m.reasoning, m.reasoningSeconds, false));
  if (!user && m.agent?.steps?.length) el.append(stepsEl(m.agent.steps, m));
  el.append(user ? h('div', { class: 'body' }, richText(m.content)) : bodyEl(m.content, m.tokens));
  const busy = !!S.gen;
  const acts = h('div', { class: 'actions' });
  acts.append(actionButton([icon('copy'), 'Copier'], 'Copier le message', async (e) => {
    const b = e.currentTarget;
    await navigator.clipboard.writeText(m.content);
    b.replaceChildren(icon('check'), 'Copié'); setTimeout(() => b.replaceChildren(icon('copy'), 'Copier'), 1200);
  }));
  if (user && !S.current.claudeAgent) acts.append(actionButton([icon('pencil'), 'Modifier'], 'Modifier et renvoyer (la suite est retirée)', () => startEdit(i), busy));
  else {
    const prev = S.current.messages[i - 1];
    if (m.claude) acts.append(h('span', { class: 'claude-cost', title: 'Coût estimé par l\'outil claude, et durée de la demande' }, claudeCost(m.claude)));
    if (prev?.role === 'user' && !S.current.compare && !S.current.claudeAgent) acts.append(actionButton([icon('refresh-cw'), 'Régénérer'], 'Nouvelle réponse, gardée comme une version de plus', () => regenerate(i), busy));
    if (m.agent?.checkpoint) acts.append(actionButton([icon('undo-2'), 'Revenir à avant cette demande'], 'Remettre les fichiers du projet dans leur état d\'avant cette demande (point de restauration git)', () => restoreCheckpoint(i), busy));
    if (m.versions?.length > 1) {
      const at = m.versions.indexOf(m.content);
      acts.append(h('span', { class: 'versions' },
        actionButton(icon('chevron-left'), 'Version précédente', () => stepVersion(i, -1), busy || at <= 0),
        `${at + 1}/${m.versions.length}`,
        actionButton(icon('chevron-right'), 'Version suivante', () => stepVersion(i, +1), busy || at >= m.versions.length - 1)));
      acts.classList.add('keep');
    }
  }
  el.append(acts);
  return el;
}

// Mode Agent dans un dépôt git : le dossier reprend l'état du point de restauration pris avant la demande de la
// réponse i. Les écritures acceptées de cette demande et des suivantes deviennent « annulée » ; les messages restent.
export async function restoreCheckpoint(i) {
  if (S.gen) return toast('Attends la fin de la réponse (ou Stop).', 'warning');
  const s = S.current, c = s.messages[i].agent.checkpoint;
  if (!(await confirmDialog('Revenir à avant cette demande',
    `Tous les fichiers du projet (${c.dir}) reviennent à leur état d'avant cette demande, y compris les modifications faites depuis (à la main ou par les demandes suivantes), et les fichiers créés depuis sont supprimés. Les fichiers ignorés par .gitignore et les fichiers protégés (.env, clés…) ne sont pas touchés. La conversation reste telle quelle.`,
    'Revenir à avant cette demande', true))) return;
  try { await invoke('agent_restore', { dir: c.dir, id: c.id }); } catch (e) { return toast('Restauration impossible : ' + errText(e), 'error', 8000); }
  for (const m of s.messages.slice(i)) for (const st of m.agent?.steps ?? []) if ((st.kind === 'write' || st.kind === 'edit') && st.status === 'accepted') st.status = 'undone';
  toast('Fichiers remis dans leur état d\'avant cette demande.', 'success');
  await saveSession(s);
  renderMessages();
  refreshFiles(true);
}

export function renderComposer() {
  const b = $('send');
  b.classList.toggle('stop', !!S.gen);
  b.replaceChildren(icon(S.gen ? 'square' : 'arrow-up'));
  b.title = S.gen ? 'Arrêter (Échap)' : 'Envoyer (Entrée)';
  b.setAttribute('aria-label', S.gen ? 'Arrêter' : 'Envoyer');
}

export function renderStatus() {
  const st = $('status');
  st.replaceChildren();
  if (S.model.loading) st.append(h('span', { class: 'spinner' }), `Chargement de ${S.model.loading}…`);
  else if (S.gen?.kind === 'compare') st.append(h('span', { class: 'spinner' }), `${S.gen.side.toUpperCase()} · ${S.gen.session.compare[S.gen.side]} écrit…  Échap pour arrêter`);
  else if (S.gen) st.append(h('span', { class: 'spinner' }), `${S.model.name} écrit…  Échap pour arrêter`);
  else if (S.bench) st.append(h('span', { class: 'spinner' }), `Test de vitesse · ${S.bench}…`);
  else if (S.current?.claudeAgent) st.append(`Claude Agent${S.claudeStatus?.model ? ' · ' + S.claudeStatus.model : ''} · ${S.claudeStatus?.permissionMode === 'acceptEdits' ? 'modifications de fichiers acceptées' : 'rien d\'automatique'}${S.lastSpeed ? ' · ' + S.lastSpeed : ''}`);
  else if (S.model.name) st.append(`${S.model.name} · ${S.model.device ?? 'CPU'}${S.lastSpeed ? ' · ' + S.lastSpeed : ''}`);
  else st.append('aucun modèle chargé');
  if (S.server.port) st.append(h('span', { class: 'server-on', title: `Serveur local (API OpenAI) : http://127.0.0.1:${S.server.port}/v1` },
    S.server.busy ? h('span', { class: 'spinner' }) : h('span', { class: 'dot' }), S.server.busy ? `API · répond…` : `API :${S.server.port}`));
}

export function refreshContext() {
  clearTimeout(UI.contextTimer);
  UI.contextTimer = setTimeout(async () => {
    const fill = $('context-fill');
    if (S.current?.claudeAgent) { S.context = null; $('context-text').textContent = 'contexte géré par Claude Agent'; fill.style.width = '0'; return; }
    if (!S.model.name) { S.context = null; $('context-text').textContent = '— / — tokens'; fill.style.width = '0'; return; }
    if (S.model.remote) {
      // Pas de tokenizer pour un modèle distant : environ 4 caractères par token.
      const chars = turnsOf(S.current.messages).flat().join('').length + (await expandMentions($('input').value, true)).length;
      const n = Math.ceil(chars / 4), ctx = S.model.blockSize;
      S.context = null;
      fill.style.width = ctx ? Math.min(100, 100 * n / ctx) + '%' : '0';
      fill.className = ctx && n > ctx ? 'full' : ctx && n > 0.8 * ctx ? 'warn' : '';
      $('context-text').textContent = ctx ? `≈ ${n} / ${ctx} tokens` : `≈ ${n} tokens`;
      $('context').title = 'Estimation (environ 4 caractères par token) : le modèle distant compte lui-même.';
      return;
    }
    try {
      const c = await invoke('context_info', { history: turnsOf(S.current.messages), message: await expandMentions($('input').value, true) });
      const changed = S.context?.keptTurns !== c.keptTurns;
      S.context = c;
      const ratio = (c.tokens + c.reserve) / c.blockSize;
      fill.style.width = Math.min(100, 100 * c.tokens / c.blockSize) + '%';
      fill.className = ratio > 1 ? 'full' : ratio > 0.8 ? 'warn' : '';
      $('context-text').textContent = `${c.tokens} / ${c.blockSize} tokens`;
      $('context').title = `Le modèle verra ${c.tokens} tokens au prochain message (contexte max ${c.blockSize}, dont ${c.reserve} gardés pour la réponse).\n${c.keptTurns} échange(s) précédent(s) en mémoire.${ratio > 1 ? '\nTrop long : le modèle n\'en lira que la fin.' : ''}`;
      if (changed && !S.gen && UI.editing === null) renderMessages();
    } catch { /* modèle en cours de changement */ }
  }, 150);
}

export function sessionMenu(s, e) {
  showMenu(e, [
    { label: 'Ouvrir', run: () => openSession(s) },
    { label: 'Renommer…', run: () => renameSession(s) },
    { label: 'Exporter en Markdown…', run: () => exportSession(s, true) },
    { label: 'Exporter en texte…', run: () => exportSession(s, false) },
    { label: 'Dossier de travail…', run: () => chooseFolder(s) },
    '-',
    { label: 'Supprimer…', danger: true, run: () => deleteSession(s) },
  ]);
}

export function modelMenu(m, e) {
  showMenu(e, [
    { label: m.name === S.model.name ? 'Recharger' : 'Charger', run: () => loadModel(m.name) },
    '-',
    { label: 'Supprimer…', danger: true, run: () => deleteModel(m.name) },
  ]);
}

export async function openFolder() {
  try { await invoke('open_folder', { path: S.current.workingDirectory || '' }); } catch (e) { toast(errText(e), 'error'); }
}

// --- Saisie et raccourcis --------------------------------------------------------------------------------

export function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; }

export async function submitInput() {
  const input = $('input');
  const line = input.value.trim();
  if (!line) return;
  if (line.startsWith('/')) {
    input.value = ''; autoGrow(input); updateSuggest();
    return runCommand(line);
  }
  if (!canGenerate()) return;
  const text = await expandMentions(line);
  if (text === null) return;
  if (text !== line && S.model.name && !S.current.compare) {
    try {
      const c = await invoke('context_info', { history: turnsOf(S.current.messages), message: text });
      if (c.tokens + c.reserve > c.blockSize && !(await confirmDialog('Le message dépasse le contexte', `Avec ses fichiers, le message fait ${c.tokens.toLocaleString('fr-CH')} tokens, et le modèle n'en voit que ${c.blockSize.toLocaleString('fr-CH')} (dont ${c.reserve} pour la réponse) : il n'en lira que la fin.`, 'Envoyer quand même'))) return;
    } catch { /* modèle en cours de changement */ }
  }
  input.value = ''; autoGrow(input); refreshContext();
  if (!(await send(text))) input.value = line;
}

export function onDrop(paths) {
  $('drop').hidden = true;
  const pkg = paths.find((p) => /\.(nelmodel|gguf)$/i.test(p));
  if (pkg) importFlow(pkg);
  else if (paths.length) toast('Seuls les fichiers .nelmodel et .gguf peuvent être importés.', 'warning');
}
