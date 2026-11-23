// Nel Code Desktop — settings-page.js : La page Réglages : catégories à gauche, réglages à droite, recherche dans toutes
// les catégories, enregistrement automatique, valeurs par défaut, liens directs (barre d'état, puce MCP, /settings,
// palette), export et import en JSON (sans aucun secret : voir store::PORTABLE_SETTINGS).
// Les textes (noms, valeurs, messages) passent toujours par textContent, jamais par innerHTML.

import { $, confirmDialog, dialog, errText, fold, h, invoke, toast } from './util.js';
import { S, UI } from './state.js';
import { loadModel, refreshContext, renderMessages, renderModels, renderStatus } from './conversation.js';
import { claudeKeyBlock } from './agent.js';
import { providersSection } from './providers.js';
import { openUsage, pricesBlock } from './usage.js';
import { conversationServers, mcpPanel, refreshMcp } from './mcp.js';
import { applyDensity, applyTextSize, applyTheme, calcBlock, checkUpdate, copyBugReport, serverBlock } from './settings.js';

export const CATEGORIES = [
  { id: 'general', label: 'Général', icon: 'settings', alias: ['general', 'langue', 'theme', 'zoom'] },
  { id: 'models', label: 'Modèles', icon: 'asterisk', alias: ['modeles', 'modele', 'generation', 'contexte'] },
  { id: 'providers', label: 'Fournisseurs', icon: 'arrow-left-right', alias: ['fournisseurs', 'fournisseur', 'distants'] },
  { id: 'agent', label: 'Agent', icon: 'bot', alias: ['agent', 'explorateurs', 'commandes'] },
  { id: 'claude', label: 'Claude Agent', icon: 'terminal', alias: ['claude', 'claude-agent'] },
  { id: 'mcp', label: 'MCP', icon: 'plug', alias: ['mcp'] },
  { id: 'images', label: 'Images', icon: 'image', alias: ['images', 'image'] },
  { id: 'calc', label: 'Calcul', icon: 'gauge', alias: ['calcul', 'gpu', 'cpu'] },
  { id: 'usage', label: 'Suivi et budget', icon: 'chart-column', alias: ['suivi', 'budget', 'prix'] },
  { id: 'server', label: 'Serveur local', icon: 'external-link', alias: ['serveur', 'api'] },
  { id: 'advanced', label: 'Avancé', icon: 'file-text', alias: ['avance', 'journal', 'bug', 'a-propos', 'export'] },
];

const catOf = (id) => CATEGORIES.find((c) => c.id === id);

/** Une catégorie par son id, son nom ou un alias (/settings gpu, /settings fournisseurs…), sans accents ni casse. */
export function findCategory(text) {
  const q = fold(String(text ?? '').trim()).replace(/\s+/g, '-');
  if (!q) return null;
  return CATEGORIES.find((c) => c.id === q || fold(c.label).replace(/\s+/g, '-') === q || c.alias.includes(q))
    ?? CATEGORIES.find((c) => fold(c.label).startsWith(q) || c.alias.some((a) => a.startsWith(q))) ?? null;
}

// --- Les réglages ----------------------------------------------------------------------------------------
// type : switch | select | range (curseur + champ numérique) | number | text | lines (une valeur par ligne).
// def : la valeur par défaut (celle de store::normalize) ; after : ce qui suit un changement (thème, zoom, modèle…).

const reloadModel = () => { if (S.model.name && !S.model.remote) loadModel(S.model.name); };
const reloadGguf = () => { if (S.model.name && S.models.find((m) => m.name === S.model.name)?.weights === 'gguf') loadModel(S.model.name); };
const claudeStatus = async () => { S.claudeStatus = await invoke('claude_agent_status').catch(() => S.claudeStatus); renderStatus(); };
const applyServer = async () => {
  try { S.server.port = await invoke('server_apply'); } catch (e) { S.server.port = null; toast('Serveur local : ' + errText(e), 'error', 8000); }
  renderStatus();
  UI.serverRedraw?.();
};

const modelOptions = () => [['', 'Le dernier utilisé (par défaut)'], ...S.models.map((m) => [m.name, `${m.name} — ce PC`]),
  ...S.providers.flatMap((p) => (p.models ?? []).map((m) => [`remote:${p.id}/${m.id}`, `${m.id} — ${p.name}`]))];
const explorerKey = (v) => (v?.provider && v?.model ? JSON.stringify({ provider: v.provider, model: v.model }) : '');

export const SETTINGS = [
  // Général
  { key: 'language', cat: 'general', label: 'Langue', type: 'select', def: 'fr', options: () => [['fr', 'Français']], hint: 'La langue de l\'interface. Nel Code n\'existe pour l\'instant qu\'en français.' },
  { key: 'theme', cat: 'general', label: 'Thème', type: 'select', def: 'dark', options: () => [['dark', 'Sombre (par défaut)'], ['light', 'Clair']], hint: 'Les couleurs de toute l\'interface (partagé avec Nel Code C#).', after: applyTheme, keywords: 'sombre clair couleurs' },
  { key: 'accent', cat: 'general', label: 'Couleur d\'accent', type: 'select', def: 'red', options: () => [['red', 'Rouge (par défaut)'], ['orange', 'Terre cuite (ancienne couleur)']], hint: 'La couleur des boutons principaux, des liens et des repères.', after: applyTheme },
  { key: 'textSize', cat: 'general', label: 'Zoom (%)', type: 'range', def: 100, min: 80, max: 150, step: 10, hint: 'Toute l\'interface grandit ou rapetisse : Ctrl + et Ctrl − par pas de 10 %, Ctrl 0 pour 100 %.', after: applyTextSize, keywords: 'taille texte police agrandir' },
  { key: 'density', cat: 'general', label: 'Densité', type: 'select', def: 'normal', options: () => [['compact', 'Compacte'], ['normal', 'Normale (par défaut)'], ['comfortable', 'Confortable']], hint: 'L\'espace entre les messages, les listes et les boutons.', after: applyDensity, keywords: 'espacement' },
  { key: 'markdown', cat: 'general', label: 'Mettre en forme les réponses (Markdown)', type: 'switch', def: true, hint: 'Titres, listes, tableaux, code… Désactivé : le texte brut, tel que le modèle l\'a écrit. « Copier » copie toujours le Markdown d\'origine.', after: () => { if (UI.editing === null) renderMessages(); } },
  { key: 'autoUpdate', cat: 'general', group: 'Mises à jour', label: 'Rechercher les mises à jour au démarrage', type: 'switch', def: true, hint: 'Une fois par jour au plus, sur la page des versions de Nel Code (GitHub). Rien ne s\'installe sans ton accord.' },
  { id: 'update-now', cat: 'general', group: 'Mises à jour', label: 'Rechercher maintenant', hint: 'Vérifie tout de suite s\'il existe une nouvelle version.', block: () => h('button', { class: 'btn', onclick: () => checkUpdate(true) }, icon('refresh-cw'), 'Rechercher des mises à jour') },

  // Modèles
  { key: 'defaultModel', cat: 'models', label: 'Modèle par défaut', type: 'select', def: '', options: modelOptions, cls: 'default-model', hint: 'Le modèle chargé au démarrage de Nel Code. Par défaut, le dernier utilisé ; s\'il n\'existe plus, le dernier utilisé est pris.', keywords: 'démarrage' },
  { key: 'temperature', cat: 'models', group: 'Génération', label: 'Température', type: 'range', def: 0.8, min: 0.1, max: 2, step: 0.05, hint: 'Bas : réponses sages et répétitives. Haut : plus créatives, plus de fautes.' },
  { key: 'topK', cat: 'models', group: 'Génération', label: 'Top-k', type: 'range', def: 20, min: 0, max: 100, step: 1, hint: 'Tirage parmi les K tokens les plus probables (0 = pas de limite).' },
  { key: 'topP', cat: 'models', group: 'Génération', label: 'Top-p', type: 'range', def: 0.9, min: 0.05, max: 1, step: 0.01, hint: 'Tirage parmi les tokens qui font cette part des chances (1 = pas de limite).' },
  { key: 'maxReplyTokens', cat: 'models', group: 'Génération', label: 'Longueur max', type: 'range', def: 80, min: 16, max: 128, step: 1, hint: 'Longueur maximale d\'une réponse d\'un .nelmodel, en tokens (environ 3 caractères chacun). Un modèle GGUF écrit jusqu\'à 1024 tokens et s\'arrête de lui-même.' },
  { key: 'repetitionPenalty', cat: 'models', group: 'Génération', label: 'Pénalité de répétition', type: 'range', def: 1.15, min: 1, max: 2, step: 0.01, hint: 'Rend moins probables les tokens des 64 derniers (prompt compris), pour éviter que le modèle tourne en boucle. 1 = désactivée ; trop haut, il évite même les mots utiles.' },
  { key: 'contextLimit', cat: 'models', group: 'Contexte et résumé', label: 'Contexte des modèles GGUF', type: 'range', def: 8192, min: 512, max: 32768, step: 512, hint: 'Au plus ce nombre de tokens de conversation (le modèle peut en gérer plus, mais la mémoire et le temps de réponse montent vite). Les .nelmodel gardent leur taille. Le modèle GGUF chargé est rechargé.', after: () => { reloadGguf(); refreshContext(); } },
  { key: 'summaryThreshold', cat: 'models', group: 'Contexte et résumé', label: 'Résumé automatique à (% du contexte)', type: 'range', def: 80, min: 0, max: 95, step: 5, hint: 'Quand la conversation dépasse cette part du contexte du modèle (distant ou GGUF), les anciens échanges sont résumés par le modèle actif ; les 4 derniers restent tels quels. 0 : jamais (/compact résume à la main).' },

  // Fournisseurs
  { id: 'providers', cat: 'providers', label: 'Fournisseurs (modèles distants)', hint: 'Serveurs compatibles avec l\'API OpenAI et API Claude : adresse, clé, test, modèles et images.', wide: true, keywords: 'ollama llama.cpp lm studio openai anthropic clé qwen vision images', block: providersSection },

  // Agent
  { key: 'agentMaxTurns', cat: 'agent', label: 'Tours au plus', type: 'range', def: 10, min: 1, max: 50, step: 1, hint: 'Combien de fois le modèle peut demander des outils (lire, chercher, écrire) avant de devoir répondre.' },
  { key: 'commandTimeout', cat: 'agent', group: 'Commandes', label: 'Durée max d\'une commande (s)', type: 'range', def: 120, min: 5, max: 600, step: 5, hint: 'Au-delà, la commande et tous ses processus sont arrêtés (120 s par défaut).' },
  { key: 'allowedCommands', cat: 'agent', group: 'Commandes', label: 'Commandes autorisées sans confirmation', type: 'lines', def: [], cls: 'commands', placeholder: 'dotnet build\ndotnet test', hint: 'Une par ligne, par exemple « dotnet build » (autorise aussi « dotnet build src/App.csproj »). Vide par défaut : chaque commande de l\'agent demande Lancer / Refuser. Jamais de shell (cmd, PowerShell…).', sensitive: true },
  { key: 'protectedFiles', cat: 'agent', group: 'Fichiers protégés', label: 'Fichiers protégés', type: 'lines', def: [], cls: 'protected', placeholder: '*.secret\nprivé/\nconfig/prod.yml', hint: 'Un motif par ligne (* et ?, « dossier/ » pour un dossier). Le mode Agent et les fichiers @ ne les lisent ou ne les parcourent qu\'après ta confirmation. Toujours protégés : .env, .env.*, .git/, *.pem, *.key, *.pfx, id_rsa, *.kdbx, appsettings.*.json, secrets.json.', sensitive: true },
  { key: 'explorerConcurrency', cat: 'agent', group: 'Explorateurs', label: 'Explorateurs en même temps', type: 'range', def: 2, min: 1, max: 8, step: 1, hint: 'L\'agent peut lancer des explorateurs qui lisent le projet pour lui (2 par défaut : beaucoup de serveurs, comme Ollama, traitent les requêtes l\'une après l\'autre).' },
  { key: 'explorerMax', cat: 'agent', group: 'Explorateurs', label: 'Explorateurs par demande', type: 'range', def: 5, min: 0, max: 20, step: 1, hint: 'Au plus ce nombre d\'explorateurs par demande (5 par défaut ; 0 : pas d\'explorateurs).' },
  { key: 'explorerTurns', cat: 'agent', group: 'Explorateurs', label: 'Tours par explorateur', type: 'range', def: 6, min: 1, max: 20, step: 1, hint: 'Combien de fois un explorateur peut lire ou chercher avant de rendre son résumé (6 par défaut).' },
  { key: 'explorerModel', cat: 'agent', group: 'Explorateurs', label: 'Modèle des explorateurs', type: 'select', def: null, cls: 'explorer-model', encode: explorerKey, decode: (v) => (v ? JSON.parse(v) : null),
    options: () => [['', 'Le même que l\'agent (par défaut)'], ...S.providers.flatMap((p) => (p.models ?? []).map((m) => [JSON.stringify({ provider: p.id, model: m.id }), `${m.id} — ${p.name}`]))],
    hint: 'Un modèle plus léger lit plus vite et coûte moins ; il doit gérer les outils. S\'il n\'existe plus, celui de l\'agent est pris.' },

  // Claude Agent
  { id: 'claude-key', cat: 'claude', label: 'Outil claude et clé API', hint: 'L\'outil « claude » d\'Anthropic installé sur ce PC, et ta clé API (jamais de connexion à un compte).', keywords: 'anthropic clé api', block: claudeKeyBlock },
  { key: 'claudeModel', cat: 'claude', label: 'Modèle (--model)', type: 'text', def: '', cls: 'model', list: ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], placeholder: 'celui de l\'outil (par défaut)',
    validate: (v) => (!v || /^[A-Za-z0-9._\[\]-]{1,100}$/.test(v) ? null : 'Lettres, chiffres, « - . _ [ ] » seulement, 100 au plus.'), hint: 'Un alias (opus, sonnet, haiku) ou un id complet (claude-opus-5-5). Vide : le modèle par défaut de l\'outil.', after: claudeStatus },
  { key: 'claudePermissionMode', cat: 'claude', label: 'Mode de permission', type: 'select', def: 'default', cls: 'mode', options: () => [['default', 'Rien d\'automatique (par défaut) : tout ce qui demande un accord est refusé'], ['acceptEdits', 'Accepter les modifications de fichiers (acceptEdits)']], hint: 'Ce que claude peut faire sans te demander.', after: claudeStatus, sensitive: true },
  { key: 'claudeAllowedTools', cat: 'claude', label: 'Outils autorisés sans accord (--allowedTools)', type: 'lines', def: [], cls: 'claude-tools', placeholder: 'Read\nBash(dotnet build *)', hint: 'Un par ligne, par exemple « Read » ou « Bash(dotnet build *) ». Vide : seules les lectures dans le dossier de travail passent.', after: claudeStatus, sensitive: true },
  { key: 'claudeProjectSettings', cat: 'claude', label: 'Lire les réglages du projet (.claude/settings.json)', type: 'switch', def: false, cls: 'project-settings', hint: 'Désactivé par défaut : seuls tes réglages (~/.claude/settings.json) comptent. Les réglages d\'un projet peuvent lancer des commandes (hooks), autoriser Bash sans accord ou envoyer ta clé à une autre adresse : ne l\'active que pour des projets de confiance.', after: claudeStatus, sensitive: true },

  // MCP
  { id: 'mcp-conversation', cat: 'mcp', label: 'Serveurs de cette conversation', hint: 'Les outils des serveurs cochés sont envoyés au modèle à chaque tour (ils prennent de la place dans le contexte). Enregistré avec la conversation.', show: () => !!conversationServers(), block: conversationServers },
  { key: 'mcpStartTimeout', cat: 'mcp', label: 'Démarrage d\'un serveur au plus (s)', type: 'range', def: 30, min: 5, max: 300, step: 5, hint: 'Lancement, poignée de main et liste des outils (30 s par défaut).' },
  { key: 'mcpCallTimeout', cat: 'mcp', label: 'Durée max d\'un appel d\'outil (s)', type: 'range', def: 60, min: 5, max: 600, step: 5, hint: 'Au-delà, l\'appel est annulé et l\'agent reçoit une erreur (60 s par défaut).' },
  { id: 'mcp-servers', cat: 'mcp', label: 'Serveurs MCP', hint: 'Stdio ou Streamable HTTP, pour le mode Agent : état, outils, journal, Redémarrer, Tester, ajout, import depuis Claude Desktop.', wide: true, keywords: 'stdio http claude desktop outils', block: mcpPanel },

  // Images
  { key: 'imageMaxSide', cat: 'images', label: 'Plus grand côté (px)', type: 'range', def: 1568, min: 512, max: 4096, step: 32, hint: 'Avant l\'envoi, chaque image est réduite à cette taille (1568 par défaut, ce que les modèles Claude lisent sans la réduire encore) et réencodée sans ses métadonnées (EXIF, position GPS…).' },
  { id: 'vision', cat: 'images', label: 'Modèles qui voient les images', hint: 'Détecté automatiquement (Claude, Ollama, llama.cpp) ou réglé à la main, modèle par modèle, dans Fournisseurs → Images.', block: () => h('button', { class: 'btn', onclick: () => go('providers', 'providers') }, icon('image'), 'Ouvrir Fournisseurs') },

  // Calcul
  { key: 'device', cat: 'calc', label: 'Calcul', type: 'select', def: 'auto', cls: 'device', options: () => [['auto', 'Automatique (GPU si disponible)'], ['cpu', 'CPU'], ['gpu', 'GPU']], hint: 'Où tournent les modèles de ce PC. Le modèle chargé est rechargé.', after: reloadModel, keywords: 'gpu cpu cuda nvidia' },
  { id: 'gpu', cat: 'calc', label: 'Carte graphique et pack GPU', hint: 'La carte NVIDIA détectée, le pack CUDA téléchargé à la demande, et le test de vitesse.', keywords: 'nvidia cuda pilote pack vitesse benchmark', block: calcBlock },

  // Suivi et budget
  { key: 'budgetMonthly', cat: 'usage', label: 'Budget mensuel ($)', type: 'number', def: 0, min: 0, max: 1e6, step: 0.01, cls: 'budget', hint: 'Fournisseurs payants seulement ; 0 : aucun budget. Un avertissement à 80 %.' },
  { key: 'budgetConfirm', cat: 'usage', label: 'Confirmer au-delà du budget', type: 'switch', def: true, hint: 'À 100 % du budget, demander confirmation avant chaque nouvelle demande payante.' },
  { id: 'prices', cat: 'usage', label: 'Prix par million de tokens', hint: 'Modèle, entrée, sortie, en $ : une ligne par modèle. Sert aux coûts estimés.', resets: { prices: null }, keywords: 'coût tarif', wide: true, block: pricesBlock },
  { id: 'usage-page', cat: 'usage', label: 'Page Suivi', hint: 'Tokens, coûts estimés et temps de réponse, par jour, modèle et projet ; export CSV.', block: () => h('button', { class: 'btn', onclick: () => { closeSettings(); openUsage(); } }, icon('chart-column'), 'Ouvrir la page Suivi') },

  // Serveur local
  { key: 'serverEnabled', cat: 'server', label: 'Activer le serveur (API OpenAI)', type: 'switch', def: false, hint: 'Pour Continue dans VS Code, ou tout client de l\'API OpenAI. Seulement sur ce PC (127.0.0.1), et seulement avec la clé ci-dessous.', after: applyServer, sensitive: true },
  { key: 'serverPort', cat: 'server', label: 'Port', type: 'number', def: 8765, min: 1024, max: 65535, step: 1, cls: 'port', hint: 'De 1024 à 65535.', after: applyServer },
  { id: 'server-key', cat: 'server', wide: true, label: 'Adresse et clé d\'accès', hint: 'Authorization: Bearer <clé>. Une seule réponse à la fois, avec Nel Code. Brancher Continue : voir le README.', keywords: 'url clé bearer continue', block: serverBlock },

  // Avancé
  { id: 'export', cat: 'advanced', label: 'Exporter ou importer les réglages', hint: 'Un fichier JSON avec tes préférences, jamais de clé ni de secret, ni tes fournisseurs ou tes projets. À l\'import, tu vois ce qui change avant de confirmer.', keywords: 'json sauvegarde transférer', block: () => h('div', { class: 'row-btns' },
    h('button', { class: 'btn', onclick: exportSettings }, icon('download'), 'Exporter…'), h('button', { class: 'btn', onclick: importSettings }, icon('file'), 'Importer…')) },
  { id: 'log', cat: 'advanced', label: 'Journal', hint: 'Un fichier par jour, 7 jours gardés : des événements seulement, jamais le texte de tes conversations.', block: () => h('button', { class: 'btn', onclick: () => invoke('open_folder', { path: S.info.logs }).catch((e) => toast(errText(e), 'error')) }, icon('folder'), 'Ouvrir le dossier du journal') },
  { id: 'bug', cat: 'advanced', label: 'Rapport de bug', hint: 'Version, système, modèle actif et les 50 dernières lignes du journal (jamais tes conversations).', block: () => h('button', { class: 'btn', onclick: copyBugReport }, icon('copy'), 'Copier un rapport de bug') },
  { id: 'about', cat: 'advanced', label: 'À propos', hint: 'Nel Code, licence MIT.', keywords: 'version licence dossier données', block: () => h('dl', { class: 'info-grid about' },
    h('dt', {}, 'Version'), h('dd', {}, S.info.version), h('dt', {}, 'Données'), h('dd', {}, S.info.root), h('dt', {}, 'Système'), h('dd', {}, S.info.os ?? '')) },
];

for (const d of SETTINGS) d.id ??= d.key;

/** Les valeurs par défaut, par clé (aussi celles des blocs, comme la table de prix). */
export const DEFAULTS = Object.fromEntries(SETTINGS.flatMap((d) => (d.key ? [[d.key, d.def]] : Object.entries(d.resets ?? {}))));

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const valueOf = (d) => S.settings[d.key] ?? d.def;
const isDefault = (d) => (d.key ? same(valueOf(d), d.def) : Object.entries(d.resets ?? {}).every(([k, v]) => same(S.settings[k], v)));
const shown = (d) => !d.show || d.show();
// Les nombres des champs : virgule décimale, sans séparateur de milliers (relus tels quels par parseNumber).
const nf = (x) => Number(x).toLocaleString('fr-CH', { maximumFractionDigits: 4, useGrouping: false });
const FIRST_CONTROL = '.setting-control input:not([tabindex="-1"]), .setting-control select, .setting-control textarea, .setting-control button';

// --- Enregistrement --------------------------------------------------------------------------------------
// Une modification à la fois, dans l'ordre (chacune rend tous les réglages : la dernière réponse est la plus récente).

let queue = Promise.resolve();
let savedTimer = 0;

function savedIndicator(state) {
  const el = $('settings-saved');
  if (!el) return;
  clearTimeout(savedTimer);
  el.dataset.state = state;
  el.replaceChildren(...(state === 'saving' ? ['Enregistrement…'] : state === 'saved' ? [icon('check'), 'Enregistré'] : []));
  if (state === 'saved') savedTimer = setTimeout(() => { el.dataset.state = ''; el.replaceChildren(); }, 1800);
}
UI.settingsSaved = () => savedIndicator('saved');

/** Enregistre des changements ({ clé: valeur }) et lance leurs suites ; rend une erreur (texte) ou null. */
export function commit(changes) {
  const run = async () => {
    savedIndicator('saving');
    const before = { ...S.settings };
    try {
      S.settings = await invoke('save_settings', { changes });
    } catch (e) { savedIndicator(''); return errText(e); }
    savedIndicator('saved');
    for (const k of Object.keys(changes)) {
      const d = SETTINGS.find((x) => x.key === k);
      if (d?.after && !same(before[k], S.settings[k])) { try { await d.after(S.settings[k], before[k]); } catch (e) { toast(errText(e), 'error'); } }
    }
    for (const k of Object.keys(changes)) P.rows.get(k)?.refresh();
    return null;
  };
  const p = queue.then(run);
  queue = p.catch(() => {});
  return p;
}

// --- Une ligne de réglage --------------------------------------------------------------------------------

/** Le texte avec la recherche surlignée (<mark>), sans accents ni casse ; textContent seulement. */
function marked(text, q) {
  if (!q) return [text];
  const chars = [...text], folded = chars.map((c) => fold(c)).join('');
  const out = [];
  let from = 0, i;
  // Les index de `folded` suivent ceux de `chars` (fold d'un caractère accentué précomposé : un caractère).
  if (folded.length !== chars.length) return [text];
  while ((i = folded.indexOf(q, from)) >= 0) {
    if (i > from) out.push(chars.slice(from, i).join(''));
    out.push(h('mark', {}, chars.slice(i, i + q.length).join('')));
    from = i + q.length;
  }
  if (from < chars.length) out.push(chars.slice(from).join(''));
  return out;
}

const parseNumber = (raw) => Number(String(raw).trim().replace(',', '.'));

function numberError(d, raw) {
  const n = parseNumber(raw);
  if (String(raw).trim() === '' || !Number.isFinite(n)) return 'Un nombre, s\'il te plaît.';
  if (n < d.min || n > d.max) return `Entre ${nf(d.min)} et ${nf(d.max)}.`;
  if (Number.isInteger(d.step) && !Number.isInteger(n)) return 'Un nombre entier.';
  if (Number.isInteger(d.step) && d.step > 1 && (n - d.min) % d.step) return `Par pas de ${nf(d.step)} (${nf(d.min)}, ${nf(d.min + d.step)}, ${nf(d.min + 2 * d.step)}…).`;
  return null;
}

function settingRow(d, q) {
  const id = 'set-' + d.id;
  const err = h('div', { class: 'setting-error', role: 'alert', id: id + '-err', hidden: true });
  const dot = h('span', { class: 'modified', title: 'Différent de la valeur par défaut', 'aria-label': 'modifié' });
  const reset = h('button', { class: 'icon-btn reset', title: 'Valeur par défaut', 'aria-label': `${d.label} : valeur par défaut`, onclick: () => resetOne(d) }, icon('undo-2'));
  const showError = (text) => { err.hidden = !text; err.textContent = text ?? ''; ctl?.setAttribute('aria-invalid', text ? 'true' : 'false'); };
  // refreshValue(force) : la valeur affichée suit S.settings ; un champ en cours de saisie n'est remis à jour que si
  // le changement vient d'ailleurs (force : Ctrl + / − pendant que le champ du zoom a le focus).
  let ctl = null, control, refreshValue = () => {};
  const save = async (value) => { const e = await commit({ [d.key]: value }); showError(e); };

  if (!d.key) {
    // Un bloc (fournisseurs, clé, GPU…) : rendu à part, parfois après un appel au Rust.
    control = h('div', { class: 'setting-block' });
    Promise.resolve().then(() => d.block()).then((el) => control.replaceChildren(el ?? '')).catch((e) => control.replaceChildren(h('div', { class: 'warn-text' }, errText(e))));
  } else if (d.type === 'switch') {
    ctl = h('input', { type: 'checkbox', role: 'switch', class: 'switch ' + (d.cls ?? ''), id: id + '-ctl' });
    ctl.addEventListener('change', () => save(ctl.checked));
    refreshValue = () => { ctl.checked = !!valueOf(d); };
    control = ctl;
  } else if (d.type === 'select') {
    ctl = h('select', { class: 'text-input ' + (d.cls ?? ''), id: id + '-ctl' });
    const enc = d.encode ?? ((v) => String(v ?? ''));
    refreshValue = () => {
      const opts = d.options();
      ctl.replaceChildren(...opts.map(([v, label]) => h('option', { value: v }, label)));
      const cur = enc(valueOf(d));
      // Une valeur qui n'est plus proposée (modèle supprimé) : l'option par défaut.
      ctl.value = opts.some(([v]) => v === cur) ? cur : enc(d.def);
    };
    ctl.addEventListener('change', () => save(d.decode ? d.decode(ctl.value) : ctl.value));
    control = ctl;
  } else if (d.type === 'range') {
    const range = h('input', { type: 'range', min: d.min, max: d.max, step: d.step, 'aria-label': d.label, tabindex: -1 });
    ctl = h('input', { type: 'text', inputmode: 'decimal', class: 'text-input num ' + (d.cls ?? ''), id: id + '-ctl', 'aria-describedby': id + '-err' });
    let timer = 0;
    range.addEventListener('input', () => { ctl.value = nf(range.value); showError(null); });
    range.addEventListener('change', () => save(Number(range.value)));
    ctl.addEventListener('input', () => {
      clearTimeout(timer);
      const e = numberError(d, ctl.value);
      showError(e);
      if (e) return;
      range.value = parseNumber(ctl.value);
      timer = setTimeout(() => save(parseNumber(ctl.value)), 500);
    });
    ctl.addEventListener('keydown', (e) => {
      // Flèches : un pas, comme le curseur.
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const n = Math.min(d.max, Math.max(d.min, (Number.isFinite(parseNumber(ctl.value)) ? parseNumber(ctl.value) : valueOf(d)) + (e.key === 'ArrowUp' ? 1 : -1) * d.step));
      const v = Number(n.toFixed(4));
      ctl.value = nf(v); range.value = v; showError(null);
      clearTimeout(timer); timer = setTimeout(() => save(v), 300);
    });
    ctl.addEventListener('blur', () => { if (!numberError(d, ctl.value)) { clearTimeout(timer); if (!same(parseNumber(ctl.value), valueOf(d))) save(parseNumber(ctl.value)); } });
    refreshValue = (force) => { if (force || document.activeElement !== ctl) { ctl.value = nf(valueOf(d)); range.value = valueOf(d); } };
    control = h('div', { class: 'range-pair' }, range, ctl);
    ctl.range = range;
  } else if (d.type === 'number') {
    ctl = h('input', { type: 'text', inputmode: 'decimal', class: 'text-input num ' + (d.cls ?? ''), id: id + '-ctl', 'aria-describedby': id + '-err' });
    let timer = 0;
    ctl.addEventListener('input', () => {
      clearTimeout(timer);
      const e = numberError(d, ctl.value);
      showError(e);
      if (!e) timer = setTimeout(() => save(parseNumber(ctl.value)), 600);
    });
    ctl.addEventListener('blur', () => { if (!numberError(d, ctl.value) && !same(parseNumber(ctl.value), valueOf(d))) { clearTimeout(timer); save(parseNumber(ctl.value)); } });
    refreshValue = (force) => { if (force || document.activeElement !== ctl) ctl.value = nf(valueOf(d)); };
    control = ctl;
  } else {
    // text, lines
    const lines = d.type === 'lines';
    ctl = h(lines ? 'textarea' : 'input', { class: 'text-input ' + (d.cls ?? ''), id: id + '-ctl', spellcheck: 'false', rows: lines ? 3 : undefined, placeholder: d.placeholder, list: d.list ? id + '-list' : undefined, 'aria-describedby': id + '-err' });
    const read = () => (lines ? ctl.value.split('\n').map((l) => l.trim()).filter(Boolean) : ctl.value.trim());
    let timer = 0;
    const flush = () => {
      clearTimeout(timer);
      const v = read(), e = d.validate?.(v);
      showError(e);
      if (!e && !same(v, valueOf(d))) save(v);
    };
    ctl.addEventListener('input', () => { clearTimeout(timer); const e = d.validate?.(read()); showError(e); if (!e) timer = setTimeout(flush, 700); });
    ctl.addEventListener('blur', flush);
    // Entrée dans un champ d'une ligne : enregistré tout de suite.
    if (!lines) ctl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); flush(); } });
    refreshValue = (force) => { if (force || document.activeElement !== ctl) ctl.value = lines ? (valueOf(d) ?? []).join('\n') : valueOf(d) ?? ''; };
    control = d.list ? h('div', {}, ctl, h('datalist', { id: id + '-list' }, ...d.list.map((m) => h('option', { value: m })))) : ctl;
  }

  const head = h('div', { class: 'setting-text' },
    h(ctl ? 'label' : 'div', { class: 'setting-label', for: ctl ? ctl.id : undefined }, dot, h('span', {}, marked(d.label, q))),
    h('div', { class: 'setting-hint', id: id + '-hint' }, marked(d.hint ?? '', q)), err);
  if (ctl && !ctl.getAttribute('aria-describedby')) ctl.setAttribute('aria-describedby', id + '-hint ' + id + '-err');
  const el = h('div', { class: 'setting' + (d.wide || d.type === 'lines' ? ' wide' : '') + (d.key ? '' : ' block'), id, 'data-key': d.key ?? '', 'data-id': d.id },
    head, h('div', { class: 'setting-control' }, control, (d.key || d.resets) ? reset : null));
  const refresh = (force) => {
    refreshValue(force);
    const def = isDefault(d);
    el.classList.toggle('changed', !def);
    reset.disabled = def;
  };
  el.refresh = refresh;
  refresh();
  if (d.key) P.rows.set(d.key, el);
  else for (const k of Object.keys(d.resets ?? {})) P.rows.set(k, el);
  return el;
}

async function resetOne(d) {
  const changes = d.key ? { [d.key]: d.def } : { ...d.resets };
  const e = await commit(changes);
  if (e) return toast(e, 'error');
  if (!d.key) draw();   // un bloc (table de prix) : redessiné avec ses valeurs par défaut
  P.rows.get(d.key)?.querySelector('input, select, textarea')?.focus();
}

async function resetCategory(cat) {
  const defs = SETTINGS.filter((d) => d.cat === cat.id && (d.key || d.resets) && !isDefault(d));
  if (!defs.length) return toast(`« ${cat.label} » : tout est déjà à la valeur par défaut.`, '', 3000);
  const ok = await confirmDialog(`Réinitialiser « ${cat.label} » ?`, `Ces réglages reprennent leur valeur par défaut : ${defs.map((d) => d.label).join(', ')}.`, 'Tout réinitialiser', true);
  if (!ok) return;
  const changes = Object.assign({}, ...defs.map((d) => (d.key ? { [d.key]: d.def } : d.resets)));
  const e = await commit(changes);
  if (e) return toast(e, 'error');
  toast(`« ${cat.label} » : valeurs par défaut.`, 'success', 2500);
  draw();
}

// --- La page ---------------------------------------------------------------------------------------------

const P = { cat: 'general', query: '', rows: new Map() };

/** Une ligne affichée à remettre à jour (Ctrl + / − pendant que la page est ouverte). */
export const refreshRow = (key) => P.rows.get(key)?.refresh(true);

function page() {
  let el = $('settings');
  if (el.firstChild) return el;
  const search = h('input', { id: 'settings-search', class: 'search', type: 'search', placeholder: 'Rechercher dans les réglages…  (Ctrl+F)', spellcheck: 'false', 'aria-label': 'Rechercher dans les réglages', 'aria-controls': 'settings-content' });
  search.addEventListener('input', () => { P.query = search.value; draw(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); $('settings-content').querySelector(FIRST_CONTROL)?.focus(); }
    if (e.key === 'Escape' && search.value) { e.preventDefault(); e.stopPropagation(); search.value = ''; P.query = ''; draw(); }
  });
  const nav = h('nav', { class: 'settings-nav', id: 'settings-nav', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Catégories' },
    CATEGORIES.map((c) => h('button', { class: 'cat', role: 'tab', id: 'cat-' + c.id, 'data-cat': c.id, 'aria-controls': 'settings-content', onclick: () => go(c.id) }, icon(c.icon), h('span', {}, c.label))));
  nav.addEventListener('keydown', (e) => {
    const i = CATEGORIES.findIndex((c) => c.id === P.cat);
    const j = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: CATEGORIES.length - 1 }[e.key];
    if (j !== undefined) { e.preventDefault(); go(CATEGORIES[(j + CATEGORIES.length) % CATEGORIES.length].id); $('cat-' + P.cat).focus(); }
    if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); $('settings-content').querySelector(FIRST_CONTROL)?.focus(); }
  });
  el.append(
    h('header', { class: 'settings-head' }, h('h1', {}, icon('settings'), 'Réglages'), search,
      h('span', { id: 'settings-saved', class: 'saved', role: 'status', 'aria-live': 'polite' }),
      h('button', { class: 'icon-btn close', title: 'Fermer (Échap)', 'aria-label': 'Fermer les réglages', onclick: closeSettings }, icon('x'))),
    h('div', { class: 'settings-body' }, nav, h('main', { id: 'settings-content', class: 'settings-content', role: 'tabpanel', tabindex: -1 })));
  el.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.focus(); search.select(); }
  });
  return el;
}

/** Dessine la catégorie choisie, ou les résultats de la recherche (toutes catégories). */
function draw() {
  const content = $('settings-content');
  if (!content) return;
  P.rows.clear();
  UI.mcpRedraw = null;
  UI.serverRedraw = null;
  const q = fold(P.query.trim());
  for (const b of $('settings-nav').querySelectorAll('.cat')) {
    const on = !q && b.dataset.cat === P.cat;
    b.classList.toggle('sel', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = b.dataset.cat === P.cat ? 0 : -1;
  }
  if (q) {
    const hits = SETTINGS.filter((d) => shown(d) && fold([d.label, d.hint, d.keywords, d.group, catOf(d.cat).label].filter(Boolean).join(' ')).includes(q));
    const groups = CATEGORIES.map((c) => [c, hits.filter((d) => d.cat === c.id)]).filter(([, l]) => l.length);
    content.replaceChildren(h('div', { class: 'settings-results', 'aria-live': 'polite' }, hits.length ? `${hits.length} réglage${hits.length > 1 ? 's' : ''} trouvé${hits.length > 1 ? 's' : ''}` : `Aucun réglage ne correspond à « ${P.query.trim()} ».`),
      ...groups.map(([c, list]) => h('section', { class: 'settings-section cat-' + c.id },
        h('h2', {}, h('button', { class: 'link', onclick: () => go(c.id) }, c.label)),
        // Les blocs (fournisseurs, GPU…) : un lien vers leur catégorie, pas leur contenu en double.
        list.map((d) => (d.key ? settingRow(d, q) : linkRow(d, q))))));
    return;
  }
  const cat = catOf(P.cat);
  const defs = SETTINGS.filter((d) => d.cat === cat.id && shown(d));
  const out = [];
  let group = null;
  for (const d of defs) {
    if (d.group && d.group !== group) out.push(h('h3', {}, d.group));
    group = d.group ?? group;
    out.push(settingRow(d, ''));
  }
  const resettable = defs.some((d) => d.key || d.resets);
  content.replaceChildren(h('section', { class: 'settings-section cat-' + cat.id },
    h('div', { class: 'section-head' }, h('h2', {}, cat.label),
      resettable ? h('button', { class: 'btn reset-all', onclick: () => resetCategory(cat) }, icon('undo-2'), 'Tout réinitialiser') : null),
    out));
  content.scrollTop = 0;
}

function linkRow(d, q) {
  return h('div', { class: 'setting block link-row', 'data-id': d.id },
    h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, h('span', {}, marked(d.label, q))), h('div', { class: 'setting-hint' }, marked(d.hint ?? '', q))),
    h('div', { class: 'setting-control' }, h('button', { class: 'btn', onclick: () => go(d.cat, d.id) }, `Ouvrir ${catOf(d.cat).label}`, icon('chevron-right'))));
}

/** Montre une catégorie ; `id` : un réglage à faire voir (défilé jusqu'à lui, surligné, avec le focus). */
export function go(cat, id) {
  P.cat = catOf(cat) ? cat : 'general';
  P.query = '';
  const search = $('settings-search');
  if (search) search.value = '';
  draw();
  if (id) highlight(id);
}

function highlight(id) {
  const el = $('settings-content').querySelector(`.setting[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  (el.querySelector('.setting-control input:not([tabindex="-1"]), .setting-control select, .setting-control textarea') ?? el.querySelector('button'))?.focus({ preventScroll: true });
}

/** Ouvre la page Réglages : `cat` (id, nom ou alias, comme /settings gpu), `id` : un réglage à montrer. */
export async function openSettings(cat, id) {
  if (typeof cat !== 'string') cat = undefined;   // clic sur un bouton : l'événement
  const c = cat ? findCategory(cat) : null;
  if (cat && !c) toast(`Catégorie inconnue : ${cat}. Catégories : ${CATEGORIES.map((x) => x.alias[0]).join(', ')}.`, 'warning', 6000);
  UI.closeOverlay?.();
  if (S.providers.length === 0) S.providers = await invoke('list_providers').catch(() => []);
  const el = page();
  el.hidden = false;
  $('app').inert = true;
  UI.page = { close: closeSettings };
  go(c?.id ?? (cat ? 'general' : P.cat), id);
  if (!id) (c ? $('cat-' + P.cat) : $('settings-search')).focus();
}

export function closeSettings() {
  const el = $('settings');
  if (!el || el.hidden) return;
  // Un champ en cours de saisie : enregistré avant de fermer.
  document.activeElement?.blur?.();
  el.hidden = true;
  $('app').inert = false;
  UI.page = null;
  UI.mcpRedraw = null;
  UI.serverRedraw = null;
  $('settings-content').replaceChildren();
  P.rows.clear();
  refreshMcp();
  renderModels();
  renderStatus();
  refreshContext();
  $('input').focus();
}

// --- Export et import ------------------------------------------------------------------------------------

async function exportSettings() {
  try {
    const path = await invoke('export_settings');
    if (path) toast(`Réglages exportés : ${path}`, 'success', 6000);
  } catch (e) { toast('Export impossible : ' + errText(e), 'error'); }
}

async function importSettings() {
  let r;
  try { r = await invoke('import_settings'); } catch (e) { return toast('Import impossible : ' + errText(e), 'error', 8000); }
  if (r) await applyImport(r);
}

/** Montre ce que l'import change (les réglages qui touchent à la sécurité en premier), puis l'enregistre. */
export async function applyImport({ changes, ignored = [] }) {
  const label = (k) => SETTINGS.find((d) => d.key === k)?.label ?? k;
  const show = (k, v) => {
    const d = SETTINGS.find((x) => x.key === k);
    if (Array.isArray(v)) return v.length ? v.join(', ') : '(vide)';
    if (d?.type === 'switch') return v ? 'activé' : 'désactivé';
    if (d?.type === 'select') return d.options().find(([o]) => o === (d.encode ?? String)(v ?? ''))?.[1] ?? String(v ?? '—');
    if (v === null || v === undefined) return 'par défaut';
    return String(v);
  };
  const diff = Object.entries(changes).filter(([k, v]) => !same(S.settings[k] ?? DEFAULTS[k], v ?? DEFAULTS[k]));
  if (!diff.length) return toast('Ces réglages sont déjà les tiens : rien ne change.', '', 4000);
  const sensitive = (k) => SETTINGS.find((d) => d.key === k)?.sensitive;
  diff.sort(([a], [b]) => Number(!!sensitive(b)) - Number(!!sensitive(a)));
  const rows = diff.map(([k, v]) => h('li', { class: sensitive(k) ? 'sensitive' : '' }, sensitive(k) ? icon('circle-alert') : null,
    h('b', {}, label(k)), ` : ${show(k, S.settings[k] ?? DEFAULTS[k])} → ${show(k, v)}`));
  const body = [h('p', {}, `${diff.length} réglage${diff.length > 1 ? 's' : ''} change${diff.length > 1 ? 'nt' : ''} :`), h('ul', { class: 'import-diff' }, rows),
    diff.some(([k]) => sensitive(k)) ? h('p', { class: 'warn-text' }, icon('circle-alert'), 'Les réglages marqués touchent à la sécurité (commandes, fichiers protégés, claude, serveur local) : n\'importe que des fichiers de confiance.') : null,
    ignored.length ? h('p', { class: 'hint' }, `Ignorés (pas des préférences portables) : ${ignored.join(', ')}.`) : null];
  if (await dialog('Importer des réglages', body, [{ label: 'Annuler', value: false }, { label: 'Importer', value: true, primary: true }]) !== true) return;
  const e = await commit(Object.fromEntries(diff));
  if (e) return toast('Import : ' + e, 'error');
  toast(`${diff.length} réglage${diff.length > 1 ? 's' : ''} importé${diff.length > 1 ? 's' : ''}.`, 'success');
  draw();
}

/** La palette Ctrl+K : chaque catégorie et chaque réglage. */
export function paletteItems() {
  return [...CATEGORIES.map((c) => ({ kind: 'Réglages', text: `Réglages : ${c.label}`, key: '', run: () => openSettings(c.id) })),
    ...SETTINGS.filter((d) => d.key || d.block).map((d) => ({ kind: 'Réglage', text: `${d.label} (${catOf(d.cat).label})`, key: '', search: d.keywords, run: () => openSettings(d.cat, d.id) }))];
}
