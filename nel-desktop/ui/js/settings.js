// Nel Code Desktop — settings.js : Thème, zoom et densité, mises à jour, blocs Serveur local et Calcul (GPU, test de
// vitesse) de la page Réglages (settings-page.js), infos.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

// Thème (settings.json, partagé avec Nel Code C#) et couleur d'accent : des attributs sur <html>, lus par style.css.

import { $, dialog, errText, h, invoke, logEvent, sizeText, toast } from './util.js';
import { S, UI } from './state.js';
import { loadModel, renderStatus, turnsOf } from './conversation.js';
import { refreshRow } from './settings-page.js';

export { openSettings } from './settings-page.js';

export function applyTheme() {
  const d = document.documentElement.dataset;
  d.theme = S.settings.theme === 'light' ? 'light' : 'dark';
  d.accent = S.settings.accent === 'orange' ? 'orange' : 'red';
}

/** La densité de l'interface (compacte, normale, confortable) : un attribut sur <html>, lu par style.css. */
export function applyDensity() {
  document.documentElement.dataset.density = ['compact', 'comfortable'].includes(S.settings.density) ? S.settings.density : 'normal';
}

/** Le zoom (80 à 150 %, réglage textSize) : celui de la page entière (icônes, marges et textes ensemble). */
export function applyTextSize() {
  return invoke('set_zoom', { scale: (S.settings.textSize ?? 100) / 100 }).catch(() => {});
}

/** Ctrl + / − / 0 : le zoom, par pas de 10 %, enregistré. */
export async function stepTextSize(delta) {
  const size = delta === 0 ? 100 : Math.min(150, Math.max(80, (S.settings.textSize ?? 100) + delta));
  // Tout de suite : deux appuis rapides comptent deux fois (sans attendre l'enregistrement du premier).
  S.settings.textSize = size;
  applyTextSize();
  S.settings = { ...S.settings, ...(await invoke('save_settings', { changes: { textSize: size } })), textSize: S.settings.textSize };
  refreshRow('textSize');
  toast(`Zoom : ${S.settings.textSize} %`, '', 1500);
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
  // Linux, paquet .deb : pas de mise à jour automatique (seule l'AppImage se remplace elle-même).
  if (S.info.selfUpdate === false) {
    if (manual) toast('Nel Code est installé par le paquet .deb : télécharge le nouveau .deb sur la page des versions (GitHub) et installe-le.', '', 8000);
    return;
  }
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

// --- Serveur local (API OpenAI) ------------------------------------------------------------------------

/** Réglages → Serveur local : état, adresse, clé d'accès (Copier, Nouvelle clé). L'activation et le port sont des
 *  réglages ordinaires. */
export async function serverBlock() {
  let st = await invoke('server_status');
  if (!st.key) { await invoke('regenerate_server_key'); st = await invoke('server_status'); }   // une clé dès la première ouverture
  const key = h('input', { class: 'text-input key', readonly: true, spellcheck: 'false', value: st.key, 'aria-label': 'Clé d\'accès' });
  const state = h('span', { class: 'state' }), url = h('span', { class: 'url' });
  const redraw = async () => {
    const now = await invoke('server_status').catch(() => st);
    state.className = 'state' + (now.port ? ' on' : '');
    state.textContent = now.port ? `actif sur le port ${now.port}` : 'arrêté';
    url.textContent = `http://127.0.0.1:${S.settings.serverPort}/v1`;
  };
  UI.serverRedraw = redraw;
  await redraw();
  return h('div', { class: 'server-block' }, h('div', { class: 'row-btns' }, state, h('span', { class: 'hint' }, 'Adresse :'), url),
    h('div', { class: 'row-btns' }, key,
      h('button', { class: 'btn', title: 'Copier la clé', onclick: async () => { await navigator.clipboard.writeText(key.value); toast('Clé copiée.', 'success', 2000); } }, icon('copy'), 'Copier'),
      h('button', { class: 'btn', title: 'Nouvelle clé : l\'ancienne ne marche plus', onclick: async () => { key.value = await invoke('regenerate_server_key'); toast('Nouvelle clé : l\'ancienne ne marche plus.', 'success'); } }, icon('refresh-cw'), 'Nouvelle clé')));
}

// --- Calcul : GPU, pack GPU, test de vitesse ------------------------------------------------------------

export const G = { installing: false, received: 0, total: 0 };   // le pack GPU en cours d'installation

export async function copyBugReport() {
  try {
    await navigator.clipboard.writeText(await invoke('bug_report'));
    toast('Rapport de bug copié : colle-le dans une issue GitHub.', 'success');
  } catch (e) { toast('Rapport impossible : ' + errText(e), 'error'); }
}

/** Réglages → Calcul : la carte NVIDIA, le pack GPU et le test de vitesse (le choix CPU/GPU est un réglage ordinaire). */
export async function calcBlock() {
  const st = await invoke('gpu_status');
  const info = h('div', { class: 'gpu-info' });
  const el = h('div', { class: 'calc-block' }, info,
    h('div', { class: 'row-btns' }, h('button', { class: 'btn', onclick: () => runBenchmark() }, icon('gauge'), 'Tester la vitesse'),
      h('button', { class: 'btn', onclick: () => showBenchmarks() }, 'Résultats des tests')));
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
  return el;
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
