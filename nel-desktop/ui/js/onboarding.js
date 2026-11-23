// Nel Code Desktop — onboarding.js : l'assistant du premier lancement, en 3 étapes (bienvenue et couleur, d'où vient le
// modèle, dossier de travail). Montré une seule fois, et seulement s'il n'y a encore ni modèle, ni fournisseur, ni
// conversation. Les textes passent toujours par textContent, jamais par innerHTML.

import { $, h, invoke } from './util.js';
import { S, UI } from './state.js';
import { importFlow, renderAll } from './conversation.js';
import { startClaudeAgent } from './agent.js';
import { applyTheme, openSettings } from './settings.js';
import { openCatalog } from './catalog.js';
import { rememberProject } from './projects.js';

const SOURCES = [
  { id: 'catalog', icon: 'download', title: 'Télécharger un modèle de code', text: 'Qwen2.5-Coder (licence Apache 2.0), depuis le catalogue : il tourne sur ce PC, sans connexion.' },
  { id: 'import', icon: 'plus', title: 'Importer un fichier', text: 'Un .nelmodel (MiniChat) ou un .gguf que tu as déjà.' },
  { id: 'provider', icon: 'arrow-left-right', title: 'Utiliser un serveur', text: 'Ollama, llama.cpp, LM Studio, ou l\'API Claude : Réglages → Fournisseurs.' },
  { id: 'claude', icon: 'bot', title: 'Claude Agent', text: 'L\'outil claude d\'Anthropic installé sur ce PC, avec ta clé API.' },
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
    const dots = h('div', { class: 'wizard-steps', 'aria-label': `Étape ${w.step + 1} sur 3` }, [0, 1, 2].map((i) => h('span', { class: 'step-dot' + (i === w.step ? ' on' : i < w.step ? ' done' : '') })));
    let body;
    if (w.step === 0) {
      const swatch = (value, label) => h('button', { class: 'swatch' + (w.accent === value ? ' on' : ''), 'data-accent': value, onclick: () => { w.accent = value; document.documentElement.dataset.accent = value; draw(); } },
        h('span', { class: 'color' }), label);
      body = [h('div', { class: 'wizard-logo' }, icon('asterisk')), h('h2', {}, 'Bienvenue dans Nel Code'),
        h('p', {}, 'Discute avec des modèles de langage sur ce PC, sans connexion, ou avec des modèles distants. Le mode Agent lit et modifie les fichiers de ton projet, toujours avec ton accord.'),
        h('div', { class: 'row-label' }, 'Couleur'), h('div', { class: 'swatches' }, swatch('red', 'Rouge'), swatch('orange', 'Terre cuite'))];
    } else if (w.step === 1) {
      body = [h('h2', {}, 'Quel modèle utiliser ?'), h('p', { class: 'hint' }, 'Tu pourras en ajouter d\'autres plus tard.'),
        h('div', { class: 'choices', role: 'radiogroup' }, SOURCES.map((s) => h('button', { class: 'choice' + (w.source === s.id ? ' on' : ''), role: 'radio', 'aria-checked': String(w.source === s.id), 'data-source': s.id, onclick: () => { w.source = s.id; draw(); } },
          icon(s.icon), h('span', { class: 'choice-text' }, h('b', {}, s.title), h('span', {}, s.text)))))];
    } else {
      body = [h('h2', {}, 'Ton dossier de travail'),
        h('p', {}, 'Le projet sur lequel tu travailles : les conversations y sont rangées, et le mode Agent n\'en sort jamais.'),
        h('div', { class: 'folder-pick' }, icon('folder'), h('span', { class: 'path' }, w.folder || 'aucun dossier'),
          h('button', { class: 'btn', onclick: async () => { const p = await invoke('pick_folder', { start: w.folder }); if (p) { w.folder = p; draw(); } } }, 'Choisir…'))];
    }
    const buttons = h('div', { class: 'buttons' },
      h('button', { class: 'btn ghost-btn', onclick: () => finish(false) }, 'Passer'),
      w.step > 0 ? h('button', { class: 'btn', onclick: () => { w.step--; draw(); } }, 'Précédent') : null,
      w.step < 2 ? h('button', { class: 'btn primary', onclick: () => { w.step++; draw(); } }, 'Suivant') : h('button', { class: 'btn primary', onclick: () => finish(true) }, 'Commencer'));
    ov.replaceChildren(h('div', { class: 'dialog wizard', role: 'dialog', 'aria-label': 'Premier lancement' }, dots, ...body, buttons));
    ov.querySelector('.btn.primary')?.focus();
  };
  ov.hidden = false;
  ov.onmousedown = null;
  UI.closeOverlay = () => finish(false);
  draw();
}
