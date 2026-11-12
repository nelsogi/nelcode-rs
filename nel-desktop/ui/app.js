// Nel Code Desktop : l'interface. Tout le calcul (modèle, fichiers) est dans le Rust ; ici, l'affichage.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

const S = {
  info: {},            // app_info : dossiers
  settings: {},        // settings.json
  sessions: [],        // toutes les conversations (format de Nel Code C#)
  current: null,       // la conversation affichée
  models: [],
  model: { name: null, loading: null, blockSize: null },
  gen: null,           // la réponse en cours : { session, kind, index, el, text }
  context: null,       // { tokens, blockSize, keptTurns }
};

// --- Petits outils ---------------------------------------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
// Comme Nel Code C# : "2026-11-11_09-25-22-218"
const newId = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
// Date locale avec décalage, comme System.Text.Json : "2026-11-11T09:25:44.282+01:00"
function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const errText = (e) => String(e?.message ?? e);
const sizeText = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + ' Go' : (b / 1e6).toFixed(0) + ' Mo';
const paramsText = (p) => p ? (p / 1e6).toFixed(1) + ' M' : '';

function relDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days === 1) return 'hier';
  if (days < 7) return d.toLocaleDateString('fr-CH', { weekday: 'short' });
  return d.toLocaleDateString('fr-CH', { day: 'numeric', month: 'short' });
}

function toast(text, kind = '', ms = 4500) {
  const el = h('div', { class: 'toast ' + kind }, kind === 'error' ? [icon('circle-alert'), h('div', {}, text)] : text);
  $('toasts').append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

// Thème (settings.json, partagé avec Nel Code C#) et couleur d'accent : des attributs sur <html>, lus par style.css.
function applyTheme() {
  const d = document.documentElement.dataset;
  d.theme = S.settings.theme === 'light' ? 'light' : 'dark';
  d.accent = S.settings.accent === 'orange' ? 'orange' : 'red';
}

// --- Conversations ---------------------------------------------------------------------------------------

const TITLE_LENGTH = 40;
// Comme Sidebar.TitleOf de Nel Code C#.
function titleOf(s) {
  if (s.title && s.title.trim()) return s.title;
  const first = (s.messages.find((m) => m.role === 'user')?.content ?? '').replace(/\s+/g, ' ').trim();
  if (!first) return 'Nouvelle conversation';
  if (first.length <= TITLE_LENGTH) return first;
  const cut = first.lastIndexOf(' ', TITLE_LENGTH);
  return first.slice(0, cut > TITLE_LENGTH / 2 ? cut : TITLE_LENGTH) + '…';
}

// Les tours (question, réponse) de messages[0..end], comme Session.Turns : par paires, user puis assistant.
function turnsOf(messages, end = messages.length) {
  const turns = [];
  for (let i = 0; i + 1 < end; i += 2)
    if (messages[i].role === 'user' && messages[i + 1].role === 'assistant') turns.push([messages[i].content, messages[i + 1].content]);
  return turns;
}

function newSession() {
  return {
    id: newId(),
    model: S.model.name ?? '',
    workingDirectory: S.current?.workingDirectory || S.info.home || '',
    date: localIso(),
    messages: [],
  };
}

async function saveSession(s) {
  if (!s.messages.length) return;   // comme en C# : une conversation vide n'est pas gardée
  try {
    await invoke('save_session', { session: s });
    if (!S.sessions.includes(s)) S.sessions.push(s);
  } catch (e) { toast('Sauvegarde impossible : ' + errText(e), 'error'); }
  renderSessions();
}

function touch(s) { s.date = localIso(); if (s.compare) s.model = s.compare.a; else if (S.model.name) s.model = S.model.name; }

function openSession(s) {
  if (S.current === s) return;
  closeEdit();
  S.current = s;
  renderAll();
  $('input').focus();
}

function startNew() {
  if (S.current && !S.current.messages.length && !S.current.compare) { $('input').focus(); return; }
  openSession(newSession());
}

async function deleteSession(s) {
  const ok = await confirmDialog('Supprimer la conversation ?', `« ${titleOf(s)} » sera supprimée définitivement.`, 'Supprimer', true);
  if (!ok) return;
  if (S.gen?.session === s) await invoke('stop_generation');
  try { await invoke('delete_session', { id: s.id }); } catch (e) { return toast(errText(e), 'error'); }
  S.sessions = S.sessions.filter((x) => x !== s);
  if (S.current === s) { S.current = null; openSession(newSession()); } else renderSessions();
}

async function renameSession(s) {
  const name = await promptDialog('Renommer la conversation', titleOf(s), 'Laisser vide : titre tiré du premier message.');
  if (name === null) return;
  if (name.trim()) s.title = name.trim(); else delete s.title;
  await saveSession(s);
  renderHeader();
}

// Comme Export de Nel Code C# : "> question" / "● réponse", ou Markdown.
async function exportSession(s, markdown) {
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

async function chooseFolder(s = S.current) {
  const path = await invoke('pick_folder', { start: s.workingDirectory || S.info.home || '' });
  if (!path) return;
  s.workingDirectory = path;
  await saveSession(s);
  renderHeader();
  toast('Dossier de travail : ' + path);
}

// --- Modèles ---------------------------------------------------------------------------------------------

async function refreshModels() {
  S.models = await invoke('list_models');
  renderModels();
}

async function loadModel(name) {
  if (S.model.loading) return toast(`Chargement de ${S.model.loading} en cours…`, 'warning');
  if (S.gen) return toast('Attends la fin de la réponse (ou Stop).', 'warning');
  try { await invoke('load_model', { name }); } catch (e) { toast(errText(e), 'error'); }
}

async function deleteModel(name) {
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
async function importFlow(path) {
  if (!path) path = await invoke('pick_nelmodel');
  if (!path) return;
  if (!/^[a-zA-Z]:[\\/]|^\\\\/.test(path) && S.current?.workingDirectory) path = S.current.workingDirectory.replace(/[\\/]$/, '') + '\\' + path;
  let pkg;
  try { pkg = await invoke('inspect_package', { path }); } catch (e) { return toast('Import refusé : ' + errText(e), 'error', 8000); }
  const i = pkg.info;
  const nameInput = h('input', { class: 'text-input', value: pkg.name, spellcheck: 'false' });
  const warn = h('div', { class: 'warn-text' });
  const rows = [
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

// --- Génération ------------------------------------------------------------------------------------------

function genOptions() {
  const s = S.settings;
  return { temperature: s.temperature, topK: s.topK, topP: s.topP, maxReplyTokens: s.maxReplyTokens, transparency: !!s.transparency };
}

function canGenerate() {
  if (S.gen) return false;
  if (U.state === 'installing') { toast('Installation de la mise à jour en cours…', 'warning'); return false; }
  if (!S.model.name && !S.current?.compare) {
    toast(S.model.loading ? `Le modèle ${S.model.loading} se charge…` : 'Aucun modèle chargé : choisis-en un à gauche, ou importe un .nelmodel.', 'warning');
    return false;
  }
  return true;
}

async function send(text) {
  text = text.trim();
  if (!text || !canGenerate()) return false;
  const s = S.current;
  const history = turnsOf(s.messages);
  s.messages.push({ role: 'user', content: text });
  if (s.compare) return startGen(s, { kind: 'compare', question: text, history, historyB: turnsOf(s.messages.map((m) => m.compare ? { role: 'assistant', content: m.compare.content } : m), s.messages.length - 1), a: { text: '', tokens: [] }, b: { text: '', tokens: [] }, side: 'a' });
  return startGen(s, { kind: 'send', index: s.messages.length, question: text, history });
}

async function regenerate(index) {
  const s = S.current;
  if (!canGenerate() || s.compare || s.messages[index]?.role !== 'assistant') return;
  const question = s.messages[index - 1].content;
  s.messages.splice(index + 1);          // la suite de la conversation est retirée
  await saveSession(s);
  return startGen(s, { kind: 'regen', index, question, history: turnsOf(s.messages, index - 1), old: s.messages[index] });
}

async function startGen(s, g) {
  S.gen = { ...g, session: s, text: '', tokens: [] };
  renderMessages();
  renderComposer();
  renderStatus();
  try {
    if (g.kind === 'compare')
      await invoke('compare_generate', { a: s.compare.a, b: s.compare.b, historyA: g.history, historyB: g.historyB, message: g.question, options: genOptions() });
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
function onToken(p) {
  const g = S.gen;
  if (!g) return;
  const out = g.kind === 'compare' ? g[p.side] : g;
  out.text += p.text;
  if (p.choices) out.tokens.push([p.text, p.choices.map(([t, pr]) => [t, +pr.toFixed(4)])]);
  const el = g.kind === 'compare' ? g.el?.querySelector(`[data-side=${p.side}]`) : g.el;
  if (el && S.current === g.session) {
    el.classList.remove('thinking');
    el.classList.add('streaming');
    el.querySelector('.body').textContent = out.text.trimStart();
    followEnd();
  }
}

async function onDone(p) {
  const g = S.gen;
  if (!g) return;
  S.gen = null;
  const s = g.session;
  if (g.kind === 'compare') return onCompareDone(g, s, p);
  const text = (p.text ?? '').trim();
  if (p.error || !text) {
    if (g.kind === 'send') { s.messages.pop(); if (S.current === s) $('input').value ||= g.question; }
    toast(p.error ? 'Erreur pendant la réponse : ' + p.error : 'Le modèle n\'a rien répondu.', p.error ? 'error' : 'warning');
  } else if (g.kind === 'send') {
    s.messages.push({ role: 'assistant', content: text, tokens: g.tokens.length ? g.tokens : undefined });
  } else {
    const versions = g.old.versions ? [...g.old.versions] : [g.old.content];
    versions.push(text);
    // Les probabilités ne suivent que la dernière version écrite (bodyEl vérifie qu'elles collent au texte).
    s.messages[g.index] = { ...g.old, content: text, versions, tokens: g.tokens.length ? g.tokens : g.old.tokens };
  }
  if (text) { touch(s); await saveSession(s); }
  if (!p.error && p.tokens) {
    S.lastSpeed = `${p.tokens} tokens · ${(p.tokens / p.seconds).toFixed(1)} tokens/s${p.stopped ? ' · arrêtée' : ''}`;
  }
  renderAll();
}

async function onCompareDone(g, s, p) {
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

function stop() { if (S.gen) invoke('stop_generation'); }

// --- Mode transparence -----------------------------------------------------------------------------------

async function toggleTransparency() {
  try { S.settings = await invoke('save_settings', { changes: { transparency: !S.settings.transparency } }); } catch (e) { return toast(errText(e), 'error'); }
  toast(S.settings.transparency ? 'Transparence activée : survole les mots des prochaines réponses.' : 'Transparence désactivée.', '', 2500);
  renderHeader(); renderMessages();
}

// Probabilité du token écrit parmi ses 5 choix (0 s'il n'y est pas : tiré plus loin par top-k/top-p).
const chosenProb = ([text, choices]) => choices.find(([t]) => t === text)?.[1] ?? 0;

// Le texte d'une réponse ; en mode transparence, un <span> par token, teinté selon la confiance.
function bodyEl(content, tokens) {
  const body = h('div', { class: 'body' });
  if (!S.settings.transparency || !tokens || tokens.map(([t]) => t).join('').trim() !== content) { body.textContent = content; return body; }
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

const visible = (t) => t.replace(/\n/g, '↵').replace(/ /g, '·') || '∅';

document.addEventListener('mouseover', (e) => {
  const span = e.target.closest?.('.tok'), tip = $('tip');
  if (!span) { tip.hidden = true; return; }
  const tok = span.parentElement.tokens[span.dataset.k];
  tip.replaceChildren(...tok[1].map(([t, p]) => h('div', { class: 'row' + (t === tok[0] ? ' chosen' : '') },
    h('span', { class: 'name' }, visible(t)), h('div', { class: 'bar' }, h('div', { style: `width:${(p * 100).toFixed(1)}%` })), h('span', { class: 'pct' }, (p * 100).toFixed(1) + ' %'))));
  if (!tok[1].some(([t]) => t === tok[0])) tip.append(h('div', { class: 'row chosen' }, h('span', { class: 'name' }, visible(tok[0])), h('span', {}, 'tiré hors des 5'), h('span')));
  tip.hidden = false;
  const r = span.getBoundingClientRect(), t = tip.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(r.left, innerWidth - t.width - 8)) + 'px';
  tip.style.top = (r.bottom + 6 + t.height > innerHeight ? r.top - t.height - 6 : r.bottom + 6) + 'px';
});

// --- Mode comparaison ------------------------------------------------------------------------------------

async function openCompare() {
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

async function vote(i, winner) {
  const s = S.current, m = s.messages[i];
  try { await invoke('arena_vote', { vote: { id: `${s.id}#${i}`, a: m.model, b: m.compare.model, winner, date: localIso() } }); } catch (e) { return toast(errText(e), 'error'); }
  m.vote = winner;
  await saveSession(s);
  renderMessages();
}

function sideEl(side, model, content, tokens, won) {
  return h('div', { class: 'side' + (won ? ' won' : ''), 'data-side': side }, h('div', { class: 'who' }, `${side.toUpperCase()} · ${model}`), bodyEl(content || '(pas de réponse)', tokens));
}

function compareEl(m, i) {
  const busy = !!S.gen;
  const btn = (winner, label) => h('button', { class: m.vote === winner ? 'on' : '', disabled: busy, onclick: () => vote(i, winner) }, label);
  return h('div', { class: 'msg compare' },
    h('div', { class: 'pair' }, sideEl('a', m.model, m.content, m.tokens, m.vote === 'a'), sideEl('b', m.compare.model, m.compare.content, m.compare.tokens, m.vote === 'b')),
    h('div', { class: 'votes' }, btn('a', [icon('chevron-left'), 'A est meilleur']), btn('tie', [icon('equal'), 'Égalité']), btn('b', ['B est meilleur', icon('chevron-right')])));
}

function compareStreamingEl() {
  const g = S.gen, s = g.session.compare;
  const side = (k, model) => h('div', { class: 'side ' + (g[k].text ? 'streaming' : 'thinking'), 'data-side': k }, h('div', { class: 'who' }, `${k.toUpperCase()} · ${model}`), h('div', { class: 'body' }, g[k].text ? g[k].text.trimStart() : waiting('en attente…')));
  return h('div', { class: 'msg compare' }, h('div', { class: 'pair' }, side('a', s.a), side('b', s.b)));
}

// Classement : Elo (départ 1000, K = 32) rejoué dans l'ordre des votes, et pourcentage de victoires (égalité : ni l'un ni l'autre).
function ranking(votes) {
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

async function openLeaderboard() {
  const { votes } = await invoke('arena');
  const rows = ranking(votes);
  const body = rows.length
    ? h('table', { class: 'board' }, h('tr', {}, ['', 'Modèle', 'Score', 'Victoires', 'V / N / D'].map((t) => h('th', {}, t))),
      rows.map((m, k) => h('tr', {}, h('td', {}, k + 1), h('td', {}, m.name), h('td', {}, Math.round(m.elo)), h('td', {}, Math.round(100 * m.w / (m.w + m.t + m.l)) + ' %'), h('td', {}, `${m.w} / ${m.t} / ${m.l}`))))
    : h('p', {}, 'Pas encore de vote. Ctrl+Maj+N ouvre une conversation comparée.');
  dialog(`Classement · ${votes.length} vote(s)`, body, [{ label: 'Fermer', value: null, primary: true }]);
}

function stepVersion(index, delta) {
  const s = S.current, m = s.messages[index];
  if (S.gen || !m.versions || m.versions.length < 2) return;
  const shown = Math.min(Math.max(m.versions.indexOf(m.content) + delta, 0), m.versions.length - 1);
  s.messages[index] = { ...m, content: m.versions[shown] };
  saveSession(s);
  renderMessages();
  refreshContext();
}

// --- Mises à jour (tauri-plugin-updater) -----------------------------------------------------------------

const UPDATE_EVERY = 864e5;   // vérification automatique : au plus une fois par jour
// state : idle | available | downloading | waiting (téléchargée, une réponse s'écrit) | installing
const U = { state: 'idle', update: null, checking: false, idle: null };

function updateError(e) {
  const t = errText(e);
  if (/signature/i.test(t)) return 'Mise à jour refusée : signature invalide.';
  // « Could not fetch a valid release JSON » : hors ligne, ou latest.json absent de la dernière release.
  if (/release JSON|request|connect|dns|resolve|network|timed? ?out/i.test(t)) return 'Mises à jour : impossible de joindre GitHub (pas de connexion ?).';
  return 'Mise à jour impossible : ' + t;
}

// manual : depuis la palette ou les réglages (dit aussi « à jour », et l'erreur est un vrai toast d'erreur).
async function checkUpdate(manual) {
  if (U.checking || (U.state !== 'idle' && U.state !== 'available')) return;
  U.checking = true;
  try {
    const update = await window.__TAURI__.updater.check();
    if (update) { U.update = update; U.state = 'available'; renderUpdate(); }
    else if (manual) toast(`Nel Code ${S.info.version} est à jour.`, 'success', 3000);
  } catch (e) {
    toast(updateError(e), manual ? 'error' : '', manual ? 6000 : 3000);
  } finally { U.checking = false; }
}

// Télécharge, attend la fin de la réponse en cours (jamais d'installation pendant une génération), installe, redémarre.
async function installUpdate() {
  const u = U.update;
  let got = 0, total = 0;
  U.state = 'downloading'; renderUpdate();
  try {
    await u.download((ev) => {
      if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
      else if (ev.event === 'Progress') {
        got += ev.data.chunkLength;
        $('update-fill').style.width = total ? (100 * got / total).toFixed(1) + '%' : '100%';
        $('update-text').textContent = total ? `Téléchargement… ${Math.floor(100 * got / total)} %` : `Téléchargement… ${sizeText(got)}`;
      }
    });
    if (S.gen) { U.state = 'waiting'; renderUpdate(); await new Promise((r) => (U.idle = () => { U.idle = null; r(); })); }
    U.state = 'installing'; renderUpdate();
    await u.install();                          // Windows : l'installateur (passif) ferme puis relance Nel Code
    await window.__TAURI__.process.relaunch();
  } catch (e) {
    U.state = 'available'; renderUpdate();
    toast(updateError(e), 'error', 8000);
  }
}

function renderUpdate() {
  const box = $('update'), u = U.update;
  box.hidden = !u || U.state === 'idle';
  if (box.hidden) return;
  // Les notes : la section du CHANGELOG mise en tête de la release (avant « --- »), sans la mise en forme Markdown.
  const notes = (u.body ?? '').split(/\n---/)[0].replace(/\*\*|`|^#+ /gm, '').replace(/\n{2,}/g, '\n').trim();
  const status = { downloading: 'Téléchargement…', waiting: 'Téléchargée : installation à la fin de la réponse en cours…', installing: 'Installation… Nel Code va redémarrer.' }[U.state];
  box.replaceChildren(
    h('div', { class: 'head' }, icon('download'), h('b', {}, `Nel Code ${u.version} est disponible`), h('span', { class: 'meta' }, `version actuelle ${u.currentVersion}`)),
    notes ? h('div', { class: 'notes' }, notes) : '',
    status
      ? h('div', { class: 'progress' }, h('div', { class: 'bar' }, h('div', { id: 'update-fill', style: U.state === 'downloading' ? 'width:0' : 'width:100%' })), h('span', { id: 'update-text' }, status))
      : h('div', { class: 'buttons' },
        h('button', { class: 'btn', onclick: () => { U.state = 'idle'; renderUpdate(); } }, 'Plus tard'),
        h('button', { class: 'btn primary', onclick: installUpdate }, icon('download'), 'Installer')));
}

// --- Modifier un message ---------------------------------------------------------------------------------

let editing = null;   // index du message en modification

function startEdit(index) {
  if (S.gen) return;
  editing = index;
  renderMessages();
}

function closeEdit() { editing = null; }

async function submitEdit(index, text) {
  if (!text.trim() || !canGenerate()) return;
  const s = S.current;
  s.messages.splice(index);   // la conversation repart de ce message
  editing = null;
  await send(text);
}

// --- Affichage -------------------------------------------------------------------------------------------

function renderAll() {
  renderSessions(); renderModels(); renderHeader(); renderMessages(); renderComposer(); renderStatus(); refreshContext();
}

function renderSessions() {
  const q = fold($('search').value.trim());
  const has = (t) => fold(t).includes(q);
  const list = [...S.sessions]
    .filter((s) => !q || has(titleOf(s)) || s.messages.some((m) => has(m.content)))
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  const ul = $('sessions');
  ul.replaceChildren();
  if (S.current && !S.current.messages.length && !q)
    ul.append(h('li', { class: 'active' }, h('span', { class: 'label' }, 'Nouvelle conversation')));
  for (const s of list) {
    const more = h('button', { class: 'more', title: 'Plus…', 'aria-label': 'Plus', onclick: (e) => { e.stopPropagation(); sessionMenu(s, e); } }, icon('ellipsis'));
    ul.append(h('li', {
      class: s === S.current ? 'active' : '', title: titleOf(s),
      onclick: () => openSession(s), oncontextmenu: (e) => { e.preventDefault(); sessionMenu(s, e); },
      ondblclick: () => renameSession(s),
    }, h('span', { class: 'label' }, s.compare ? icon('arrow-left-right') : null, titleOf(s)), S.gen?.session === s ? h('span', { class: 'spinner' }) : h('span', { class: 'meta' }, relDate(s.date)), more));
  }
  if (!ul.children.length) ul.append(h('li', { class: 'none' }, q ? 'Aucun résultat.' : 'Pas encore de conversation.'));
}

function renderModels() {
  const ul = $('models');
  ul.replaceChildren();
  for (const m of S.models) {
    const active = m.name === S.model.name, loading = m.name === S.model.loading;
    const tip = [m.name, sizeText(m.bytes), m.parameters && `${m.parameters.toLocaleString('fr-CH')} paramètres`, m.blockSize && `contexte ${m.blockSize} tokens`, m.weights === 'weights.dat' ? 'poids TorchSharp (weights.dat)' : 'poids safetensors'].filter(Boolean).join('\n');
    ul.append(h('li', {
      class: (active ? 'active ' : '') + (loading ? 'loading' : ''), title: tip,
      onclick: () => !active && loadModel(m.name), oncontextmenu: (e) => { e.preventDefault(); modelMenu(m, e); },
    }, h('span', { class: 'dot' }), h('span', { class: 'label' }, m.name), h('span', { class: 'meta' }, loading ? 'chargement…' : paramsText(m.parameters)),
    h('button', { class: 'more', title: 'Plus…', 'aria-label': 'Plus', onclick: (e) => { e.stopPropagation(); modelMenu(m, e); } }, icon('ellipsis'))));
  }
  if (!S.models.length) ul.append(h('li', { class: 'none', onclick: () => importFlow() }, 'Aucun modèle. Glisse un .nelmodel ici, ou ', icon('plus'), '.'));
}

function renderHeader() {
  const s = S.current;
  $('title').textContent = titleOf(s);
  const dir = s.workingDirectory || '';
  $('folder-name').textContent = dir ? dir.split(/[\\/]/).filter(Boolean).pop() || dir : 'aucun dossier';
  $('folder-chip').title = 'Dossier de travail : ' + (dir || '(aucun)') + '\nClic : changer';
  document.title = `${titleOf(s)} — Nel Code`;
  $('compare-chip').hidden = !s.compare;
  if (s.compare) $('compare-chip').replaceChildren(`A ${s.compare.a}`, icon('arrow-left-right'), h('span', {}, `B ${s.compare.b}`));
  $('transp-btn').classList.toggle('on', !!S.settings.transparency);
}

function followEnd() {
  const sc = $('scroller');
  if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160) sc.scrollTop = sc.scrollHeight;
}

function actionButton(label, title, onclick, disabled = false) {
  return h('button', { title, onclick, disabled }, label);
}

function renderMessages() {
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

const waiting = (text) => h('span', { class: 'waiting' }, icon('asterisk'), text);

function streamingEl() {
  return h('div', { class: 'msg assistant ' + (S.gen.text ? 'streaming' : 'thinking') }, h('div', { class: 'body' }, S.gen.text ? S.gen.text.trimStart() : waiting('réfléchit…')));
}

function messageEl(m, i, faded) {
  const user = m.role === 'user';
  const el = h('div', { class: `msg ${user ? 'user' : 'assistant'}${faded ? ' faded' : ''}` });
  if (user) el.append(h('span', { class: 'marker' }, icon('chevron-right')));
  if (user && editing === i) {
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
  el.append(user ? h('div', { class: 'body' }, m.content) : bodyEl(m.content, m.tokens));
  const busy = !!S.gen;
  const acts = h('div', { class: 'actions' });
  acts.append(actionButton([icon('copy'), 'Copier'], 'Copier le message', async (e) => {
    const b = e.currentTarget;
    await navigator.clipboard.writeText(m.content);
    b.replaceChildren(icon('check'), 'Copié'); setTimeout(() => b.replaceChildren(icon('copy'), 'Copier'), 1200);
  }));
  if (user) acts.append(actionButton([icon('pencil'), 'Modifier'], 'Modifier et renvoyer (la suite est retirée)', () => startEdit(i), busy));
  else {
    const prev = S.current.messages[i - 1];
    if (prev?.role === 'user' && !S.current.compare) acts.append(actionButton([icon('refresh-cw'), 'Régénérer'], 'Nouvelle réponse, gardée comme une version de plus', () => regenerate(i), busy));
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

function renderComposer() {
  const b = $('send');
  b.classList.toggle('stop', !!S.gen);
  b.replaceChildren(icon(S.gen ? 'square' : 'arrow-up'));
  b.title = S.gen ? 'Arrêter (Échap)' : 'Envoyer (Entrée)';
  b.setAttribute('aria-label', S.gen ? 'Arrêter' : 'Envoyer');
}

function renderStatus() {
  const st = $('status');
  st.replaceChildren();
  if (S.model.loading) st.append(h('span', { class: 'spinner' }), `Chargement de ${S.model.loading}…`);
  else if (S.gen?.kind === 'compare') st.append(h('span', { class: 'spinner' }), `${S.gen.side.toUpperCase()} · ${S.gen.session.compare[S.gen.side]} écrit…  Échap pour arrêter`);
  else if (S.gen) st.append(h('span', { class: 'spinner' }), `${S.model.name} écrit…  Échap pour arrêter`);
  else if (S.model.name) st.append(`${S.model.name}${S.lastSpeed ? ' · ' + S.lastSpeed : ''}`);
  else st.append('aucun modèle chargé');
}

let contextTimer = 0;
function refreshContext() {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(async () => {
    const fill = $('context-fill');
    if (!S.model.name) { S.context = null; $('context-text').textContent = '— / — tokens'; fill.style.width = '0'; return; }
    try {
      const c = await invoke('context_info', { history: turnsOf(S.current.messages), message: $('input').value });
      const changed = S.context?.keptTurns !== c.keptTurns;
      S.context = c;
      const ratio = c.tokens / c.blockSize;
      fill.style.width = Math.min(100, ratio * 100) + '%';
      fill.className = ratio > 0.9 ? 'full' : ratio > 0.7 ? 'warn' : '';
      $('context-text').textContent = `${c.tokens} / ${c.blockSize} tokens`;
      $('context').title = `Le modèle verra ${c.tokens} tokens au prochain message (contexte max ${c.blockSize}, dont 80 gardés pour la réponse).\n${c.keptTurns} échange(s) précédent(s) en mémoire.`;
      if (changed && !S.gen && editing === null) renderMessages();
    } catch { /* modèle en cours de changement */ }
  }, 150);
}

// --- Commandes / -----------------------------------------------------------------------------------------

const COMMANDS = [
  { name: 'new', desc: 'Nouvelle conversation', run: () => startNew() },
  { name: 'compare', desc: 'Conversation comparée entre deux modèles', run: () => openCompare() },
  { name: 'classement', desc: 'Classement du mode comparaison', run: () => openLeaderboard() },
  { name: 'transparence', desc: 'Activer / désactiver le mode transparence', run: () => toggleTransparency() },
  { name: 'model', args: '<nom>', desc: 'Charger un modèle installé', run: (a) => a ? loadModel(a) : toast('Usage : /model <nom>', 'warning') },
  { name: 'models', desc: 'Lister les modèles installés', run: () => toast(S.models.length ? S.models.map((m) => h('div', { class: 'line' }, m.name === S.model.name ? icon('check') : h('span', { class: 'pad' }), `${m.name} — ${sizeText(m.bytes)}`)) : 'Aucun modèle.', '', 8000) },
  { name: 'import', args: '[fichier]', desc: 'Importer un .nelmodel (chemin relatif au dossier de travail)', run: (a) => importFlow(a || null) },
  { name: 'temp', args: '<0.1 à 2>', desc: 'Température : bas = sage, haut = créatif', run: (a) => setSetting('temperature', a) },
  { name: 'topk', args: '<n>', desc: 'Tirage parmi les K tokens les plus probables (0 = sans limite)', run: (a) => setSetting('topK', a) },
  { name: 'topp', args: '<0.05 à 1>', desc: 'Tirage parmi les tokens qui font cette part des chances', run: (a) => setSetting('topP', a) },
  { name: 'max', args: '<16 à 128>', desc: 'Longueur maximale d\'une réponse, en tokens', run: (a) => setSetting('maxReplyTokens', a) },
  { name: 'rename', args: '[titre]', desc: 'Renommer la conversation', run: async (a) => { if (!a) return renameSession(S.current); S.current.title = a; await saveSession(S.current); renderHeader(); } },
  { name: 'export', args: '[md|txt]', desc: 'Exporter la conversation', run: (a) => exportSession(S.current, a !== 'txt') },
  { name: 'dir', desc: 'Changer le dossier de travail de la conversation', run: () => chooseFolder() },
  { name: 'open', desc: 'Ouvrir le dossier de travail dans l\'Explorateur', run: () => openFolder() },
  { name: 'delete', desc: 'Supprimer la conversation', run: () => S.current.messages.length ? deleteSession(S.current) : null },
  { name: 'settings', desc: 'Réglages de génération', run: () => openSettings() },
  { name: 'info', desc: 'Modèle, réglages, dossiers', run: () => showInfo() },
  { name: 'help', desc: 'Liste des commandes', run: () => showHelp() },
];

async function runCommand(line) {
  const [, name, rest = ''] = line.match(/^\/(\S*)\s*(.*)$/s) ?? [];
  const cmd = COMMANDS.find((c) => c.name === name.toLowerCase());
  if (!cmd) return toast(`Commande inconnue : /${name} (essaie /help)`, 'warning');
  try { await cmd.run(rest.trim().replace(/^"(.*)"$/, '$1')); } catch (e) { toast(errText(e), 'error'); }
}

async function setSetting(key, value) {
  const n = Number(String(value).replace(',', '.'));
  if (value === '' || !Number.isFinite(n)) return toast(`Valeur actuelle : ${S.settings[key]}`, '');
  S.settings = await invoke('save_settings', { changes: { [key]: n } });
  toast(`${key} = ${S.settings[key]}`, 'success');
}

let sugg = { items: [], sel: 0 };
function updateSuggest() {
  const v = $('input').value, box = $('suggest');
  let items = [];
  const m = v.match(/^\/(\S*)(\s+(.*))?$/s);
  if (m && !m[2]) items = COMMANDS.filter((c) => c.name.startsWith(m[1].toLowerCase())).map((c) => ({ label: '/' + c.name + (c.args ? ' ' + c.args : ''), desc: c.desc, fill: '/' + c.name + (c.args ? ' ' : '') }));
  else if (m && m[1] === 'model') items = S.models.filter((x) => fold(x.name).startsWith(fold(m[3] ?? ''))).map((x) => ({ label: x.name, desc: x.name === S.model.name ? 'chargé' : paramsText(x.parameters), fill: '/model ' + x.name }));
  sugg = { items, sel: Math.min(sugg.sel, Math.max(0, items.length - 1)) };
  box.hidden = !items.length;
  box.replaceChildren(...items.map((it, i) => h('div', { class: 'item' + (i === sugg.sel ? ' sel' : ''), onmousedown: (e) => { e.preventDefault(); pickSuggest(i); } },
    h('span', { class: 'cmd' }, it.label), h('span', { class: 'desc' }, it.desc))));
  box.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

function pickSuggest(i) {
  const input = $('input');
  input.value = sugg.items[i].fill;
  input.focus();
  updateSuggest();
}

// --- Fenêtres --------------------------------------------------------------------------------------------

let closeOverlay = null;

// Une fenêtre : rend la valeur du bouton choisi (null : Échap, clic dehors).
function dialog(title, body, buttons, focus) {
  return new Promise((resolve) => {
    const ov = $('overlay');
    const done = (v) => { ov.hidden = true; ov.replaceChildren(); closeOverlay = null; resolve(v); $('input').focus(); };
    const btns = h('div', { class: 'buttons' });
    const refresh = () => btns.replaceChildren(...buttons.filter((b) => !b.show || b.show()).map((b) =>
      h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), onclick: () => done(b.value) }, b.label)));
    refresh();
    const box = h('div', { class: 'dialog', role: 'dialog', 'aria-label': title }, h('h2', {}, title), body, btns);
    box.addEventListener('input', refresh);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') { const p = buttons.find((b) => b.primary); if (p) { e.preventDefault(); done(p.value); } }
    });
    ov.replaceChildren(box);
    ov.hidden = false;
    ov.onmousedown = (e) => { if (e.target === ov) done(null); };
    closeOverlay = () => done(null);
    setTimeout(() => (focus ?? box.querySelector('.btn.primary'))?.focus(), 0);
  });
}

const confirmDialog = (title, text, label, danger) =>
  dialog(title, h('p', {}, text), [{ label: 'Annuler', value: false }, { label, value: true, primary: !danger, danger }]);

async function promptDialog(title, value, hint) {
  const input = h('input', { class: 'text-input', spellcheck: 'false' });
  input.value = value;
  setTimeout(() => input.select(), 0);
  const ok = await dialog(title, [input, hint && h('div', { class: 'field' }, h('div', { class: 'hint' }, hint))], [{ label: 'Annuler', value: false }, { label: 'OK', value: true, primary: true }], input);
  return ok ? input.value : null;
}

async function openSettings() {
  const s = S.settings;
  const fields = [
    { key: 'temperature', label: 'Température', min: 0.1, max: 2, step: 0.05, hint: 'Bas : réponses sages et répétitives. Haut : plus créatives, plus de fautes.' },
    { key: 'topK', label: 'Top-k', min: 0, max: 100, step: 1, hint: 'Tirage parmi les K tokens les plus probables (0 = pas de limite).' },
    { key: 'topP', label: 'Top-p', min: 0.05, max: 1, step: 0.01, hint: 'Tirage parmi les tokens qui font cette part des chances (1 = pas de limite).' },
    { key: 'maxReplyTokens', label: 'Longueur max', min: 16, max: 128, step: 1, hint: 'Longueur maximale d\'une réponse, en tokens (environ 3 caractères chacun).' },
  ];
  const inputs = {};
  const body = fields.map((f) => {
    const out = h('output', {}, s[f.key]);
    const r = inputs[f.key] = h('input', { type: 'range', min: f.min, max: f.max, step: f.step, value: s[f.key] });
    r.addEventListener('input', () => (out.textContent = r.value));
    return h('label', { class: 'field' }, h('div', { class: 'row' }, h('span', {}, f.label), out), r, h('div', { class: 'hint' }, f.hint));
  });
  const accent = h('select', { class: 'text-input' }, h('option', { value: 'red' }, 'Rouge (par défaut)'), h('option', { value: 'orange' }, 'Terre cuite (ancienne couleur)'));
  accent.value = s.accent === 'orange' ? 'orange' : 'red';
  accent.addEventListener('change', () => (document.documentElement.dataset.accent = accent.value));
  body.push(h('label', { class: 'field' }, h('div', { class: 'row' }, h('span', {}, 'Couleur d\'accent')), accent));
  const auto = h('input', { type: 'checkbox', checked: s.autoUpdate !== false });
  body.push(h('div', { class: 'field updates' }, h('label', { class: 'check' }, auto, 'Rechercher les mises à jour au démarrage (une fois par jour)'),
    h('button', { class: 'btn', onclick: () => checkUpdate(true) }, icon('refresh-cw'), 'Rechercher des mises à jour')));
  const choice = await dialog('Réglages', body, [{ label: 'Par défaut', value: 'reset' }, { label: 'Annuler', value: null }, { label: 'Enregistrer', value: 'save', primary: true }]);
  if (choice) {
    const changes = choice === 'reset'
      ? { temperature: 0.8, topK: 20, topP: 0.9, maxReplyTokens: 80, accent: 'red', autoUpdate: true }
      : { ...Object.fromEntries(fields.map((f) => [f.key, Number(inputs[f.key].value)])), accent: accent.value, autoUpdate: auto.checked };
    try { S.settings = await invoke('save_settings', { changes }); toast('Réglages enregistrés.', 'success'); } catch (e) { toast(errText(e), 'error'); }
  }
  applyTheme();
}

function showHelp() {
  const rows = COMMANDS.flatMap((c) => [h('dt', {}, '/' + c.name + (c.args ? ' ' + c.args : '')), h('dd', {}, c.desc)]);
  const keys = [['Entrée', 'envoyer'], ['Maj+Entrée', 'nouvelle ligne'], ['Échap', 'arrêter la réponse'], ['Ctrl+K', 'palette'], ['Ctrl+N', 'nouvelle conversation'], ['Ctrl+Maj+N', 'conversation comparée'], ['Ctrl+,', 'réglages'], ['F2', 'renommer'], ['Ctrl+I', 'importer un modèle']]
    .flatMap(([k, d]) => [h('dt', {}, k), h('dd', {}, d)]);
  dialog('Aide', [h('dl', { class: 'info-grid' }, rows), h('h2', { style: 'margin-top:16px' }, 'Raccourcis'), h('dl', { class: 'info-grid' }, keys)], [{ label: 'Fermer', value: null, primary: true }]);
}

async function showInfo() {
  const st = await invoke('model_status');
  const s = S.settings;
  const rows = [
    ['Modèle', st.name ?? '(aucun)'], ['Contexte', st.blockSize ? st.blockSize + ' tokens' : '—'], ['Paramètres', st.parameters?.toLocaleString('fr-CH') ?? '—'],
    ['Calcul', 'CPU (Candle)'], ['Réglages', `température ${s.temperature} · top-k ${s.topK} · top-p ${s.topP} · max ${s.maxReplyTokens}`],
    ['Conversation', `${turnsOf(S.current.messages).length} échange(s) · ${S.current.id}`], ['Dossier', S.current.workingDirectory || '—'],
    ['Données', S.info.root], ['Version', S.info.version],
  ];
  dialog('Infos', h('dl', { class: 'info-grid' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])), [{ label: 'Fermer', value: null, primary: true }]);
}

// Palette Ctrl+K : actions, conversations et modèles, filtrés au fil de la frappe.
function openPalette() {
  if (closeOverlay) return;
  const actions = [
    ['Nouvelle conversation', 'Ctrl+N', startNew], ['Conversation comparée…', 'Ctrl+Maj+N', openCompare], ['Classement', '', openLeaderboard],
    ['Mode transparence', '', toggleTransparency], ['Importer un modèle…', 'Ctrl+I', () => importFlow()], ['Réglages', 'Ctrl+,', openSettings],
    ['Renommer la conversation', 'F2', () => renameSession(S.current)], ['Exporter en Markdown', '', () => exportSession(S.current, true)],
    ['Exporter en texte', '', () => exportSession(S.current, false)], ['Changer le dossier de travail', '', () => chooseFolder()],
    ['Ouvrir le dossier de travail', '', () => openFolder()], ['Supprimer la conversation', '', () => S.current.messages.length && deleteSession(S.current)],
    ['Infos', '', showInfo], ['Aide', '', showHelp], ['Rechercher des mises à jour', '', () => checkUpdate(true)],
  ].map(([text, key, run]) => ({ kind: 'Action', text, key, run }));
  const all = [
    ...actions,
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
  const close = () => { ov.hidden = true; ov.replaceChildren(); closeOverlay = null; };
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
  closeOverlay = () => { close(); $('input').focus(); };
  draw();
  input.focus();
}

// Menu contextuel (bouton « Plus » ou clic droit).
function showMenu(e, items) {
  const menu = $('menu');
  menu.replaceChildren(...items.map((it) => it === '-' ? h('hr') : h('button', { class: it.danger ? 'danger' : '', onclick: () => { menu.hidden = true; it.run(); } }, it.label)));
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
}

function sessionMenu(s, e) {
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

function modelMenu(m, e) {
  showMenu(e, [
    { label: m.name === S.model.name ? 'Recharger' : 'Charger', run: () => loadModel(m.name) },
    '-',
    { label: 'Supprimer…', danger: true, run: () => deleteModel(m.name) },
  ]);
}

async function openFolder() {
  try { await invoke('open_folder', { path: S.current.workingDirectory || '' }); } catch (e) { toast(errText(e), 'error'); }
}

// --- Saisie et raccourcis --------------------------------------------------------------------------------

function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; }

async function submitInput() {
  const input = $('input');
  const line = input.value.trim();
  if (!line) return;
  if (line.startsWith('/')) {
    input.value = ''; autoGrow(input); updateSuggest();
    return runCommand(line);
  }
  if (!canGenerate()) return;
  input.value = ''; autoGrow(input);
  if (!(await send(line))) input.value = line;
}

$('input').addEventListener('input', (e) => { autoGrow(e.target); updateSuggest(); refreshContext(); });
$('input').addEventListener('keydown', (e) => {
  const open = !$('suggest').hidden;
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    sugg.sel = (sugg.sel + (e.key === 'ArrowDown' ? 1 : -1) + sugg.items.length) % sugg.items.length;
    return updateSuggest();
  }
  if (open && e.key === 'Tab') { e.preventDefault(); return pickSuggest(sugg.sel); }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // Entrée sur une suggestion incomplète la complète ; sur une commande déjà complète, l'exécute.
    if (open) {
      const it = sugg.items[sugg.sel];
      if (it && $('input').value.trim() !== it.fill.trim()) return pickSuggest(sugg.sel);
    }
    if (S.gen) return;
    submitInput();
  }
});
$('input').addEventListener('blur', () => setTimeout(() => ($('suggest').hidden = true), 100));
$('send').onclick = () => (S.gen ? stop() : submitInput());
$('new-chat').onclick = startNew;
$('search').oninput = renderSessions;
$('import-btn').onclick = () => importFlow();
$('settings-btn').onclick = openSettings;
$('arena-btn').onclick = openLeaderboard;
$('transp-btn').onclick = toggleTransparency;
$('palette-btn').onclick = openPalette;
$('title').ondblclick = () => renameSession(S.current);
$('folder-chip').onclick = () => chooseFolder();
$('folder-open').onclick = openFolder;
document.addEventListener('mousedown', (e) => { if (!$('menu').contains(e.target)) $('menu').hidden = true; });

document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    if (!$('menu').hidden) { $('menu').hidden = true; return; }
    if (closeOverlay) { e.preventDefault(); return closeOverlay(); }
    if (!$('suggest').hidden) { $('suggest').hidden = true; return; }
    if (S.gen) { e.preventDefault(); return stop(); }
    if (editing !== null) { closeEdit(); return renderMessages(); }
    return;
  }
  if (closeOverlay) return;
  if (ctrl && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); openCompare(); }
  else if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); startNew(); }
  else if (ctrl && e.key.toLowerCase() === 'i') { e.preventDefault(); importFlow(); }
  else if (ctrl && e.key === ',') { e.preventDefault(); openSettings(); }
  else if (e.key === 'F2') { e.preventDefault(); renameSession(S.current); }
  else if (!ctrl && !e.altKey && e.key.length === 1 && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) $('input').focus();
});

// --- Événements du Rust ----------------------------------------------------------------------------------

listen('gen-token', (e) => onToken(e.payload));
// Après l'enregistrement de la réponse : une mise à jour qui attendait peut s'installer.
listen('gen-done', async (e) => { await onDone(e.payload); U.idle?.(); });
listen('gen-side', (e) => { if (S.gen?.kind === 'compare') { S.gen.side = e.payload; renderStatus(); } });
listen('model-loading', (e) => { S.model.loading = e.payload; renderModels(); renderStatus(); });
listen('model-loaded', (e) => {
  Object.assign(S.model, { name: e.payload.name, blockSize: e.payload.blockSize, loading: null });
  S.lastSpeed = '';
  renderModels(); renderStatus(); refreshContext();
  toast(`Modèle ${e.payload.name} chargé (${e.payload.seconds.toFixed(1)} s).`, 'success', 2500);
});
listen('model-error', (e) => {
  S.model.loading = null;
  renderModels(); renderStatus();
  toast(`Le modèle ${e.payload.name} ne se charge pas : ${e.payload.error}`, 'error', 10000);
});
let importToast = null;
listen('import-started', (e) => { importToast = toast(h('span', {}, h('span', { class: 'spinner' }), `Import de ${e.payload}… (extraction et vérification)`), 'busy', 0); });
listen('import-done', async (e) => {
  importToast?.remove();
  const r = e.payload;
  toast(`Modèle « ${r.name} » installé (${r.parameters.toLocaleString('fr-CH')} paramètres).`, 'success');
  if (r.warning) toast('Attention : ' + r.warning, 'warning', 10000);
  await refreshModels();
  if (!S.model.name || S.model.name === r.name) loadModel(r.name);
});
listen('import-error', (e) => {
  importToast?.remove();
  const err = e.payload.error === 'exists' ? `Un modèle « ${e.payload.name} » existe déjà.` : e.payload.error;
  toast('Import impossible : ' + err, 'error', 10000);
});

// Glisser-déposer d'un .nelmodel sur la fenêtre.
listen('tauri://drag-enter', () => ($('drop').hidden = false));
listen('tauri://drag-leave', () => ($('drop').hidden = true));
listen('tauri://drag-drop', (e) => {
  $('drop').hidden = true;
  const paths = e.payload.paths ?? [];
  const pkg = paths.find((p) => p.toLowerCase().endsWith('.nelmodel'));
  if (pkg) importFlow(pkg);
  else if (paths.length) toast('Seuls les fichiers .nelmodel peuvent être importés.', 'warning');
});

// --- Démarrage -------------------------------------------------------------------------------------------

(async () => {
  [S.info, S.settings, S.sessions] = await Promise.all([invoke('app_info'), invoke('get_settings'), invoke('list_sessions')]);
  applyTheme();
  await refreshModels();
  S.current = newSession();
  const st = await invoke('model_status');
  Object.assign(S.model, { name: st.name, loading: st.loading, blockSize: st.blockSize });
  renderAll();
  $('input').focus();
  if (!S.model.name && !S.model.loading && S.models.length) {
    const last = S.models.find((m) => m.name === S.settings.lastModel) ?? S.models[0];
    loadModel(last.name);
  }
  if (S.info.startupFile) importFlow(S.info.startupFile);
  // Noté avant de vérifier : hors ligne, on ne réessaie que le lendemain.
  if (S.settings.autoUpdate !== false && !(Date.now() - S.settings.lastUpdateCheck < UPDATE_EVERY)) {
    S.settings = await invoke('save_settings', { changes: { lastUpdateCheck: Date.now() } });
    setTimeout(() => checkUpdate(false), 3000);   // discrète : après le démarrage
  }
})().catch((e) => toast('Démarrage : ' + errText(e), 'error', 0));
