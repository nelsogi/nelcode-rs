// Nel Code Desktop — main.js : Le point d'entrée : écouteurs (Rust, clavier, boutons), démarrage, et ce que les tests de l'interface utilisent.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

import { applyStatic, loadLang, num, t, tr } from './i18n.js';
import { $, errText, h, invoke, listen, toast } from './util.js';
import { S, UI } from './state.js';
import { F, autoGrow, chooseFolder, closeEdit, followEnd, importFlow, loadModel, newSession, onDone, onDrop, onToken, openCompare, openFolder, openLeaderboard, openSession, refreshContext, refreshModels, renameSession, renderAll, renderHeader, renderMessages, renderModels, renderSessions, renderStatus, selectRemote, showReasoning, startNew, stop, submitInput, toggleTransparency, visible, waiting } from './conversation.js';
import { nelcodeChip, renderPlan, startClaudeAgent, stepsEl, toggleAgent } from './agent.js';
import { G, U, UPDATE_EVERY, applyDensity, applyTextSize, applyTheme, checkUpdate, gpuProgress, openSettings, runBenchmark, showBenchmarks, stepTextSize } from './settings.js';
import * as SETTINGS from './settings-page.js';
import { C, catalogProgress, openCatalog } from './catalog.js';
import { refreshProviders } from './providers.js';
import { openPalette, pickSuggest, showShortcuts, updateSuggest } from './palette.js';
import { projectMenu } from './projects.js';
import { refreshFiles, toggleFiles } from './files.js';
import { maybeOnboard } from './onboarding.js';
import * as USAGE from './usage.js';
import * as IMG from './images.js';
import * as MCP from './mcp.js';
import * as I18N from './i18n.js';

listen('catalog-progress', (e) => { if (e.payload.tag === C.name) { Object.assign(C, e.payload); catalogProgress(); } });

// Une étape nouvelle ou mise à jour, pendant la réponse.
listen('agent-step', (e) => {
  const g = S.gen, st = e.payload;
  if (!g) return;
  const i = g.steps.findIndex((x) => x.id === st.id);
  if (i >= 0) g.steps[i] = st; else g.steps.push(st);
  // Une écriture faite : les badges du panneau Fichiers suivent.
  if ((st.kind === 'write' || st.kind === 'edit') && ['accepted', 'done'].includes(st.status)) refreshFiles(true);
  if (!g.el || S.current !== g.session) return;
  const fresh = stepsEl(g.steps, null), old = g.el.querySelector('.steps');
  // Les étapes dépliées par l'utilisateur le restent.
  if (old) for (const d of old.querySelectorAll('details[open]')) fresh.querySelector(`[data-step="${d.dataset.step}"]`)?.setAttribute('open', '');
  old ? old.replaceWith(fresh) : g.el.querySelector('.body').before(fresh);
  if (st.status === 'pending') fresh.querySelector(`[data-step="${st.id}"]`)?.scrollIntoView({ block: 'nearest' });
  followEnd();
});

// Le texte qui accompagnait les outils est devenu une étape : la réponse finale repart de zéro.
// Le plan donné par le modèle, en direct.
listen('agent-plan', (e) => {
  if (!S.gen) return;
  S.gen.plan = e.payload.tasks;
  renderPlan();
});

listen('agent-clear', () => {
  const g = S.gen;
  if (!g) return;
  g.text = '';
  const body = g.el?.querySelector('.body');
  if (body) body.replaceChildren(waiting(t('main.travaille')));
});

listen('gen-reasoning', (e) => {
  const g = S.gen;
  if (!g || g.kind === 'compare') return;
  g.thinkStart ??= Date.now();
  g.reasoning += e.payload.text;
  showReasoning();
});

document.addEventListener('mouseover', (e) => {
  const span = e.target.closest?.('.tok'), tip = $('tip');
  if (!span) { tip.hidden = true; return; }
  const tok = span.parentElement.tokens[span.dataset.k];
  tip.replaceChildren(...tok[1].map(([tx, p]) => h('div', { class: 'row' + (tx === tok[0] ? ' chosen' : '') },
    h('span', { class: 'name' }, visible(tx)), h('div', { class: 'bar' }, h('div', { style: `width:${(p * 100).toFixed(1)}%` })), h('span', { class: 'pct' }, (p * 100).toFixed(1) + ' %'))));
  if (!tok[1].some(([tx]) => tx === tok[0])) tip.append(h('div', { class: 'row chosen' }, h('span', { class: 'name' }, visible(tok[0])), h('span', {}, t('main.tire_hors')), h('span')));
  tip.hidden = false;
  const r = span.getBoundingClientRect(), tx = tip.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(r.left, innerWidth - tx.width - 8)) + 'px';
  tip.style.top = (r.bottom + 6 + tx.height > innerHeight ? r.top - tx.height - 6 : r.bottom + 6) + 'px';
});

listen('server-changed', (e) => { S.server.port = e.payload.port; renderStatus(); });

listen('server-busy', (e) => { S.server.busy = e.payload; renderStatus(); });

listen('gpu-pack-progress', (e) => { Object.assign(G, e.payload); gpuProgress(); });

listen('bench-progress', (e) => { S.bench = e.payload; renderStatus(); });

listen('bench-done', (e) => {
  S.bench = null;
  renderStatus();
  if (e.payload.error) toast(t('main.test_vitesse', { error: tr(e.payload.error) }), 'error', 8000);
  // Une fenêtre déjà ouverte (les réglages) : un résumé, les détails restent dans « Résultats des tests de vitesse ».
  const mine = e.payload.results[e.payload.name] ?? {};
  if (UI.closeOverlay || UI.page) toast(['cpu', 'gpu'].filter((d) => mine[d]).map((d) => t('main.bench_line', { device: mine[d].device, tps: num(mine[d].tokensPerSecond, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) })).join(' · ') || t('main.test_vitesse_termine'), 'success', 8000);
  else showBenchmarks(e.payload.results);
});

$('input').addEventListener('input', (e) => { autoGrow(e.target); updateSuggest(); refreshContext(); });

$('input').addEventListener('keydown', (e) => {
  const open = !$('suggest').hidden;
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    UI.sugg.sel = (UI.sugg.sel + (e.key === 'ArrowDown' ? 1 : -1) + UI.sugg.items.length) % UI.sugg.items.length;
    return updateSuggest();
  }
  if (open && e.key === 'Tab') { e.preventDefault(); return pickSuggest(UI.sugg.sel); }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // Entrée sur une suggestion incomplète la complète ; sur une commande déjà complète, l'exécute.
    if (open) {
      const it = UI.sugg.items[UI.sugg.sel];
      if (it && $('input').value.trim().toLowerCase() !== it.fill.trim().toLowerCase()) return pickSuggest(UI.sugg.sel);
    }
    if (S.gen) return;
    submitInput();
  }
});

// Les suggestions se ferment quand la saisie perd vraiment le focus (pas si elle l'a retrouvé entre-temps).
$('input').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('input')) $('suggest').hidden = true; }, 100));

$('send').onclick = () => (S.gen ? stop() : submitInput());

// Les images : Ctrl+V d'une image dans la saisie, ou le bouton (le glisser-déposer passe par onDrop).
$('input').addEventListener('paste', (e) => { if (IMG.addFiles(e.clipboardData?.files ?? [])) e.preventDefault(); });

$('image-btn').onclick = () => IMG.pickImages();

$('new-chat').onclick = startNew;

$('claude-chat').onclick = startClaudeAgent;

$('search').oninput = renderSessions;

$('import-btn').onclick = () => importFlow();

$('catalog-btn').onclick = () => openCatalog();

$('settings-btn').onclick = () => openSettings();

$('arena-btn').onclick = openLeaderboard;

$('usage-btn').onclick = () => USAGE.openUsage();

$('usage-chip').onclick = () => USAGE.openUsage();

$('transp-btn').onclick = toggleTransparency;

$('agent-btn').onclick = toggleAgent;

// La puce MCP : une petite fenêtre au-dessus, avec les serveurs de la conversation (stopPropagation : le mousedown
// qui ferme les menus ne la referme pas aussitôt).
$('mcp-chip').onmousedown = (e) => e.stopPropagation();
$('mcp-chip').onclick = () => MCP.serversPopover();

$('nelcode-chip').onclick = nelcodeChip;

$('palette-btn').onclick = openPalette;
$('project-btn').onclick = (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); projectMenu({ clientX: r.left, clientY: r.bottom + 4 }); };
$('files-btn').onclick = () => toggleFiles();

$('title').ondblclick = () => renameSession(S.current);

$('folder-chip').onclick = () => chooseFolder();

$('folder-open').onclick = openFolder;

// La barre d'état : le modèle → Réglages → Modèles, le calcul (CPU/GPU) → Calcul, le contexte → Contexte et résumé.
$('status').addEventListener('click', (e) => { const b = e.target.closest('[data-settings]'); if (b) openSettings(b.dataset.settings, b.dataset.setting); });
$('context').onclick = () => openSettings('models', 'contextLimit');
$('context').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSettings('models', 'contextLimit'); } };

document.addEventListener('mousedown', (e) => { if (!$('menu').contains(e.target)) $('menu').hidden = true; });

document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    if (!$('menu').hidden) { $('menu').hidden = true; return; }
    if (UI.closeOverlay) { e.preventDefault(); return UI.closeOverlay(); }
    if (UI.page) { e.preventDefault(); return UI.page.close(); }
    if (!$('suggest').hidden) { $('suggest').hidden = true; return; }
    if (S.gen) { e.preventDefault(); return stop(); }
    if (UI.editing !== null) { closeEdit(); return renderMessages(); }
    return;
  }
  // Le zoom marche partout (page Réglages comprise) ; Ctrl + et Ctrl − aussi sur le pavé numérique.
  if (ctrl && !e.altKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); return stepTextSize(10); }
  if (ctrl && !e.altKey && e.key === '-') { e.preventDefault(); return stepTextSize(-10); }
  if (ctrl && !e.altKey && e.key === '0') { e.preventDefault(); return stepTextSize(0); }
  if (UI.closeOverlay || UI.page) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  // « ? » : l'aide des raccourcis, hors d'un champ (ou dans la saisie encore vide).
  if (e.key === '?' && !ctrl && (!typing || (document.activeElement === $('input') && !$('input').value))) { e.preventDefault(); return showShortcuts(); }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); return toggleFiles(); }
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
listen('gen-done', async (e) => { await onDone(e.payload); U.idle?.(); MCP.closeOtherMcp(); });

// Un serveur MCP a changé d'état (démarré, arrêté, liste d'outils) : la page MCP ouverte suit.
listen('mcp-changed', () => { UI.mcpRedraw?.(); if (!$('menu').hidden && $('menu').classList.contains('mcp-pop')) MCP.refreshMcp(); });

listen('gen-side', (e) => { if (S.gen?.kind === 'compare') { S.gen.side = e.payload; renderStatus(); } });

listen('model-loading', (e) => { S.model.loading = e.payload; renderModels(); renderStatus(); });

listen('model-loaded', (e) => {
  Object.assign(S.model, { name: e.payload.name, blockSize: e.payload.blockSize, device: e.payload.device, loading: null, remote: null, vision: false, visionManual: null });
  S.lastSpeed = '';
  renderModels(); renderStatus(); refreshContext(); IMG.renderAttach();
  toast(t('main.modele_charge_sur', { name: e.payload.name, device: e.payload.device, seconds: num(e.payload.seconds, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) }), 'success', 2500);
});

listen('model-error', (e) => {
  S.model.loading = null;
  renderModels(); renderStatus();
  toast(t('main.modele_ne_se_charge_pas', { name: e.payload.name, error: tr(e.payload.error) }), 'error', 10000);
});

listen('import-started', (e) => { UI.importToast = toast(h('span', {}, h('span', { class: 'spinner' }), t('main.import_extraction_verification', { payload: e.payload })), 'busy', 0); });

listen('import-done', async (e) => {
  UI.importToast?.remove();
  const r = e.payload;
  toast(t('main.modele_installe_parametres', { name: r.name, parameters: num(r.parameters) }), 'success');
  if (r.warning) toast(t('main.attention', { value: tr(r.warning) }), 'warning', 10000);
  await refreshModels();
  if (!S.model.name || S.model.name === r.name) loadModel(r.name);
});

listen('import-error', (e) => {
  UI.importToast?.remove();
  const err = e.payload.error === 'exists' ? t('main.model_exists', { name: e.payload.name }) : tr(e.payload.error);
  toast(t('main.import_impossible', { error: err }), 'error', 10000);
});

// Glisser-déposer d'un .nelmodel, d'un .gguf ou d'images sur la fenêtre.
listen('tauri://drag-enter', () => ($('drop').hidden = false));

listen('tauri://drag-leave', () => ($('drop').hidden = true));

listen('tauri://drag-drop', (e) => onDrop(e.payload.paths ?? []));

// --- Démarrage -------------------------------------------------------------------------------------------

(async () => {
  [S.info, S.settings, S.sessions] = await Promise.all([invoke('app_info'), invoke('get_settings'), invoke('list_sessions')]);
  // La langue d'abord : tout ce qui suit s'affiche dans la bonne.
  await loadLang(S.settings.language);
  applyStatic();
  $('folder-open').title = t('main.ouvrir_dossier_dans', { fileManager: S.info.fileManager });
  applyTheme();
  applyDensity();
  applyTextSize();
  await refreshModels();
  const st = await invoke('model_status');
  Object.assign(S.model, { name: st.name, loading: st.loading, blockSize: st.blockSize, device: st.device });
  S.server.port = (await invoke('server_status')).port;
  S.providers = await invoke('list_providers');
  // La conversation n'existe qu'une fois tout chargé : l'interface (et les tests qui l'attendent) est alors complète.
  S.current = newSession();
  renderAll();
  $('input').focus();
  // Premier lancement : l'assistant (s'il n'y a encore ni modèle, ni fournisseur, ni conversation).
  if (await maybeOnboard()) return;
  // Le modèle par défaut (Réglages → Modèles), sinon le dernier utilisé.
  const remoteOf = (v) => { const [, rp, rm] = String(v ?? '').match(/^remote:([^/]+)\/(.+)$/) ?? []; const p = S.providers.find((x) => x.id === rp); const m = p?.models?.find((x) => x.id === rm); return m ? [p, m] : null; };
  const localOf = (v) => S.models.find((m) => m.name === v);
  const want = [S.settings.defaultModel, S.settings.lastModel].find((v) => v && (remoteOf(v) || localOf(v)));
  if (!S.model.name && want && remoteOf(want)) selectRemote(...remoteOf(want));
  else if (!S.model.name && !S.model.loading && S.models.length) loadModel((localOf(want) ?? S.models[0]).name);
  if (S.info.startupFile) importFlow(S.info.startupFile);
  // Noté avant de vérifier : hors ligne, on ne réessaie que le lendemain.
  if (S.settings.autoUpdate !== false && !(Date.now() - S.settings.lastUpdateCheck < UPDATE_EVERY)) {
    S.settings = await invoke('save_settings', { changes: { lastUpdateCheck: Date.now() } });
    setTimeout(() => checkUpdate(false), 3000);   // discrète : après le démarrage
  }
})().catch((e) => toast(t('main.demarrage', { error: errText(e) }), 'error', 0));

// Les tests de l'interface (e2e/) lisent l'état et appellent ces fonctions depuis la page.
Object.assign(window, { S, F, C, USAGE, IMG, MCP, I18N, SETTINGS, openSettings, renderStatus, newSession, startNew, renderHeader, renderMessages, openSession, refreshProviders, onDrop, runBenchmark });
