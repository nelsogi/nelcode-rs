// Nel Code Desktop — settings.js : Les réglages : fenêtre des réglages, mises à jour, serveur local, calcul (GPU, test de vitesse).
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

// Thème (settings.json, partagé avec Nel Code C#) et couleur d'accent : des attributs sur <html>, lus par style.css.

import { $, dialog, errText, h, invoke, logEvent, sizeText, toast } from './util.js';
import { S } from './state.js';
import { loadModel, renderStatus, turnsOf } from './conversation.js';
import { claudeSection } from './agent.js';
import { providersSection } from './providers.js';

export function applyTheme() {
  const d = document.documentElement.dataset;
  d.theme = S.settings.theme === 'light' ? 'light' : 'dark';
  d.accent = S.settings.accent === 'orange' ? 'orange' : 'red';
}

/** La taille du texte (80 à 150 %) : le zoom de la page entière (icônes, marges et textes ensemble). */
export function applyTextSize() {
  return invoke('set_zoom', { scale: (S.settings.textSize ?? 100) / 100 }).catch(() => {});
}

/** Ctrl + = / - / 0 : la taille du texte, par pas de 10 %, enregistrée. */
export async function stepTextSize(delta) {
  const size = delta === 0 ? 100 : Math.min(150, Math.max(80, (S.settings.textSize ?? 100) + delta));
  // Tout de suite : deux appuis rapides comptent deux fois (sans attendre l'enregistrement du premier).
  S.settings.textSize = size;
  applyTextSize();
  S.settings = { ...S.settings, ...(await invoke('save_settings', { changes: { textSize: size } })), textSize: S.settings.textSize };
  toast(`Taille du texte : ${S.settings.textSize} %`, '', 1500);
}

// --- Mises à jour (tauri-plugin-updater) -----------------------------------------------------------------

export const UPDATE_EVERY = 864e5;   // vérification automatique : au plus une fois par jour
// state : idle | available | downloading | waiting (téléchargée, une réponse s'écrit) | installing
export const U = { state: 'idle', update: null, checking: false, idle: null };

export function updateError(e) {
  const t = errText(e);
  if (/signature/i.test(t)) return 'Mise à jour refusée : signature invalide.';
  // « Could not fetch a valid release JSON » : hors ligne, ou latest.json absent de la dernière release.
  if (/release JSON|request|connect|dns|resolve|network|timed? ?out/i.test(t)) return 'Mises à jour : impossible de joindre GitHub (pas de connexion ?).';
  return 'Mise à jour impossible : ' + t;
}

// manual : depuis la palette ou les réglages (dit aussi « à jour », et l'erreur est un vrai toast d'erreur).
export async function checkUpdate(manual) {
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
export async function installUpdate() {
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

export function renderUpdate() {
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

export async function openSettings() {
  const s = S.settings;
  const fields = [
    { key: 'temperature', label: 'Température', min: 0.1, max: 2, step: 0.05, hint: 'Bas : réponses sages et répétitives. Haut : plus créatives, plus de fautes.' },
    { key: 'topK', label: 'Top-k', min: 0, max: 100, step: 1, hint: 'Tirage parmi les K tokens les plus probables (0 = pas de limite).' },
    { key: 'topP', label: 'Top-p', min: 0.05, max: 1, step: 0.01, hint: 'Tirage parmi les tokens qui font cette part des chances (1 = pas de limite).' },
    { key: 'maxReplyTokens', label: 'Longueur max', min: 16, max: 128, step: 1, hint: 'Longueur maximale d\'une réponse d\'un .nelmodel, en tokens (environ 3 caractères chacun). Un modèle GGUF écrit jusqu\'à 1024 tokens et s\'arrête de lui-même.' },
    { key: 'repetitionPenalty', label: 'Pénalité de répétition', min: 1, max: 2, step: 0.01, hint: 'Rend moins probables les tokens des 64 derniers (prompt compris), pour éviter que le modèle tourne en boucle. 1 = désactivée ; trop haut, il évite même les mots utiles.' },
    { key: 'agentMaxTurns', label: 'Mode Agent : tours au plus', min: 1, max: 50, step: 1, hint: 'Combien de fois le modèle peut demander des outils (lire, chercher, écrire) avant de devoir répondre.' },
    { key: 'commandTimeout', label: 'Mode Agent : durée max d\'une commande (s)', min: 5, max: 600, step: 5, hint: 'Au-delà, la commande et tous ses processus sont arrêtés (120 s par défaut).' },
    { key: 'textSize', label: 'Taille du texte (%)', min: 80, max: 150, step: 10, hint: 'Toute l\'interface grandit ou rapetisse (Ctrl + = / Ctrl + - ; Ctrl + 0 : 100 %).' },
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
  const claude = await claudeSection();
  body.push(srv.el, await providersSection(), claude.el);
  const allowedCommands = h('textarea', { class: 'text-input commands', rows: 2, spellcheck: 'false', placeholder: 'dotnet build\ndotnet test' });
  allowedCommands.value = (s.allowedCommands ?? []).join('\n');
  body.push(h('label', { class: 'field' }, h('div', { class: 'row' }, h('span', {}, 'Commandes autorisées sans confirmation')), allowedCommands,
    h('div', { class: 'hint' }, 'Une par ligne, par exemple « dotnet build » (autorise aussi « dotnet build src/App.csproj »). Vide par défaut : chaque commande de l\'agent demande Lancer / Refuser. Jamais de shell (cmd, PowerShell…).')));
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
      ? { temperature: 0.8, topK: 20, topP: 0.9, maxReplyTokens: 80, repetitionPenalty: 1.15, contextLimit: 8192, agentMaxTurns: 10, commandTimeout: 120, textSize: 100, claudePermissionMode: 'default', claudeModel: '', accent: 'red', autoUpdate: true, device: 'auto', serverEnabled: false, serverPort: 8765 }
      : { ...Object.fromEntries(fields.map((f) => [f.key, Number(inputs[f.key].value)])), accent: accent.value, autoUpdate: auto.checked, device: calc.device.value,
        serverEnabled: srv.enabled.checked, serverPort: Number(srv.port.value), protectedFiles: protectedFiles.value.split('\n').map((l) => l.trim()).filter(Boolean),
        allowedCommands: allowedCommands.value.split('\n').map((l) => l.trim()).filter(Boolean),
        claudePermissionMode: claude.mode.value, claudeModel: claude.model.value.trim(), claudeAllowedTools: claude.tools.value.split('\n').map((l) => l.trim()).filter(Boolean) };
    const before = s.device ?? 'auto', limit = s.contextLimit;
    try { S.settings = await invoke('save_settings', { changes }); toast('Réglages enregistrés.', 'success'); } catch (e) { toast(errText(e), 'error'); }
    applyTextSize();
    try { S.server.port = await invoke('server_apply'); } catch (e) { S.server.port = null; toast('Serveur local : ' + errText(e), 'error', 8000); }
    renderStatus();
    // Un autre périphérique, ou un autre contexte pour un modèle GGUF : le modèle est rechargé.
    const gguf = S.models.find((m) => m.name === S.model.name)?.weights === 'gguf';
    if (S.model.name && ((S.settings.device ?? 'auto') !== before || (gguf && S.settings.contextLimit !== limit))) loadModel(S.model.name);
  }
  applyTheme();
}

// --- Serveur local (API OpenAI) ------------------------------------------------------------------------

// La section Serveur local des réglages : rend { el, enabled, port } (enregistrés avec les autres réglages).
export async function serverSection(s) {
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

// --- Calcul : GPU, pack GPU, test de vitesse ------------------------------------------------------------

export const G = { installing: false, received: 0, total: 0 };   // le pack GPU en cours d'installation

export async function copyBugReport() {
  try {
    await navigator.clipboard.writeText(await invoke('bug_report'));
    toast('Rapport de bug copié : colle-le dans une issue GitHub.', 'success');
  } catch (e) { toast('Rapport impossible : ' + errText(e), 'error'); }
}

// La section Calcul des réglages : rend { el, device } (le choix est enregistré avec les autres réglages).
export async function calcSection(s) {
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

export function gpuProgress() {
  const fill = $('gpu-fill'), text = $('gpu-text');
  if (!fill) return;
  fill.style.width = G.total ? (100 * G.received / G.total).toFixed(1) + '%' : '0';
  text.textContent = G.extracting ? 'Vérification et installation…' : `Téléchargement… ${sizeText(G.received)} / ${sizeText(G.total)}`;
}

export async function installPack(redraw) {
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

export async function removePack(redraw) {
  try {
    const now = await invoke('remove_gpu_pack');
    toast(now ? 'Pack GPU retiré.' : 'Pack GPU retiré au prochain démarrage (il est en cours d\'utilisation).', 'success');
    if (!now && S.model.name) loadModel(S.model.name);   // rechargé sur le CPU
  } catch (e) { toast(errText(e), 'error'); }
  redraw();
}

export async function runBenchmark() {
  if (!S.model.name) return toast('Charge d\'abord un modèle.', 'warning');
  if (S.model.remote) return toast('Le test de vitesse ne mesure que les modèles de ce PC.', 'warning');
  if (S.gen || S.bench) return toast('Attends la fin de la réponse en cours.', 'warning');
  try { await invoke('benchmark'); } catch (e) { return toast(errText(e), 'error'); }
  S.bench = 'CPU';
  renderStatus();
}

// Les résultats gardés (benchmarks.json) : le dernier test de chaque modèle, sur chaque périphérique.
export async function showBenchmarks(all) {
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

export async function showInfo() {
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
