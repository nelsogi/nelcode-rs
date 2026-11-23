// Nel Code Desktop — onboarding.js : l'assistant du premier lancement, en 3 étapes (bienvenue et couleur, d'où vient le
// modèle, dossier de travail). Montré une seule fois, et seulement s'il n'y a encore ni modèle, ni fournisseur, ni
// conversation. Les textes passent toujours par textContent, jamais par innerHTML.

import { t } from './i18n.js';
import { $, h, invoke } from './util.js';
import { S, UI } from './state.js';
import { importFlow, renderAll } from './conversation.js';
import { startClaudeAgent } from './agent.js';
import { applyTheme, openSettings } from './settings.js';
import { openCatalog } from './catalog.js';
import { rememberProject } from './projects.js';

const SOURCES = [
  { id: 'catalog', icon: 'download', title: 'onboarding.telecharger_modele_code', text: 'onboarding.qwen2_coder_licence_apache_depuis' },
  { id: 'import', icon: 'plus', title: 'onboarding.importer_fichier', text: 'onboarding.nelmodel_minichat_gguf_que_tu' },
  { id: 'provider', icon: 'arrow-left-right', title: 'onboarding.utiliser_serveur', text: 'onboarding.ollama_llama_cpp_lm_studio' },
  { id: 'claude', icon: 'bot', title: 'onboarding.claude_agent', text: 'onboarding.outil_claude_anthropic_installe_sur' },
];

/** Au démarrage : l'assistant, ou rien (et « fait » est noté s'il y a déjà de quoi travailler). */
export async function maybeOnboard() {
  if (S.settings.onboarded) return false;
  if (S.models.length || S.providers.length || S.sessions.length) {
    S.settings = await invoke('save_settings', { changes: { onboarded: true } });
    return false;
  }
  openWizard();
  return true;
}

/** L'assistant : 3 étapes ; « Passer » ou Échap le ferment pour de bon. */
export function openWizard() {
  const w = { step: 0, accent: S.settings.accent === 'orange' ? 'orange' : 'red', source: 'catalog', folder: S.info.home || '' };
  const ov = $('overlay');
  const finish = async (go) => {
    ov.hidden = true;
    ov.replaceChildren();
    UI.closeOverlay = null;
    const changes = { onboarded: true, accent: w.accent };
    if (go && w.folder) changes.currentProject = w.folder;
    S.settings = await invoke('save_settings', { changes });
    applyTheme();
    if (go && w.folder) {
      await rememberProject(w.folder);
      S.current.workingDirectory = w.folder;
    }
    renderAll();
    $('input').focus();
    if (!go) return;
    ({ catalog: () => openCatalog(), import: () => importFlow(), provider: () => openSettings('providers'), claude: () => startClaudeAgent() })[w.source]();
  };
  const draw = () => {
    const dots = h('div', { class: 'wizard-steps', 'aria-label': t('onboarding.etape_sur', { v0: w.step + 1 }) }, [0, 1, 2].map((i) => h('span', { class: 'step-dot' + (i === w.step ? ' on' : i < w.step ? ' done' : '') })));
    let body;
    if (w.step === 0) {
      const swatch = (value, label) => h('button', { class: 'swatch' + (w.accent === value ? ' on' : ''), 'data-accent': value, onclick: () => { w.accent = value; document.documentElement.dataset.accent = value; draw(); } },
        h('span', { class: 'color' }), label);
      body = [h('div', { class: 'wizard-logo' }, icon('asterisk')), h('h2', {}, t('onboarding.bienvenue_dans_nel_code')),
        h('p', {}, t('onboarding.discute_avec_modeles_langage_sur')),
        h('div', { class: 'row-label' }, t('onboarding.couleur')), h('div', { class: 'swatches' }, swatch('red', t('onboarding.rouge')), swatch('orange', t('onboarding.terre_cuite')))];
    } else if (w.step === 1) {
      body = [h('h2', {}, t('onboarding.quel_modele_utiliser')), h('p', { class: 'hint' }, t('onboarding.tu_pourras_ajouter_autres_plus')),
        h('div', { class: 'choices', role: 'radiogroup' }, SOURCES.map((s) => h('button', { class: 'choice' + (w.source === s.id ? ' on' : ''), role: 'radio', 'aria-checked': String(w.source === s.id), 'data-source': s.id, onclick: () => { w.source = s.id; draw(); } },
          icon(s.icon), h('span', { class: 'choice-text' }, h('b', {}, t(s.title)), h('span', {}, t(s.text))))))];
    } else {
      body = [h('h2', {}, t('onboarding.ton_dossier_travail')),
        h('p', {}, t('onboarding.projet_sur_lequel_tu_travailles')),
        h('div', { class: 'folder-pick' }, icon('folder'), h('span', { class: 'path' }, w.folder || 'aucun dossier'),
          h('button', { class: 'btn', onclick: async () => { const p = await invoke('pick_folder', { start: w.folder }); if (p) { w.folder = p; draw(); } } }, t('onboarding.choisir')))];
    }
    const buttons = h('div', { class: 'buttons' },
      h('button', { class: 'btn ghost-btn', onclick: () => finish(false) }, t('onboarding.passer')),
      w.step > 0 ? h('button', { class: 'btn', onclick: () => { w.step--; draw(); } }, t('onboarding.precedent')) : null,
      w.step < 2 ? h('button', { class: 'btn primary', onclick: () => { w.step++; draw(); } }, t('onboarding.suivant')) : h('button', { class: 'btn primary', onclick: () => finish(true) }, t('onboarding.commencer')));
    ov.replaceChildren(h('div', { class: 'dialog wizard', role: 'dialog', 'aria-label': t('onboarding.premier_lancement') }, dots, ...body, buttons));
    ov.querySelector('.btn.primary')?.focus();
  };
  ov.hidden = false;
  ov.onmousedown = null;
  UI.closeOverlay = () => finish(false);
  draw();
}
