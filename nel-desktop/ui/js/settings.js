// Nel Code Desktop — settings.js : Thème, zoom et densité, mises à jour, blocs Serveur local et Calcul (GPU, test de
// vitesse) de la page Réglages (settings-page.js), infos.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

// Thème (settings.json, partagé avec Nel Code C#) et couleur d'accent : des attributs sur <html>, lus par style.css.

import { applyStatic, loadLang, locale, t } from './i18n.js';
import { $, dialog, errText, h, invoke, logEvent, sizeText, toast } from './util.js';
import { S, UI } from './state.js';
import { loadModel, renderAll, renderStatus, turnsOf } from './conversation.js';
import { refreshRow, relabelSettings } from './settings-page.js';

export { openSettings } from './settings-page.js';

export function applyTheme() {
  const d = document.documentElement.dataset;
  d.theme = S.settings.theme === 'light' ? 'light' : 'dark';
  d.accent = S.settings.accent === 'orange' ? 'orange' : 'red';
}

/** La langue (réglage Langue) : appliquée sans redémarrer, tout est redessiné dans la nouvelle. */
export async function applyLanguage() {
  await loadLang(S.settings.language);
  applyStatic();
  $('folder-open').title = t('main.ouvrir_dossier_dans', { fileManager: S.info.fileManager });
  renderAll();
  renderUpdate();
  relabelSettings();
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
  toast(t('settings.zoom', { textSize: S.settings.textSize }), '', 1500);
}

// --- Mises à jour (tauri-plugin-updater) -----------------------------------------------------------------

export const UPDATE_EVERY = 864e5;   // vérification automatique : au plus une fois par jour
// state : idle | available | downloading | waiting (téléchargée, une réponse s'écrit) | installing
export const U = { state: 'idle', update: null, checking: false, idle: null };

export function updateError(e) {
  const tx = errText(e);
  if (/signature/i.test(tx)) return t('settings.mise_jour_refusee_signature_invalide');
  // « Could not fetch a valid release JSON » : hors ligne, ou latest.json absent de la dernière release.
  if (/release JSON|request|connect|dns|resolve|network|timed? ?out/i.test(tx)) return t('settings.mises_jour_impossible_joindre_github');
  return t('settings.mise_jour_impossible', { value: tx });
}

// manual : depuis la palette ou les réglages (dit aussi « à jour », et l'erreur est un vrai toast d'erreur).
export async function checkUpdate(manual) {
  if (U.checking || (U.state !== 'idle' && U.state !== 'available')) return;
  // Linux, paquet .deb : pas de mise à jour automatique (seule l'AppImage se remplace elle-même).
  if (S.info.selfUpdate === false) {
    if (manual) toast(t('settings.nel_code_est_installe_par'), '', 8000);
    return;
  }
  U.checking = true;
  try {
    const update = await window.__TAURI__.updater.check();
    if (update) { U.update = update; U.state = 'available'; renderUpdate(); logEvent(`update ${update.version} available`); }
    else if (manual) toast(t('settings.nel_code_est_jour', { version: S.info.version }), 'success', 3000);
  } catch (e) {
    if (!manual) logEvent('update check: ' + errText(e), 'error');
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
        $('update-text').textContent = total ? t('settings.telechargement', { Math: Math.floor(100 * got / total) }) : t('settings.telechargement_2', { sizeText: sizeText(got) });
      }
    });
    if (S.gen) { U.state = 'waiting'; renderUpdate(); await new Promise((r) => (U.idle = () => { U.idle = null; r(); })); }
    U.state = 'installing'; renderUpdate();
    logEvent(`installing update ${u.version}`);
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
  const status = { downloading: t('settings.telechargement_3'), waiting: t('settings.telechargee_installation_fin_reponse_cours'), installing: t('settings.installation_nel_code_va_redemarrer') }[U.state];
  box.replaceChildren(
    h('div', { class: 'head' }, icon('download'), h('b', {}, t('settings.nel_code_est_disponible', { version: u.version })), h('span', { class: 'meta' }, `version actuelle ${u.currentVersion}`)),
    notes ? h('div', { class: 'notes' }, notes) : '',
    status
      ? h('div', { class: 'progress' }, h('div', { class: 'bar' }, h('div', { id: 'update-fill', style: U.state === 'downloading' ? 'width:0' : 'width:100%' })), h('span', { id: 'update-text' }, status))
      : h('div', { class: 'buttons' },
        h('button', { class: 'btn', onclick: () => { U.state = 'idle'; renderUpdate(); } }, t('settings.plus_tard')),
        h('button', { class: 'btn primary', onclick: installUpdate }, icon('download'), t('settings.installer'))));
}

// --- Serveur local (API OpenAI) ------------------------------------------------------------------------

/** Réglages → Serveur local : état, adresse, clé d'accès (Copier, Nouvelle clé). L'activation et le port sont des
 *  réglages ordinaires. */
export async function serverBlock() {
  let st = await invoke('server_status');
  if (!st.key) { await invoke('regenerate_server_key'); st = await invoke('server_status'); }   // une clé dès la première ouverture
  const key = h('input', { class: 'text-input key', readonly: true, spellcheck: 'false', value: st.key, 'aria-label': t('settings.cle_acces') });
  const state = h('span', { class: 'state' }), url = h('span', { class: 'url' });
  const redraw = async () => {
    const now = await invoke('server_status').catch(() => st);
    state.className = 'state' + (now.port ? ' on' : '');
    state.textContent = now.port ? t('settings.actif_sur_port', { port: now.port }) : t('settings.arrete');
    url.textContent = t('settings.http_127_v1', { serverPort: S.settings.serverPort });
  };
  UI.serverRedraw = redraw;
  await redraw();
  return h('div', { class: 'server-block' }, h('div', { class: 'row-btns' }, state, h('span', { class: 'hint' }, t('settings.adresse')), url),
    h('div', { class: 'row-btns' }, key,
      h('button', { class: 'btn', title: t('settings.copier_cle'), onclick: async () => { await navigator.clipboard.writeText(key.value); toast(t('settings.cle_copiee'), 'success', 2000); } }, icon('copy'), t('settings.copier')),
      h('button', { class: 'btn', title: t('settings.nouvelle_cle_ancienne_ne_marche'), onclick: async () => { key.value = await invoke('regenerate_server_key'); toast(t('settings.nouvelle_cle_ancienne_ne_marche_2'), 'success'); } }, icon('refresh-cw'), t('settings.nouvelle_cle'))));
}

// --- Calcul : GPU, pack GPU, test de vitesse ------------------------------------------------------------

export const G = { installing: false, received: 0, total: 0 };   // le pack GPU en cours d'installation

export async function copyBugReport() {
  try {
    await navigator.clipboard.writeText(await invoke('bug_report'));
    toast(t('settings.rapport_bug_copie_colle_dans'), 'success');
  } catch (e) { toast(t('settings.rapport_impossible', { error: errText(e) }), 'error'); }
}

/** Réglages → Calcul : la carte NVIDIA, le pack GPU et le test de vitesse (le choix CPU/GPU est un réglage ordinaire). */
export async function calcBlock() {
  const st = await invoke('gpu_status');
  const info = h('div', { class: 'gpu-info' });
  const el = h('div', { class: 'calc-block' }, info,
    h('div', { class: 'row-btns' }, h('button', { class: 'btn', onclick: () => runBenchmark() }, icon('gauge'), t('settings.tester_vitesse')),
      h('button', { class: 'btn', onclick: () => showBenchmarks() }, t('settings.resultats_tests'))));
  const draw = (st) => {
    const lines = [];
    if (!st.compiled) lines.push(h('div', { class: 'hint' }, t('settings.cette_version_nel_code_est')));
    else if (!st.card) lines.push(h('div', { class: 'hint' }, t('settings.aucune_carte_nvidia_detectee_cpu')));
    else {
      lines.push(h('div', {}, t('settings.pilote_cuda', { card: st.card, v1: st.driver ?? '?', v2: st.driverCuda ?? '?' })));
      if (!st.driverOk) lines.push(h('div', { class: 'warn-text' }, t('settings.ce_pilote_est_trop_ancien', { needCuda: st.needCuda, needDriver: st.needDriver }),
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); invoke('open_driver_page'); } }, t('settings.telecharger_pilote_nvidia'))));
      if (st.active) lines.push(h('div', { class: 'hint' }, t('settings.actif', { active: st.active })));
      if (st.error) lines.push(h('div', { class: 'warn-text' }, t('settings.gpu_indisponible', { error: st.error })));
      if (G.installing) lines.push(h('div', { class: 'progress' }, h('div', { class: 'bar' }, h('div', { id: 'gpu-fill' })), h('span', { id: 'gpu-text' }, t('settings.telechargement_3')),
        h('button', { class: 'btn', onclick: () => invoke('cancel_gpu_pack') }, t('settings.annuler'))));
      else if (st.installed) lines.push(h('button', { class: 'btn', onclick: () => removePack(redraw) }, t('settings.retirer_pack_gpu')));
      else lines.push(h('button', { class: 'btn', onclick: () => installPack(redraw) }, icon('download'), t('settings.installer_pack_gpu', { sizeText: sizeText(st.packBytes) })),
        h('div', { class: 'hint' }, t('settings.bibliotheques_cuda_nvidia_dans_appdata')));
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
  text.textContent = G.extracting ? t('settings.verification_installation') : t('settings.telechargement_4', { sizeText: sizeText(G.received), sizeText2: sizeText(G.total) });
}

export async function installPack(redraw) {
  Object.assign(G, { installing: true, received: 0, total: 0, extracting: false });
  redraw();
  try {
    await invoke('install_gpu_pack');
    toast(t('settings.pack_gpu_installe_modele_est'), 'success');
    if (S.model.name && S.settings.device !== 'cpu') loadModel(S.model.name);
  } catch (e) {
    toast(errText(e) === 'annulé' ? t('settings.installation_pack_gpu_annulee') : t('settings.pack_gpu', { error: errText(e) }), errText(e) === 'annulé' ? 'warning' : 'error', 8000);
  }
  G.installing = false;
  redraw();
}

export async function removePack(redraw) {
  try {
    const now = await invoke('remove_gpu_pack');
    toast(now ? t('settings.pack_gpu_retire') : t('settings.pack_gpu_retire_au_prochain'), 'success');
    if (!now && S.model.name) loadModel(S.model.name);   // rechargé sur le CPU
  } catch (e) { toast(errText(e), 'error'); }
  redraw();
}

export async function runBenchmark() {
  if (!S.model.name) return toast(t('settings.charge_abord_modele'), 'warning');
  if (S.model.remote) return toast(t('settings.test_vitesse_ne_mesure_que'), 'warning');
  if (S.gen || S.bench) return toast(t('settings.attends_fin_reponse_cours'), 'warning');
  try { await invoke('benchmark'); } catch (e) { return toast(errText(e), 'error'); }
  S.bench = 'CPU';
  renderStatus();
}

// Les résultats gardés (benchmarks.json) : le dernier test de chaque modèle, sur chaque périphérique.
export async function showBenchmarks(all) {
  all ??= await invoke('benchmarks');
  const rows = Object.entries(all).flatMap(([model, by]) => ['cpu', 'gpu'].filter((d) => by[d]).map((d) => [model, by[d]]));
  const n = (x, digits) => Number(x).toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const body = rows.length
    ? h('table', { class: 'board' }, h('tr', {}, [t('settings.modele'), t('settings.calcul'), t('settings.chargement'), t('settings.prompt'), t('settings.tokens')].map((tx) => h('th', {}, tx))),
      rows.map(([model, r]) => h('tr', { title: t('settings.tokens_ecrits', { tokens: r.tokens, v1: new Date(Number(r.date)).toLocaleString(locale()) }) },
        h('td', {}, model), h('td', {}, r.device), h('td', {}, n(r.loadSeconds, 2) + ' s'), h('td', {}, t('settings.tok', { n: n(r.promptSeconds, 2), promptTokens: r.promptTokens })), h('td', {}, n(r.tokensPerSecond, 1)))))
    : h('p', {}, t('settings.pas_encore_test_tester_vitesse'));
  dialog(t('settings.test_vitesse'), [body, h('div', { class: 'hint', style: 'margin-top:8px' }, t('settings.200_tokens_gloutons_prompt_temps'))],
    [{ label: t('settings.tester_modele_charge'), value: 'run' }, { label: t('settings.fermer'), value: null, primary: true }]).then((v) => v && runBenchmark());
}

export async function showInfo() {
  const st = await invoke('model_status');
  const s = S.settings;
  const rows = [
    [t('settings.modele'), st.name ?? '(aucun)'], [t('settings.contexte'), st.blockSize ? st.blockSize + ' tokens' : '—'], [t('settings.parametres'), st.parameters?.toLocaleString(locale()) ?? '—'],
    [t('settings.calcul'), st.device ?? '—'], [t('settings.reglages'), t('settings.temperature_top_top_penalite_max', { temperature: s.temperature, topK: s.topK, topP: s.topP, repetitionPenalty: s.repetitionPenalty, maxReplyTokens: s.maxReplyTokens })],
    [t('settings.conversation'), t('settings.exchanges', { n: turnsOf(S.current.messages).length, id: S.current.id })], [t('settings.dossier'), S.current.workingDirectory || '—'],
    [t('settings.donnees'), S.info.root], [t('settings.version'), S.info.version],
  ];
  dialog(t('settings.infos'), h('dl', { class: 'info-grid' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])), [{ label: t('settings.fermer'), value: null, primary: true }]);
}
