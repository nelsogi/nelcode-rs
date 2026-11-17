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
  server: { port: null, busy: false },   // le serveur local (API OpenAI)
  providers: [],       // les fournisseurs de modèles distants (sans leurs clés)
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

// Une ligne du journal (%APPDATA%\NelCode\logs). Seulement des événements, jamais le texte d'une conversation.
const logEvent = (message, level = 'info') => invoke('log_event', { level, message: String(message) }).catch(() => {});

function toast(text, kind = '', ms = 4500) {
  if (kind === 'error' && typeof text === 'string') logEvent(text, 'error');
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

// Un modèle distant devient le modèle actif (rien à charger : les appels partent au fournisseur).
async function selectRemote(p, m) {
  if (S.gen) return toast('Attends la fin de la réponse (ou Stop).', 'warning');
  Object.assign(S.model, { name: m.id, blockSize: m.contextLength ?? null, device: `réseau · ${p.name}`, remote: { provider: p.id, model: m.id } });
  S.lastSpeed = '';
  renderModels(); renderStatus(); refreshContext();
  try { S.settings = await invoke('save_settings', { changes: { lastModel: `remote:${p.id}/${m.id}` } }); } catch { /* sans gravité */ }
  toast(`${m.id} (${p.name}) : modèle distant.`, 'success', 2500);
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

// --- Catalogue de modèles ouverts ------------------------------------------------------------------------

const C = { name: null, received: 0, total: 0, extracting: false };   // le téléchargement en cours

async function openCatalog() {
  const list = await invoke('catalog');
  const rows = h('div', { class: 'catalog' });
  const draw = (list) => rows.replaceChildren(...list.map((e) => {
    const busy = C.name === e.name;
    return h('div', { class: 'entry', 'data-name': e.name },
      h('div', { class: 'head' }, h('b', {}, e.name), h('span', { class: 'meta' }, `${e.parameters} de paramètres · ${sizeText(e.bytes)}`)),
      h('div', { class: 'hint' }, e.description),
      h('div', { class: 'license' }, 'Licence : ', h('b', {}, e.license), ' · ', h('span', { class: 'url' }, e.licenseUrl)),
      busy ? h('div', { class: 'progress' }, h('div', { class: 'bar' }, h('div', { class: 'fill' })), h('span', { class: 'text' }, 'Téléchargement…'),
        h('button', { class: 'btn', onclick: () => invoke('cancel_catalog') }, 'Annuler'))
        : e.installed ? h('div', { class: 'hint ok' }, icon('check'), 'Installé')
          : h('button', { class: 'btn', disabled: !!C.name, onclick: () => downloadModel(e) }, icon('download'), 'Télécharger'));
  }));
  const redraw = async () => { if (rows.isConnected) { draw(await invoke('catalog')); catalogProgress(); } };
  draw(list);
  catalogProgress();
  dialog('Catalogue de modèles', [rows, h('div', { class: 'hint', style: 'margin-top:10px' },
    'Téléchargés depuis Hugging Face, empreinte SHA-256 vérifiée. Tu peux aussi glisser un fichier .gguf (Qwen2 ou Llama) dans la fenêtre.')],
  [{ label: 'Fermer', value: null, primary: true }]);
}

function catalogProgress() {
  const box = document.querySelector(`.catalog .entry[data-name="${CSS.escape(C.name ?? '')}"] .progress`);
  if (!box) return;
  box.querySelector('.fill').style.width = C.total ? (100 * C.received / C.total).toFixed(1) + '%' : '0';
  box.querySelector('.text').textContent = C.extracting ? 'Vérification et installation…' : `${sizeText(C.received)} / ${sizeText(C.total)}`;
}

// La licence est montrée (et acceptée) avant le téléchargement.
async function downloadModel(e) {
  const ok = await dialog(`Télécharger ${e.name} ?`, [
    h('p', {}, `${sizeText(e.bytes)} depuis Hugging Face, dans ton dossier de modèles.`),
    h('dl', { class: 'info-grid' }, h('dt', {}, 'Licence'), h('dd', {}, e.license), h('dt', {}, 'Texte'), h('dd', {}, e.licenseUrl), h('dt', {}, 'Page'), h('dd', {}, e.page), h('dt', {}, 'SHA-256'), h('dd', {}, e.sha256)),
    h('div', { class: 'hint' }, 'Le modèle est publié par ses auteurs sous cette licence ; Nel Code ne le modifie pas.'),
  ], [{ label: 'Annuler', value: false }, { label: `Accepter (${e.license}) et télécharger`, value: true, primary: true }]);
  if (!ok) return openCatalog();
  Object.assign(C, { name: e.name, received: 0, total: e.bytes, extracting: false });
  openCatalog();
  try {
    const r = await invoke('install_catalog_model', { name: e.name });
    toast(`Modèle « ${r.name} » installé.`, 'success');
    await refreshModels();
    if (!S.model.name) loadModel(r.name);
  } catch (err) {
    const t = errText(err);
    toast(t === 'annulé' ? 'Téléchargement annulé.' : `${e.name} : ${t}`, t === 'annulé' ? 'warning' : 'error', 8000);
  }
  C.name = null;
  if (document.querySelector('.catalog')) openCatalog();   // la liste à jour (installé, boutons)
}

listen('catalog-progress', (e) => { if (e.payload.tag === C.name) { Object.assign(C, e.payload); catalogProgress(); } });

// --- Fichiers du dossier de travail (@) ------------------------------------------------------------------
// « @chemin » dans la saisie : le fichier (lu, jamais modifié) est ajouté au message dans un bloc de code.

const F = { dir: null, list: [], at: 0, loading: null };
const EXT_LANG = { rs: 'rust', cs: 'csharp', py: 'python', js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx', html: 'html', htm: 'html', css: 'css', json: 'json', xml: 'xml', md: 'markdown', toml: 'toml', yml: 'yaml', yaml: 'yaml', sh: 'bash', ps1: 'powershell' };

// La liste des fichiers du dossier de travail, gardée 10 s.
function workFiles() {
  const dir = S.current?.workingDirectory;
  if (!dir) return [];
  if ((F.dir !== dir || Date.now() - F.at > 10_000) && !F.loading) {
    F.loading = invoke('list_files', { dir }).then((list) => { Object.assign(F, { dir, list, at: Date.now() }); }, () => Object.assign(F, { dir, list: [], at: Date.now() }))
      .finally(() => { F.loading = null; updateSuggest(); });
  }
  return F.dir === dir ? F.list : [];
}

const MENTION = /(^|\s)@([^\s@]+)/g;

// Le message avec le contenu des fichiers cités. `quiet` : un fichier illisible ou protégé est ignoré (barre de
// contexte) ; sinon l'erreur est affichée et rien n'est rendu. Un fichier protégé (.env, *.pem…) n'est lu qu'après
// une confirmation explicite.
async function expandMentions(text, quiet = false) {
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

function genOptions() {
  const s = S.settings;
  return { temperature: s.temperature, topK: s.topK, topP: s.topP, maxReplyTokens: s.maxReplyTokens, repetitionPenalty: s.repetitionPenalty, transparency: !!s.transparency };
}

function canGenerate() {
  if (S.gen) return false;
  if (S.bench) { toast('Test de vitesse en cours…', 'warning'); return false; }
  if (U.state === 'installing') { toast('Installation de la mise à jour en cours…', 'warning'); return false; }
  if (!S.model.name && !S.current?.compare) {
    toast(S.model.loading ? `Le modèle ${S.model.loading} se charge…` : 'Aucun modèle chargé : choisis-en un à gauche, importe un .nelmodel ou un .gguf, ou ouvre le catalogue.', 'warning');
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
  S.gen = { ...g, session: s, text: '', tokens: [], reasoning: '', thinkStart: null, thinkEnd: null, steps: [] };
  renderMessages();
  renderComposer();
  renderStatus();
  try {
    const r = S.model.remote;
    if (g.kind === 'compare')
      await invoke('compare_generate', { a: s.compare.a, b: s.compare.b, historyA: g.history, historyB: g.historyB, message: g.question, options: genOptions() });
    else if (s.agent) {
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
function onToken(p) {
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

async function onDone(p) {
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

// --- Mode Agent -----------------------------------------------------------------------------------------

const AGENT_LOCAL = 'Le mode Agent demande un modèle distant qui gère les outils (llama.cpp lancé avec --jinja, Ollama avec Qwen3…) : les .nelmodel et les modèles GGUF de ce PC n\'y ont pas accès.';

function toggleAgent() {
  const s = S.current;
  if (!s.agent && !S.model.remote) return toast(AGENT_LOCAL, 'warning', 8000);
  if (s.compare) return toast('Le mode Agent ne marche pas en conversation comparée.', 'warning');
  s.agent = !s.agent;
  if (!s.agent) delete s.agent;
  if (s.messages.length) saveSession(s);
  renderHeader();
  toast(s.agent ? `Mode Agent : ${S.model.name} peut lire les fichiers de « ${s.workingDirectory || '(aucun dossier)'} », et les modifier avec ton accord.` : 'Mode Agent désactivé.', '', 4000);
}

const STEP_ICONS = { list: 'folder', read: 'eye', search: 'search', write: 'file-plus', edit: 'pencil', note: 'asterisk', error: 'circle-alert' };
const STEP_STATUS = { pending: 'à valider', accepted: 'acceptée', rejected: 'refusée', undone: 'annulée', error: 'erreur' };

function diffEl(lines) {
  return h('div', { class: 'diff' }, lines.map(([c, l]) => h('div', { class: { '+': 'add', '-': 'del', '…': 'skip' }[c] ?? 'ctx' }, h('span', { class: 'sign' }, c === '…' ? '' : c), l)));
}

// Les étapes de l'agent. `m` : le message fini (Annuler y met à jour les étapes) ; null pendant la réponse.
function stepsEl(steps, m) {
  const box = h('div', { class: 'steps' });
  for (const st of steps) {
    const write = st.kind === 'write' || st.kind === 'edit';
    const status = STEP_STATUS[st.status] ? h('span', { class: 'status ' + st.status }, STEP_STATUS[st.status]) : null;
    const body = h('div', { class: 'step-body' });
    if (st.diff) body.append(diffEl(st.diff));
    else if (st.detail) body.append(h('pre', { class: 'detail' }, st.detail));
    if (st.error) body.append(h('div', { class: 'warn-text' }, st.error));
    const decide = (decision) => invoke('agent_decide', { request: st.request, step: st.id, decision }).catch((e) => toast(errText(e), 'error'));
    // Un fichier protégé : une confirmation à chaque fois (jamais « Accepter tout »).
    if (st.status === 'pending' && !m && st.protected) body.append(h('div', { class: 'row-btns' },
      h('button', { class: 'btn danger', onclick: () => decide('accept') }, st.kind === 'search' ? 'Parcourir aussi ces fichiers' : 'Autoriser la lecture'),
      h('button', { class: 'btn primary', onclick: () => decide('reject') }, 'Refuser')));
    if (st.status === 'pending' && !m && !st.protected) body.append(h('div', { class: 'row-btns' },
      h('button', { class: 'btn primary', onclick: () => decide('accept') }, icon('check'), 'Accepter'),
      h('button', { class: 'btn', onclick: () => decide('reject') }, 'Refuser'),
      h('button', { class: 'btn', title: 'Accepter cette écriture et les suivantes de cette demande, sans redemander', onclick: () => decide('accept_all') }, 'Accepter tout pour cette demande')));
    if (write && st.status === 'accepted' && m) body.append(h('div', { class: 'row-btns' },
      h('button', { class: 'btn', onclick: () => undoSteps(m, [st.id], () => invoke('agent_undo', { request: st.request, step: st.id }).then(() => [st.id])) }, icon('undo-2'), 'Annuler')));
    box.append(h('details', { class: 'step ' + st.kind, 'data-step': st.id, 'data-status': st.status, open: st.status === 'pending' && !m },
      h('summary', {}, icon(STEP_ICONS[st.kind] ?? 'asterisk'), h('span', { class: 'title' }, st.title), status), body));
  }
  const undoable = m && steps.filter((st) => (st.kind === 'write' || st.kind === 'edit') && st.status === 'accepted');
  if (undoable?.length) box.append(h('div', { class: 'row-btns undo-all' },
    h('button', { class: 'btn', onclick: () => undoSteps(m, undoable.map((st) => st.id), () => invoke('agent_undo_all', { request: m.agent.request })) }, icon('undo-2'), 'Annuler toute la demande')));
  return box;
}

// Annule des écritures (le Rust refuse si un fichier a changé depuis), puis les marque « annulée » dans la conversation.
async function undoSteps(m, ids, run) {
  if (S.gen) return toast('Attends la fin de la réponse (ou Stop).', 'warning');
  try {
    const done = await run();
    for (const st of m.agent.steps) if (done.includes(st.id)) st.status = 'undone';
    toast(done.length > 1 ? `${done.length} modifications annulées.` : 'Modification annulée.', 'success');
  } catch (e) { toast('Annulation impossible : ' + errText(e), 'error', 8000); }
  await saveSession(S.current);
  renderMessages();
}

// Une étape nouvelle ou mise à jour, pendant la réponse.
listen('agent-step', (e) => {
  const g = S.gen, st = e.payload;
  if (!g) return;
  const i = g.steps.findIndex((x) => x.id === st.id);
  if (i >= 0) g.steps[i] = st; else g.steps.push(st);
  if (!g.el || S.current !== g.session) return;
  const fresh = stepsEl(g.steps, null), old = g.el.querySelector('.steps');
  // Les étapes dépliées par l'utilisateur le restent.
  if (old) for (const d of old.querySelectorAll('details[open]')) fresh.querySelector(`[data-step="${d.dataset.step}"]`)?.setAttribute('open', '');
  old ? old.replaceWith(fresh) : g.el.querySelector('.body').before(fresh);
  if (st.status === 'pending') fresh.querySelector(`[data-step="${st.id}"]`)?.scrollIntoView({ block: 'nearest' });
  followEnd();
});
// Le texte qui accompagnait les outils est devenu une étape : la réponse finale repart de zéro.
listen('agent-clear', () => {
  const g = S.gen;
  if (!g) return;
  g.text = '';
  const body = g.el?.querySelector('.body');
  if (body) body.replaceChildren(waiting('travaille…'));
});

// --- Réflexion (modèles distants) ------------------------------------------------------------------------

// Le bloc « Réflexion » repliable, au-dessus de la réponse ; ouvert pendant qu'elle s'écrit.
function reasoningEl(text, seconds, live) {
  const label = live ? 'Réflexion…' : `Réflexion · ${Number(seconds ?? 0).toLocaleString('fr-CH', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} s`;
  return h('details', { class: 'reasoning', open: live }, h('summary', {}, icon('chevron-right'), label), h('div', { class: 'think' }, text));
}

// La réflexion en cours dans la réponse qui s'écrit (l'état replié ou déplié choisi est gardé).
function showReasoning() {
  const g = S.gen;
  if (!g?.el || S.current !== g.session) return;
  const old = g.el.querySelector('.reasoning');
  const live = !g.thinkEnd;
  const el = reasoningEl(g.reasoning, (g.thinkEnd - g.thinkStart) / 1000, live);
  if (old && !live) el.open = false; else if (old) el.open = old.open;
  old ? old.replaceWith(el) : g.el.prepend(el);
  followEnd();
}

listen('gen-reasoning', (e) => {
  const g = S.gen;
  if (!g || g.kind === 'compare') return;
  g.thinkStart ??= Date.now();
  g.reasoning += e.payload.text;
  showReasoning();
});

// --- Mode transparence -----------------------------------------------------------------------------------

async function toggleTransparency() {
  try { S.settings = await invoke('save_settings', { changes: { transparency: !S.settings.transparency } }); } catch (e) { return toast(errText(e), 'error'); }
  toast(S.settings.transparency ? 'Transparence activée : survole les mots des prochaines réponses.' : 'Transparence désactivée.', '', 2500);
  renderHeader(); renderMessages();
}

// --- Blocs de code ---------------------------------------------------------------------------------------
// Les blocs ``` d'un message : coloration par expressions régulières, un <span> par morceau (textContent, jamais
// innerHTML), et un bouton Copier. Un bloc pas encore fermé (réponse en cours) est déjà affiché comme du code.

const KEYWORDS = {
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  cs: 'abstract as async await base bool break byte case catch char class const continue decimal default delegate do double else enum event false finally float for foreach get if in init int interface internal is lock long namespace new null object out override params private protected public readonly record ref return sealed set static string struct switch this throw true try typeof uint ulong using var virtual void while yield',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield',
  js: 'async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield',
};
const LANG_ALIAS = { 'c#': 'cs', csharp: 'cs', rs: 'rust', python: 'py', javascript: 'js', ts: 'js', typescript: 'js', jsx: 'js', tsx: 'js', mjs: 'js', xml: 'html', htm: 'html', svg: 'html' };
const LANG_NAMES = { rust: 'Rust', cs: 'C#', py: 'Python', js: 'JavaScript', html: 'HTML', css: 'CSS', json: 'JSON' };
const RE_STR = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`;
const RE_NUM = String.raw`\b0x[\da-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[a-zA-Z\d]*\b`;
const words = (l) => String.raw`\b(?:${KEYWORDS[l].split(' ').join('|')})\b`;
const C_COMMENT = String.raw`//.*|/\*[\s\S]*?(?:\*/|$)`;
// Par langage : [classe, expression], essayées dans l'ordre (la première qui commence le plus tôt gagne).
const HL_RULES = {
  rust: [['com', C_COMMENT], ['str', String.raw`b?"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\\n])'`], ['kw', words('rust')], ['type', String.raw`\b[A-Z]\w*`], ['num', RE_NUM]],
  cs: [['com', C_COMMENT], ['str', String.raw`[$@]*"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])'`], ['kw', words('cs')], ['type', String.raw`\b[A-Z]\w*`], ['num', RE_NUM]],
  js: [['com', C_COMMENT], ['str', RE_STR + '|`(?:\\\\.|[^`\\\\])*`'], ['kw', words('js')], ['num', RE_NUM]],
  py: [['com', '#.*'], ['str', String.raw`"{3}[\s\S]*?(?:"{3}|$)|'{3}[\s\S]*?(?:'{3}|$)|[fbr]?(?:${RE_STR})`], ['kw', words('py')], ['num', RE_NUM]],
  html: [['com', String.raw`<!--[\s\S]*?(?:-->|$)`], ['kw', String.raw`</?[\w-]+|/?>`], ['attr', String.raw`[\w-]+(?==)`], ['str', RE_STR]],
  css: [['com', String.raw`/\*[\s\S]*?(?:\*/|$)`], ['str', RE_STR], ['kw', String.raw`@[\w-]+|!important`], ['attr', String.raw`[\w-]+(?=\s*:[^:{]*[;}])`], ['num', String.raw`#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?`]],
  json: [['attr', String.raw`"(?:\\.|[^"\\])*"(?=\s*:)`], ['str', String.raw`"(?:\\.|[^"\\])*"`], ['kw', String.raw`\b(?:true|false|null)\b`], ['num', String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`]],
};
const HL_RE = Object.fromEntries(Object.entries(HL_RULES).map(([l, rules]) => [l, new RegExp(rules.map(([, r]) => `(${r})`).join('|'), 'g')]));

const langOf = (info) => { const l = (info || '').trim().split(/\s+/)[0].toLowerCase(); return LANG_ALIAS[l] ?? l; };

// Le code colorié : des nœuds texte et des <span class="hl-…">.
function highlight(code, lang) {
  const re = HL_RE[lang];
  if (!re) return [code];
  const out = [];
  let last = 0;
  for (const m of code.matchAll(re)) {
    if (!m[0]) continue;
    if (m.index > last) out.push(code.slice(last, m.index));
    const k = m.findIndex((g, i) => i > 0 && g !== undefined);
    out.push(h('span', { class: 'hl-' + HL_RULES[lang][k - 1][0] }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function codeBlock(code, info) {
  const lang = langOf(info);
  const copy = h('button', { class: 'copy', title: 'Copier le code', onclick: async () => {
    await navigator.clipboard.writeText(code);
    copy.replaceChildren(icon('check'), 'Copié'); setTimeout(() => copy.replaceChildren(icon('copy'), 'Copier'), 1200);
  } }, icon('copy'), 'Copier');
  return h('div', { class: 'code-block', 'data-lang': lang },
    h('div', { class: 'code-head' }, h('span', {}, LANG_NAMES[lang] ?? (lang || 'code')), copy),
    h('pre', {}, h('code', {}, highlight(code, lang))));
}

// Le texte d'un message, avec ses blocs ``` (langage facultatif après les ```).
function richText(text) {
  const out = [];
  const re = /^(`{3,})([^\n`]*)\n([\s\S]*?)(?:\n\1[ \t]*(?:\n|$)|$(?![\s\S]))/gm;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index).replace(/\n$/, ''));
    out.push(codeBlock(m[3], m[2]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Probabilité du token écrit parmi ses 5 choix (0 s'il n'y est pas : tiré plus loin par top-k/top-p).
const chosenProb = ([text, choices]) => choices.find(([t]) => t === text)?.[1] ?? 0;

// Le texte d'une réponse ; en mode transparence, un <span> par token, teinté selon la confiance.
function bodyEl(content, tokens) {
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
  const side = (k, model) => h('div', { class: 'side ' + (g[k].text ? 'streaming' : 'thinking'), 'data-side': k }, h('div', { class: 'who' }, `${k.toUpperCase()} · ${model}`), h('div', { class: 'body' }, g[k].text ? richText(g[k].text.trimStart()) : waiting('en attente…')));
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
    if (update) { U.update = update; U.state = 'available'; renderUpdate(); logEvent(`mise à jour ${update.version} disponible`); }
    else if (manual) toast(`Nel Code ${S.info.version} est à jour.`, 'success', 3000);
  } catch (e) {
    if (!manual) logEvent('recherche de mise à jour : ' + errText(e), 'error');
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
    logEvent(`installation de la mise à jour ${u.version}`);
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
  $('agent-btn').classList.toggle('on', !!s.agent);
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
  const g = S.gen;
  return h('div', { class: 'msg assistant ' + (g.text ? 'streaming' : 'thinking') },
    g.reasoning ? reasoningEl(g.reasoning, ((g.thinkEnd ?? Date.now()) - g.thinkStart) / 1000, !g.thinkEnd) : null,
    g.steps.length ? stepsEl(g.steps, null) : null,
    h('div', { class: 'body' }, g.text ? richText(g.text.trimStart()) : waiting('réfléchit…')));
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
  else if (S.bench) st.append(h('span', { class: 'spinner' }), `Test de vitesse · ${S.bench}…`);
  else if (S.model.name) st.append(`${S.model.name} · ${S.model.device ?? 'CPU'}${S.lastSpeed ? ' · ' + S.lastSpeed : ''}`);
  else st.append('aucun modèle chargé');
  if (S.server.port) st.append(h('span', { class: 'server-on', title: `Serveur local (API OpenAI) : http://127.0.0.1:${S.server.port}/v1` },
    S.server.busy ? h('span', { class: 'spinner' }) : h('span', { class: 'dot' }), S.server.busy ? `API · répond…` : `API :${S.server.port}`));
}

let contextTimer = 0;
function refreshContext() {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(async () => {
    const fill = $('context-fill');
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
    { key: 'maxReplyTokens', label: 'Longueur max', min: 16, max: 128, step: 1, hint: 'Longueur maximale d\'une réponse d\'un .nelmodel, en tokens (environ 3 caractères chacun). Un modèle GGUF écrit jusqu\'à 1024 tokens et s\'arrête de lui-même.' },
    { key: 'repetitionPenalty', label: 'Pénalité de répétition', min: 1, max: 2, step: 0.01, hint: 'Rend moins probables les tokens des 64 derniers (prompt compris), pour éviter que le modèle tourne en boucle. 1 = désactivée ; trop haut, il évite même les mots utiles.' },
    { key: 'agentMaxTurns', label: 'Mode Agent : tours au plus', min: 1, max: 50, step: 1, hint: 'Combien de fois le modèle peut demander des outils (lire, chercher, écrire) avant de devoir répondre.' },
    { key: 'contextLimit', label: 'Contexte des modèles GGUF', min: 512, max: 32768, step: 512, hint: 'Au plus ce nombre de tokens de conversation (le modèle peut en gérer plus, mais la mémoire et le temps de réponse montent vite). Les .nelmodel gardent leur taille.' },
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
  const calc = await calcSection(s);
  body.push(calc.el);
  const srv = await serverSection(s);
  body.push(srv.el, await providersSection());
  const protectedFiles = h('textarea', { class: 'text-input protected', rows: 3, spellcheck: 'false', placeholder: '*.secret\nprivé/\nconfig/prod.yml' });
  protectedFiles.value = (s.protectedFiles ?? []).join('\n');
  body.push(h('label', { class: 'field' }, h('div', { class: 'row' }, h('span', {}, 'Fichiers protégés')), protectedFiles,
    h('div', { class: 'hint' }, 'Un motif par ligne (* et ?, « dossier/ » pour un dossier). Le mode Agent et les fichiers @ ne les lisent ou ne les parcourent qu\'après ta confirmation. Toujours protégés : .env, .env.*, .git/, *.pem, *.key, *.pfx, id_rsa, *.kdbx, appsettings.*.json, secrets.json.')));
  const auto = h('input', { type: 'checkbox', checked: s.autoUpdate !== false });
  body.push(h('div', { class: 'field updates' }, h('label', { class: 'check' }, auto, 'Rechercher les mises à jour au démarrage (une fois par jour)'),
    h('button', { class: 'btn', onclick: () => checkUpdate(true) }, icon('refresh-cw'), 'Rechercher des mises à jour')));
  body.push(h('div', { class: 'field updates' }, h('div', { class: 'row' }, h('span', {}, 'Problème ?')),
    h('button', { class: 'btn', onclick: copyBugReport }, icon('copy'), 'Copier un rapport de bug'),
    h('div', { class: 'hint' }, 'Version, Windows, modèle actif et les 50 dernières lignes du journal (jamais tes conversations).')));
  const choice = await dialog('Réglages', body, [{ label: 'Par défaut', value: 'reset' }, { label: 'Annuler', value: null }, { label: 'Enregistrer', value: 'save', primary: true }]);
  if (choice) {
    const changes = choice === 'reset'
      ? { temperature: 0.8, topK: 20, topP: 0.9, maxReplyTokens: 80, repetitionPenalty: 1.15, contextLimit: 8192, agentMaxTurns: 10, accent: 'red', autoUpdate: true, device: 'auto', serverEnabled: false, serverPort: 8765 }
      : { ...Object.fromEntries(fields.map((f) => [f.key, Number(inputs[f.key].value)])), accent: accent.value, autoUpdate: auto.checked, device: calc.device.value,
        serverEnabled: srv.enabled.checked, serverPort: Number(srv.port.value), protectedFiles: protectedFiles.value.split('\n').map((l) => l.trim()).filter(Boolean) };
    const before = s.device ?? 'auto', limit = s.contextLimit;
    try { S.settings = await invoke('save_settings', { changes }); toast('Réglages enregistrés.', 'success'); } catch (e) { toast(errText(e), 'error'); }
    try { S.server.port = await invoke('server_apply'); } catch (e) { S.server.port = null; toast('Serveur local : ' + errText(e), 'error', 8000); }
    renderStatus();
    // Un autre périphérique, ou un autre contexte pour un modèle GGUF : le modèle est rechargé.
    const gguf = S.models.find((m) => m.name === S.model.name)?.weights === 'gguf';
    if (S.model.name && ((S.settings.device ?? 'auto') !== before || (gguf && S.settings.contextLimit !== limit))) loadModel(S.model.name);
  }
  applyTheme();
}

// --- Fournisseurs de modèles distants ----------------------------------------------------------------

// http:// vers une autre machine : les messages passent en clair sur le réseau.
const cleartext = (url) => /^http:\/\//i.test(url.trim()) && !/^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(url.trim());

async function refreshProviders() {
  S.providers = await invoke('list_providers');
  renderModels();
}

// La section Fournisseurs des réglages : chaque fournisseur s'enregistre tout de suite (pas avec « Enregistrer »).
async function providersSection() {
  await refreshProviders();
  const box = h('div', { class: 'providers' });
  const draw = () => box.replaceChildren(...S.providers.map((p) => providerForm(p, draw)));
  draw();
  const add = h('button', { class: 'btn', onclick: () => { box.append(providerForm({ models: [] }, draw)); box.lastChild.querySelector('input').focus(); } }, icon('plus'), 'Ajouter un fournisseur');
  const qwen = h('button', { class: 'btn', onclick: async () => {
    try {
      const r = await invoke('import_qwen');
      toast(`Qwen Code : ${r.providers} fournisseur(s) créé(s), ${r.models} modèle(s) importé(s)${r.keys ? ', clé rangée dans le Gestionnaire d\'identification' : ''}.`, 'success', 6000);
      await refreshProviders(); draw();
    } catch (e) { toast('Import depuis Qwen Code : ' + errText(e), 'error', 8000); }
  } }, icon('download'), 'Importer depuis Qwen Code');
  return h('div', { class: 'field providers-field' }, h('div', { class: 'row' }, h('span', {}, 'Fournisseurs (modèles distants)')), box, h('div', { class: 'row-btns' }, add, qwen),
    h('div', { class: 'hint' }, 'Un serveur compatible avec l\'API OpenAI : llama.cpp, Ollama (http://hôte:11434/v1), LM Studio… Ses modèles apparaissent dans la liste avec le badge « réseau ». La clé va dans le Gestionnaire d\'identification de Windows, jamais dans settings.json.'));
}

function providerForm(p, redraw) {
  const name = h('input', { class: 'text-input name', placeholder: 'Nom (ex. Ollama du labo)', value: p.name ?? '', spellcheck: 'false' });
  const url = h('input', { class: 'text-input url', placeholder: 'http://10.5.33.228:11434/v1', value: p.url ?? '', spellcheck: 'false' });
  const key = h('input', { class: 'text-input key', type: 'password', autocomplete: 'off', placeholder: p.hasKey ? 'clé enregistrée (vide : inchangée)' : 'clé (facultative)' });
  const warn = h('div', { class: 'warn-text http' }, icon('circle-alert'), 'Adresse en http : les messages passent en clair sur le réseau. Préfère https si le serveur le permet.');
  const status = h('div', { class: 'hint status' }, p.models?.length ? `${p.models.length} modèle(s) : ${p.models.map((m) => m.id).join(', ')}` : '');
  const showWarn = () => (warn.hidden = !cleartext(url.value));
  url.addEventListener('input', showWarn);
  showWarn();
  // Les champs de ce formulaire ne valident pas toute la fenêtre des réglages.
  const form = h('div', { class: 'provider', 'data-id': p.id ?? '', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); } } });
  const save = async (newKey = key.value || null) => {
    try {
      const saved = await invoke('save_provider', { id: p.id ?? null, name: name.value, url: url.value, key: newKey });
      Object.assign(p, saved);
      key.value = '';
      key.placeholder = p.hasKey ? 'clé enregistrée (vide : inchangée)' : 'clé (facultative)';
      form.dataset.id = p.id;
      url.value = p.url;
      await refreshProviders();
      return true;
    } catch (e) { status.className = 'warn-text status'; status.textContent = errText(e); return false; }
  };
  const test = async () => {
    if (!(await save())) return;
    status.className = 'hint status';
    status.replaceChildren(h('span', { class: 'spinner' }), 'Test…');
    try {
      const ids = await invoke('test_provider', { id: p.id });
      status.textContent = ids.length ? `${ids.length} modèle(s) : ${ids.join(', ')}` : 'Le serveur répond, mais ne propose aucun modèle.';
      await refreshProviders();
    } catch (e) { status.className = 'warn-text status'; status.textContent = errText(e); }
  };
  form.append(h('div', { class: 'row-btns' }, name, h('button', { class: 'btn', onclick: test }, icon('refresh-cw'), 'Tester'),
    h('button', { class: 'btn', onclick: async () => (await save()) && toast('Fournisseur enregistré.', 'success', 2000) }, 'Enregistrer'),
    h('button', { class: 'btn danger', title: 'Supprimer le fournisseur (et sa clé)', onclick: async () => {
      if (!p.id) return form.remove();   // pas encore enregistré
      await invoke('delete_provider', { id: p.id });
      if (S.model.remote?.provider === p.id) Object.assign(S.model, { name: null, remote: null, blockSize: null });
      await refreshProviders(); redraw(); renderStatus(); refreshContext();
    } }, 'Supprimer')),
  url, h('div', { class: 'row-btns' }, key, p.hasKey ? h('button', { class: 'btn', onclick: () => save('').then(() => toast('Clé retirée.', 'success', 2000)) }, 'Retirer la clé') : null), warn, status);
  return form;
}

// --- Serveur local (API OpenAI) ------------------------------------------------------------------------

// La section Serveur local des réglages : rend { el, enabled, port } (enregistrés avec les autres réglages).
async function serverSection(s) {
  let st = await invoke('server_status');
  if (!st.key) { await invoke('regenerate_server_key'); st = await invoke('server_status'); }   // une clé dès la première ouverture
  const enabled = h('input', { type: 'checkbox', checked: !!s.serverEnabled });
  const port = h('input', { class: 'text-input port', type: 'number', min: 1024, max: 65535, step: 1, value: s.serverPort });
  const key = h('input', { class: 'text-input key', readonly: true, spellcheck: 'false', value: st.key, 'aria-label': 'Clé d\'accès' });
  const url = h('span', { class: 'url' });
  const showUrl = () => (url.textContent = `http://127.0.0.1:${port.value}/v1`);
  port.addEventListener('input', showUrl);
  showUrl();
  const el = h('div', { class: 'field server' }, h('div', { class: 'row' }, h('span', {}, 'Serveur local (API OpenAI)'), h('span', { class: 'state' + (st.port ? ' on' : '') }, st.port ? `actif sur le port ${st.port}` : 'arrêté')),
    h('label', { class: 'check' }, enabled, 'Activer le serveur (pour Continue dans VS Code, ou tout client de l\'API OpenAI)'),
    h('label', { class: 'inline' }, 'Port', port, h('span', { class: 'hint' }, 'Adresse : '), url),
    h('div', { class: 'row-btns' }, key,
      h('button', { class: 'btn', title: 'Copier la clé', onclick: async () => { await navigator.clipboard.writeText(key.value); toast('Clé copiée.', 'success', 2000); } }, icon('copy'), 'Copier'),
      h('button', { class: 'btn', title: 'Nouvelle clé : l\'ancienne ne marche plus', onclick: async () => { key.value = await invoke('regenerate_server_key'); toast('Nouvelle clé : l\'ancienne ne marche plus.', 'success'); } }, icon('refresh-cw'), 'Nouvelle clé')),
    h('div', { class: 'hint' }, 'Seulement sur ce PC (127.0.0.1), et seulement avec cette clé (Authorization: Bearer). Une seule réponse à la fois, avec Nel Code. Brancher Continue : voir le README.'));
  return { el, enabled, port };
}

listen('server-changed', (e) => { S.server.port = e.payload.port; renderStatus(); });
listen('server-busy', (e) => { S.server.busy = e.payload; renderStatus(); });

// --- Calcul : GPU, pack GPU, test de vitesse ------------------------------------------------------------

const G = { installing: false, received: 0, total: 0 };   // le pack GPU en cours d'installation

async function copyBugReport() {
  try {
    await navigator.clipboard.writeText(await invoke('bug_report'));
    toast('Rapport de bug copié : colle-le dans une issue GitHub.', 'success');
  } catch (e) { toast('Rapport impossible : ' + errText(e), 'error'); }
}

// La section Calcul des réglages : rend { el, device } (le choix est enregistré avec les autres réglages).
async function calcSection(s) {
  const st = await invoke('gpu_status');
  const device = h('select', { class: 'text-input' }, h('option', { value: 'auto' }, 'Automatique (GPU si disponible)'), h('option', { value: 'cpu' }, 'CPU'), h('option', { value: 'gpu' }, 'GPU'));
  device.value = ['cpu', 'gpu'].includes(s.device) ? s.device : 'auto';
  const info = h('div', { class: 'gpu-info' });
  const el = h('div', { class: 'field calc' }, h('div', { class: 'row' }, h('span', {}, 'Calcul')), device, info,
    h('button', { class: 'btn', onclick: () => runBenchmark() }, icon('gauge'), 'Tester la vitesse'));
  const draw = (st) => {
    const lines = [];
    if (!st.compiled) lines.push(h('div', { class: 'hint' }, 'Cette version de Nel Code est compilée sans CUDA : CPU seulement.'));
    else if (!st.card) lines.push(h('div', { class: 'hint' }, 'Aucune carte NVIDIA détectée : le CPU est utilisé.'));
    else {
      lines.push(h('div', {}, `${st.card} · pilote ${st.driver ?? '?'} (CUDA ${st.driverCuda ?? '?'})`));
      if (!st.driverOk) lines.push(h('div', { class: 'warn-text' }, `Ce pilote est trop ancien pour CUDA ${st.needCuda} : installe le pilote NVIDIA ${st.needDriver} ou plus récent. `,
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); invoke('open_driver_page'); } }, 'Télécharger le pilote NVIDIA')));
      if (st.active) lines.push(h('div', { class: 'hint' }, `Actif : ${st.active}`));
      if (st.error) lines.push(h('div', { class: 'warn-text' }, `GPU indisponible : ${st.error}`));
      if (G.installing) lines.push(h('div', { class: 'progress' }, h('div', { class: 'bar' }, h('div', { id: 'gpu-fill' })), h('span', { id: 'gpu-text' }, 'Téléchargement…'),
        h('button', { class: 'btn', onclick: () => invoke('cancel_gpu_pack') }, 'Annuler')));
      else if (st.installed) lines.push(h('button', { class: 'btn', onclick: () => removePack(redraw) }, 'Retirer le pack GPU'));
      else lines.push(h('button', { class: 'btn', onclick: () => installPack(redraw) }, icon('download'), `Installer le pack GPU (${sizeText(st.packBytes)})`),
        h('div', { class: 'hint' }, 'Les bibliothèques CUDA de NVIDIA, dans %APPDATA%\\NelCode\\gpu (empreinte vérifiée).'));
    }
    info.replaceChildren(...lines);
    if (G.installing) gpuProgress();
  };
  const redraw = async () => { if (info.isConnected) draw(await invoke('gpu_status')); };
  draw(st);
  return { el, device };
}

function gpuProgress() {
  const fill = $('gpu-fill'), text = $('gpu-text');
  if (!fill) return;
  fill.style.width = G.total ? (100 * G.received / G.total).toFixed(1) + '%' : '0';
  text.textContent = G.extracting ? 'Vérification et installation…' : `Téléchargement… ${sizeText(G.received)} / ${sizeText(G.total)}`;
}

async function installPack(redraw) {
  Object.assign(G, { installing: true, received: 0, total: 0, extracting: false });
  redraw();
  try {
    await invoke('install_gpu_pack');
    toast('Pack GPU installé. Le modèle est rechargé.', 'success');
    if (S.model.name && S.settings.device !== 'cpu') loadModel(S.model.name);
  } catch (e) {
    toast(errText(e) === 'annulé' ? 'Installation du pack GPU annulée.' : 'Pack GPU : ' + errText(e), errText(e) === 'annulé' ? 'warning' : 'error', 8000);
  }
  G.installing = false;
  redraw();
}

async function removePack(redraw) {
  try {
    const now = await invoke('remove_gpu_pack');
    toast(now ? 'Pack GPU retiré.' : 'Pack GPU retiré au prochain démarrage (il est en cours d\'utilisation).', 'success');
    if (!now && S.model.name) loadModel(S.model.name);   // rechargé sur le CPU
  } catch (e) { toast(errText(e), 'error'); }
  redraw();
}

listen('gpu-pack-progress', (e) => { Object.assign(G, e.payload); gpuProgress(); });

async function runBenchmark() {
  if (!S.model.name) return toast('Charge d\'abord un modèle.', 'warning');
  if (S.model.remote) return toast('Le test de vitesse ne mesure que les modèles de ce PC.', 'warning');
  if (S.gen || S.bench) return toast('Attends la fin de la réponse en cours.', 'warning');
  try { await invoke('benchmark'); } catch (e) { return toast(errText(e), 'error'); }
  S.bench = 'CPU';
  renderStatus();
}

listen('bench-progress', (e) => { S.bench = e.payload; renderStatus(); });
listen('bench-done', (e) => {
  S.bench = null;
  renderStatus();
  if (e.payload.error) toast('Test de vitesse : ' + e.payload.error, 'error', 8000);
  // Une fenêtre déjà ouverte (les réglages) : un résumé, les détails restent dans « Résultats des tests de vitesse ».
  const mine = e.payload.results[e.payload.name] ?? {};
  if (closeOverlay) toast(['cpu', 'gpu'].filter((d) => mine[d]).map((d) => `${mine[d].device} : ${mine[d].tokensPerSecond.toFixed(1)} tokens/s`).join(' · ') || 'Test de vitesse terminé.', 'success', 8000);
  else showBenchmarks(e.payload.results);
});

// Les résultats gardés (benchmarks.json) : le dernier test de chaque modèle, sur chaque périphérique.
async function showBenchmarks(all) {
  all ??= await invoke('benchmarks');
  const rows = Object.entries(all).flatMap(([model, by]) => ['cpu', 'gpu'].filter((d) => by[d]).map((d) => [model, by[d]]));
  const n = (x, digits) => Number(x).toLocaleString('fr-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const body = rows.length
    ? h('table', { class: 'board' }, h('tr', {}, ['Modèle', 'Calcul', 'Chargement', 'Prompt', 'Tokens/s'].map((t) => h('th', {}, t))),
      rows.map(([model, r]) => h('tr', { title: `${r.tokens} tokens écrits · ${new Date(Number(r.date)).toLocaleString('fr-CH')}` },
        h('td', {}, model), h('td', {}, r.device), h('td', {}, n(r.loadSeconds, 2) + ' s'), h('td', {}, `${n(r.promptSeconds, 2)} s · ${r.promptTokens} tok.`), h('td', {}, n(r.tokensPerSecond, 1)))))
    : h('p', {}, 'Pas encore de test. « Tester la vitesse » mesure le modèle chargé.');
  dialog('Test de vitesse', [body, h('div', { class: 'hint', style: 'margin-top:8px' }, '200 tokens gloutons. Prompt : temps jusqu\'au premier token.')],
    [{ label: 'Tester le modèle chargé', value: 'run' }, { label: 'Fermer', value: null, primary: true }]).then((v) => v && runBenchmark());
}

function showHelp() {
  const rows = COMMANDS.flatMap((c) => [h('dt', {}, '/' + c.name + (c.args ? ' ' + c.args : '')), h('dd', {}, c.desc)]);
  const keys = [['Entrée', 'envoyer'], ['Maj+Entrée', 'nouvelle ligne'], ['@', 'joindre un fichier du dossier de travail'], ['Échap', 'arrêter la réponse'], ['Ctrl+K', 'palette'], ['Ctrl+N', 'nouvelle conversation'], ['Ctrl+Maj+N', 'conversation comparée'], ['Ctrl+,', 'réglages'], ['F2', 'renommer'], ['Ctrl+I', 'importer un modèle']]
    .flatMap(([k, d]) => [h('dt', {}, k), h('dd', {}, d)]);
  dialog('Aide', [h('dl', { class: 'info-grid' }, rows), h('h2', { style: 'margin-top:16px' }, 'Raccourcis'), h('dl', { class: 'info-grid' }, keys)], [{ label: 'Fermer', value: null, primary: true }]);
}

async function showInfo() {
  const st = await invoke('model_status');
  const s = S.settings;
  const rows = [
    ['Modèle', st.name ?? '(aucun)'], ['Contexte', st.blockSize ? st.blockSize + ' tokens' : '—'], ['Paramètres', st.parameters?.toLocaleString('fr-CH') ?? '—'],
    ['Calcul', st.device ?? '—'], ['Réglages', `température ${s.temperature} · top-k ${s.topK} · top-p ${s.topP} · pénalité ${s.repetitionPenalty} · max ${s.maxReplyTokens}`],
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
    ['Mode transparence', '', toggleTransparency], ['Mode Agent', '', toggleAgent], ['Importer un modèle…', 'Ctrl+I', () => importFlow()], ['Catalogue de modèles', '', openCatalog], ['Réglages', 'Ctrl+,', openSettings],
    ['Renommer la conversation', 'F2', () => renameSession(S.current)], ['Exporter en Markdown', '', () => exportSession(S.current, true)],
    ['Exporter en texte', '', () => exportSession(S.current, false)], ['Changer le dossier de travail', '', () => chooseFolder()],
    ['Ouvrir le dossier de travail', '', () => openFolder()], ['Supprimer la conversation', '', () => S.current.messages.length && deleteSession(S.current)],
    ['Infos', '', showInfo], ['Aide', '', showHelp], ['Rechercher des mises à jour', '', () => checkUpdate(true)],
    ['Tester la vitesse', '', () => runBenchmark()], ['Résultats des tests de vitesse', '', () => showBenchmarks()], ['Copier un rapport de bug', '', copyBugReport],
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
// Les suggestions se ferment quand la saisie perd vraiment le focus (pas si elle l'a retrouvé entre-temps).
$('input').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('input')) $('suggest').hidden = true; }, 100));
$('send').onclick = () => (S.gen ? stop() : submitInput());
$('new-chat').onclick = startNew;
$('search').oninput = renderSessions;
$('import-btn').onclick = () => importFlow();
$('catalog-btn').onclick = () => openCatalog();
$('settings-btn').onclick = openSettings;
$('arena-btn').onclick = openLeaderboard;
$('transp-btn').onclick = toggleTransparency;
$('agent-btn').onclick = toggleAgent;
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
  Object.assign(S.model, { name: e.payload.name, blockSize: e.payload.blockSize, device: e.payload.device, loading: null, remote: null });
  S.lastSpeed = '';
  renderModels(); renderStatus(); refreshContext();
  toast(`Modèle ${e.payload.name} chargé sur ${e.payload.device} (${e.payload.seconds.toFixed(1)} s).`, 'success', 2500);
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

// Glisser-déposer d'un .nelmodel ou d'un .gguf sur la fenêtre.
listen('tauri://drag-enter', () => ($('drop').hidden = false));
listen('tauri://drag-leave', () => ($('drop').hidden = true));
function onDrop(paths) {
  $('drop').hidden = true;
  const pkg = paths.find((p) => /\.(nelmodel|gguf)$/i.test(p));
  if (pkg) importFlow(pkg);
  else if (paths.length) toast('Seuls les fichiers .nelmodel et .gguf peuvent être importés.', 'warning');
}
listen('tauri://drag-drop', (e) => onDrop(e.payload.paths ?? []));

// --- Démarrage -------------------------------------------------------------------------------------------

(async () => {
  [S.info, S.settings, S.sessions] = await Promise.all([invoke('app_info'), invoke('get_settings'), invoke('list_sessions')]);
  applyTheme();
  await refreshModels();
  S.current = newSession();
  const st = await invoke('model_status');
  Object.assign(S.model, { name: st.name, loading: st.loading, blockSize: st.blockSize, device: st.device });
  S.server.port = (await invoke('server_status')).port;
  S.providers = await invoke('list_providers');
  renderAll();
  $('input').focus();
  const [, rp, rm] = String(S.settings.lastModel ?? '').match(/^remote:([^/]+)\/(.+)$/) ?? [];
  const lastRemote = S.providers.find((p) => p.id === rp)?.models?.find((m) => m.id === rm);
  if (lastRemote && !S.model.name) selectRemote(S.providers.find((p) => p.id === rp), lastRemote);
  else if (!S.model.name && !S.model.loading && S.models.length) {
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
