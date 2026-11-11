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
  const el = h('div', { class: 'toast ' + kind }, text);
  $('toasts').append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
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

function touch(s) { s.date = localIso(); if (S.model.name) s.model = S.model.name; }

function openSession(s) {
  if (S.current === s) return;
  closeEdit();
  S.current = s;
  renderAll();
  $('input').focus();
}

function startNew() {
  if (S.current && !S.current.messages.length) { $('input').focus(); return; }
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
  return { temperature: s.temperature, topK: s.topK, topP: s.topP, maxReplyTokens: s.maxReplyTokens };
}

function canGenerate() {
  if (S.gen) return false;
  if (!S.model.name) {
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
  return startGen(s, { kind: 'send', index: s.messages.length, question: text, history });
}

async function regenerate(index) {
  const s = S.current;
  if (!canGenerate() || s.messages[index]?.role !== 'assistant') return;
  const question = s.messages[index - 1].content;
  s.messages.splice(index + 1);          // la suite de la conversation est retirée
  await saveSession(s);
  return startGen(s, { kind: 'regen', index, question, history: turnsOf(s.messages, index - 1), old: s.messages[index] });
}

async function startGen(s, g) {
  S.gen = { ...g, session: s, text: '' };
  renderMessages();
  renderComposer();
  try {
    await invoke('generate', { history: g.history, message: g.question, options: genOptions() });
    return true;
  } catch (e) {
    S.gen = null;
    if (g.kind === 'send') s.messages.pop();
    toast(errText(e), 'error');
    renderAll();
    return false;
  }
}

function onToken(text) {
  const g = S.gen;
  if (!g) return;
  g.text += text;
  if (g.el && S.current === g.session) {
    g.el.classList.remove('thinking');
    g.el.classList.add('streaming');
    g.el.querySelector('.body').textContent = g.text.trimStart();
    followEnd();
  }
}

async function onDone(p) {
  const g = S.gen;
  if (!g) return;
  S.gen = null;
  const s = g.session;
  const text = (p.text ?? '').trim();
  if (p.error || !text) {
    if (g.kind === 'send') { s.messages.pop(); if (S.current === s) $('input').value ||= g.question; }
    toast(p.error ? 'Erreur pendant la réponse : ' + p.error : 'Le modèle n\'a rien répondu.', p.error ? 'error' : 'warning');
  } else if (g.kind === 'send') {
    s.messages.push({ role: 'assistant', content: text });
  } else {
    const versions = g.old.versions ? [...g.old.versions] : [g.old.content];
    versions.push(text);
    s.messages[g.index] = { ...g.old, content: text, versions };
  }
  if (text) { touch(s); await saveSession(s); }
  if (!p.error && p.tokens) {
    S.lastSpeed = `${p.tokens} tokens · ${(p.tokens / p.seconds).toFixed(1)} tokens/s${p.stopped ? ' · arrêtée' : ''}`;
  }
  renderAll();
}

function stop() { if (S.gen) invoke('stop_generation'); }

function stepVersion(index, delta) {
  const s = S.current, m = s.messages[index];
  if (S.gen || !m.versions || m.versions.length < 2) return;
  const shown = Math.min(Math.max(m.versions.indexOf(m.content) + delta, 0), m.versions.length - 1);
  s.messages[index] = { ...m, content: m.versions[shown] };
  saveSession(s);
  renderMessages();
  refreshContext();
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
    const more = h('button', { class: 'more', title: 'Plus…', onclick: (e) => { e.stopPropagation(); sessionMenu(s, e); } }, '⋯');
    ul.append(h('li', {
      class: s === S.current ? 'active' : '', title: titleOf(s),
      onclick: () => openSession(s), oncontextmenu: (e) => { e.preventDefault(); sessionMenu(s, e); },
      ondblclick: () => renameSession(s),
    }, h('span', { class: 'label' }, titleOf(s)), S.gen?.session === s ? h('span', { class: 'spinner' }) : h('span', { class: 'meta' }, relDate(s.date)), more));
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
    h('button', { class: 'more', title: 'Plus…', onclick: (e) => { e.stopPropagation(); modelMenu(m, e); } }, '⋯')));
  }
  if (!S.models.length) ul.append(h('li', { class: 'none', onclick: () => importFlow() }, 'Aucun modèle. Glisse un .nelmodel ici, ou ＋.'));
}

function renderHeader() {
  const s = S.current;
  $('title').textContent = titleOf(s);
  const dir = s.workingDirectory || '';
  $('folder-name').textContent = dir ? dir.split(/[\\/]/).filter(Boolean).pop() || dir : 'aucun dossier';
  $('folder-chip').title = 'Dossier de travail : ' + (dir || '(aucun)') + '\nClic : changer';
  document.title = `${titleOf(s)} — Nel Code`;
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
  // Les tours que le modèle ne voit plus (contexte plein) sont grisés.
  const turns = turnsOf(s.messages).length;
  const fadedTurns = S.context && !g ? Math.max(0, turns - S.context.keptTurns) : 0;
  const fadedEnd = fadedTurns * 2;
  s.messages.forEach((m, i) => {
    if (fadedEnd && i === fadedEnd) box.append(h('div', { class: 'faded-sep' }, 'au-dessus : hors de la mémoire du modèle'));
    if (g?.kind === 'regen' && i === g.index) return box.append(g.el = streamingEl());
    box.append(messageEl(m, i, i < fadedEnd));
  });
  if (g?.kind === 'send') box.append(g.el = streamingEl());
  if (g) { const sc = $('scroller'); sc.scrollTop = sc.scrollHeight; }
}

function streamingEl() {
  const el = h('div', { class: 'msg assistant ' + (S.gen.text ? 'streaming' : 'thinking') }, h('div', { class: 'body' }, S.gen.text.trimStart()));
  return el;
}

function messageEl(m, i, faded) {
  const user = m.role === 'user';
  const el = h('div', { class: `msg ${user ? 'user' : 'assistant'}${faded ? ' faded' : ''}` });
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
  el.append(h('div', { class: 'body' }, m.content));
  const busy = !!S.gen;
  const acts = h('div', { class: 'actions' });
  acts.append(actionButton('⧉ Copier', 'Copier le message', async (e) => {
    await navigator.clipboard.writeText(m.content);
    e.target.textContent = '✓ Copié'; setTimeout(() => (e.target.textContent = '⧉ Copier'), 1200);
  }));
  if (user) acts.append(actionButton('✎ Modifier', 'Modifier et renvoyer (la suite est retirée)', () => startEdit(i), busy));
  else {
    const prev = S.current.messages[i - 1];
    if (prev?.role === 'user') acts.append(actionButton('↻ Régénérer', 'Nouvelle réponse, gardée comme une version de plus', () => regenerate(i), busy));
    if (m.versions?.length > 1) {
      const at = m.versions.indexOf(m.content);
      acts.append(h('span', { class: 'versions' },
        actionButton('‹', 'Version précédente', () => stepVersion(i, -1), busy || at <= 0),
        `${at + 1}/${m.versions.length}`,
        actionButton('›', 'Version suivante', () => stepVersion(i, +1), busy || at >= m.versions.length - 1)));
      acts.classList.add('keep');
    }
  }
  el.append(acts);
  return el;
}

function renderComposer() {
  const b = $('send');
  b.classList.toggle('stop', !!S.gen);
  b.textContent = S.gen ? '■' : '↑';
  b.title = S.gen ? 'Arrêter (Échap)' : 'Envoyer (Entrée)';
}

function renderStatus() {
  const st = $('status');
  st.replaceChildren();
  if (S.model.loading) st.append(h('span', { class: 'spinner' }), `Chargement de ${S.model.loading}…`);
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
  { name: 'model', args: '<nom>', desc: 'Charger un modèle installé', run: (a) => a ? loadModel(a) : toast('Usage : /model <nom>', 'warning') },
  { name: 'models', desc: 'Lister les modèles installés', run: () => toast(S.models.map((m) => `${m.name === S.model.name ? '● ' : '  '}${m.name} — ${sizeText(m.bytes)}`).join('\n') || 'Aucun modèle.', '', 8000) },
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
  const choice = await dialog('Réglages', body, [{ label: 'Par défaut', value: 'reset' }, { label: 'Annuler', value: null }, { label: 'Enregistrer', value: 'save', primary: true }]);
  if (!choice) return;
  const changes = choice === 'reset'
    ? { temperature: 0.8, topK: 20, topP: 0.9, maxReplyTokens: 80 }
    : Object.fromEntries(fields.map((f) => [f.key, Number(inputs[f.key].value)]));
  try { S.settings = await invoke('save_settings', { changes }); toast('Réglages enregistrés.', 'success'); } catch (e) { toast(errText(e), 'error'); }
}

function showHelp() {
  const rows = COMMANDS.flatMap((c) => [h('dt', {}, '/' + c.name + (c.args ? ' ' + c.args : '')), h('dd', {}, c.desc)]);
  const keys = [['Entrée', 'envoyer'], ['Maj+Entrée', 'nouvelle ligne'], ['Échap', 'arrêter la réponse'], ['Ctrl+K', 'palette'], ['Ctrl+N', 'nouvelle conversation'], ['Ctrl+,', 'réglages'], ['F2', 'renommer'], ['Ctrl+I', 'importer un modèle']]
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
    ['Nouvelle conversation', 'Ctrl+N', startNew], ['Importer un modèle…', 'Ctrl+I', () => importFlow()], ['Réglages', 'Ctrl+,', openSettings],
    ['Renommer la conversation', 'F2', () => renameSession(S.current)], ['Exporter en Markdown', '', () => exportSession(S.current, true)],
    ['Exporter en texte', '', () => exportSession(S.current, false)], ['Changer le dossier de travail', '', () => chooseFolder()],
    ['Ouvrir le dossier de travail', '', () => openFolder()], ['Supprimer la conversation', '', () => S.current.messages.length && deleteSession(S.current)],
    ['Infos', '', showInfo], ['Aide', '', showHelp],
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

// Menu contextuel (⋯ ou clic droit).
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
  else if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); startNew(); }
  else if (ctrl && e.key.toLowerCase() === 'i') { e.preventDefault(); importFlow(); }
  else if (ctrl && e.key === ',') { e.preventDefault(); openSettings(); }
  else if (e.key === 'F2') { e.preventDefault(); renameSession(S.current); }
  else if (!ctrl && !e.altKey && e.key.length === 1 && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) $('input').focus();
});

// --- Événements du Rust ----------------------------------------------------------------------------------

listen('gen-token', (e) => onToken(e.payload));
listen('gen-done', (e) => onDone(e.payload));
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
})().catch((e) => toast('Démarrage : ' + errText(e), 'error', 0));
