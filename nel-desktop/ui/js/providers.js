// Nel Code Desktop — providers.js : Les fournisseurs de modèles distants (API OpenAI, Claude) : formulaire, test, import depuis Qwen Code.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

// --- Fournisseurs de modèles distants ----------------------------------------------------------------

// http:// vers une autre machine : les messages passent en clair sur le réseau.

import { errText, h, invoke, toast } from './util.js';
import { S } from './state.js';
import { refreshContext, renderModels, renderStatus } from './conversation.js';
import { refreshVision } from './images.js';

export const cleartext = (url) => /^http:\/\//i.test(url.trim()) && !/^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(url.trim());

export async function refreshProviders() {
  S.providers = await invoke('list_providers');
  renderModels();
}

// La section Fournisseurs des réglages : chaque fournisseur s'enregistre tout de suite (pas avec « Enregistrer »).
export async function providersSection() {
  await refreshProviders();
  const box = h('div', { class: 'providers' });
  const draw = () => box.replaceChildren(...S.providers.map((p) => providerForm(p, draw)));
  draw();
  const add = h('button', { class: 'btn', onclick: () => { box.append(providerForm({ models: [] }, draw)); box.lastChild.querySelector('input').focus(); } }, icon('plus'), 'Ajouter un fournisseur');
  // Le modèle « Claude » : l'API d'Anthropic (couche compatible OpenAI), sans temperature/top_p.
  const claudeTemplate = h('button', { class: 'btn', title: 'API d\'Anthropic, clé API de la Console Anthropic', onclick: () => {
    box.append(providerForm({ name: 'Claude', url: 'https://api.anthropic.com/v1/', kind: 'anthropic', omitSampling: true, models: [] }, draw));
    box.lastChild.querySelector('.key').focus();
  } }, icon('plus'), 'Ajouter Claude (Anthropic)');
  const qwen = h('button', { class: 'btn', onclick: async () => {
    try {
      const r = await invoke('import_qwen');
      toast(`Qwen Code : ${r.providers} fournisseur(s) créé(s), ${r.models} modèle(s) importé(s)${r.keys ? ', clé rangée dans le Gestionnaire d\'identification' : ''}.`, 'success', 6000);
      await refreshProviders(); draw();
    } catch (e) { toast('Import depuis Qwen Code : ' + errText(e), 'error', 8000); }
  } }, icon('download'), 'Importer depuis Qwen Code');
  return h('div', { class: 'field providers-field' }, h('div', { class: 'row' }, h('span', {}, 'Fournisseurs (modèles distants)')), box, h('div', { class: 'row-btns' }, add, claudeTemplate, qwen),
    h('div', { class: 'hint' }, 'Un serveur compatible avec l\'API OpenAI : llama.cpp, Ollama (http://hôte:11434/v1), LM Studio… Ses modèles apparaissent dans la liste avec le badge « réseau ». La clé va dans le Gestionnaire d\'identification de Windows, jamais dans settings.json.'));
}

export function providerForm(p, redraw) {
  const name = h('input', { class: 'text-input name', placeholder: 'Nom (ex. Ollama du labo)', value: p.name ?? '', spellcheck: 'false' });
  const url = h('input', { class: 'text-input url', placeholder: 'http://10.5.33.228:11434/v1', value: p.url ?? '', spellcheck: 'false' });
  const key = h('input', { class: 'text-input key', type: 'password', autocomplete: 'off', placeholder: p.hasKey ? 'clé enregistrée (vide : inchangée)' : 'clé (facultative)' });
  const warn = h('div', { class: 'warn-text http' }, icon('circle-alert'), 'Adresse en http : les messages passent en clair sur le réseau. Préfère https si le serveur le permet.');
  const status = h('div', { class: 'hint status' }, p.models?.length ? `${p.models.length} modèle(s) : ${p.models.map((m) => m.id).join(', ')}` : '');
  const omit = h('input', { type: 'checkbox', class: 'omit-sampling', checked: !!p.omitSampling });
  const showWarn = () => (warn.hidden = !cleartext(url.value));
  url.addEventListener('input', showWarn);
  showWarn();
  // Les champs de ce formulaire ne valident pas toute la fenêtre des réglages.
  const form = h('div', { class: 'provider', 'data-id': p.id ?? '', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); } } });
  const save = async (newKey = key.value || null) => {
    try {
      const saved = await invoke('save_provider', { id: p.id ?? null, name: name.value, url: url.value, key: newKey, kind: p.kind ?? 'openai', omitSampling: omit.checked });
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
  url, h('div', { class: 'row-btns' }, key, p.hasKey ? h('button', { class: 'btn', onclick: () => save('').then(() => toast('Clé retirée.', 'success', 2000)) }, 'Retirer la clé') : null),
  h('label', { class: 'check' }, omit, 'Ne pas envoyer temperature/top_p', p.kind === 'anthropic' ? h('span', { class: 'badge' }, 'Anthropic') : null), warn, status,
  p.id && p.models?.length ? visionTable(p) : null);
  return form;
}

// Images : chaque modèle, détecté automatiquement (Claude, Ollama, llama.cpp) ou réglé à la main.
function visionTable(p) {
  const detected = (m) => ({ true: 'voit les images', false: 'ne les voit pas' })[m.visionDetected] ?? 'inconnu';
  const rows = p.models.map((m) => {
    const sel = h('select', { class: 'text-input vision', 'data-model': m.id },
      h('option', { value: 'auto' }, `Automatique (${detected(m)})`), h('option', { value: 'yes' }, 'Voit les images'), h('option', { value: 'no' }, 'Ne voit pas les images'));
    sel.value = m.vision === true ? 'yes' : m.vision === false ? 'no' : 'auto';
    sel.addEventListener('change', async () => {
      try {
        await invoke('set_model_vision', { provider: p.id, model: m.id, value: { yes: true, no: false }[sel.value] ?? null });
        await refreshProviders();
        if (S.model.remote?.provider === p.id && S.model.remote.model === m.id) { await refreshVision(); refreshContext(); }
      } catch (e) { toast(errText(e), 'error'); }
    });
    return h('tr', {}, h('td', {}, m.id), h('td', {}, sel));
  });
  return h('details', { class: 'vision-models' }, h('summary', {}, icon('image'), 'Images'),
    h('table', {}, rows), h('div', { class: 'hint' }, 'Automatique : les modèles Claude voient les images ; pour Ollama et llama.cpp, Nel Code le demande au serveur quand le modèle est choisi. Les autres serveurs ne le disent pas : règle-le ici.'));
}
