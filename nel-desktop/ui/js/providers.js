// Nel Code Desktop — providers.js : Les fournisseurs de modèles distants (API OpenAI, Claude) : formulaire, test, import depuis Qwen Code.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

// --- Fournisseurs de modèles distants ----------------------------------------------------------------

// http:// vers une autre machine : les messages passent en clair sur le réseau.

import { t } from './i18n.js';
import { errText, h, invoke, toast } from './util.js';
import { S } from './state.js';
import { refreshContext, renderModels, renderStatus } from './conversation.js';
import { refreshVision } from './images.js';

export const cleartext = (url) => /^http:\/\//i.test(url.trim()) && !/^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(url.trim());

export async function refreshProviders() {
  S.providers = await invoke('list_providers');
  renderModels();
}

// Réglages → Fournisseurs : la liste à gauche, le fournisseur choisi à droite. Chaque fournisseur s'enregistre avec son
// bouton (une clé ou une adresse à moitié tapée n'est jamais envoyée).
export async function providersSection() {
  await refreshProviders();
  let sel = S.providers[0] ?? null;   // le fournisseur affiché (ou un nouveau, pas encore enregistré)
  const list = h('div', { class: 'provider-list', role: 'listbox', 'aria-label': t('providers.fournisseurs') });
  const detail = h('div', { class: 'provider-detail' });
  const isSel = (p) => !!sel && (p.id ? p.id === sel.id : p === sel);
  // La liste seule (après un enregistrement : le formulaire ouvert reste, avec son état et ses messages).
  const drawList = () => {
    const items = [...S.providers, ...(sel && !sel.id ? [sel] : [])];
    list.replaceChildren(...(items.length ? items.map((p) => h('button', { class: 'item' + (isSel(p) ? ' sel' : ''), role: 'option', 'aria-selected': isSel(p) ? 'true' : 'false', 'data-id': p.id ?? '',
      onclick: () => { sel = p; draw(); detail.querySelector('input')?.focus(); },
      onkeydown: (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const b = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
        if (b) { b.click(); list.querySelector('.sel')?.focus(); }
      } },
      h('span', { class: 'name' }, p.name || t('providers.nouveau_fournisseur')), h('span', { class: 'meta' }, p.id ? t('providers.models_meta', { n: p.models?.length ?? 0, key: p.hasKey ? t('providers.cle') : '' }) : t('providers.pas_encore_enregistre')))) : [h('div', { class: 'hint' }, t('providers.aucun_fournisseur'))]));
  };
  const draw = () => {
    if (sel?.id) sel = S.providers.find((p) => p.id === sel.id) ?? S.providers[0] ?? null;   // à jour, ou supprimé
    drawList();
    detail.replaceChildren(sel ? providerForm(sel, () => { sel = S.providers[0] ?? null; draw(); }, drawList) : h('p', { class: 'hint' }, t('providers.ajoute_fournisseur_pour_utiliser_modeles')));
  };
  const add = (p) => { sel = p; draw(); (detail.querySelector(p.kind === 'anthropic' ? '.key' : 'input'))?.focus(); };
  draw();
  // Le modèle « Claude » : l'API d'Anthropic (couche compatible OpenAI), sans temperature/top_p.
  const qwen = h('button', { class: 'btn', onclick: async () => {
    try {
      const r = await invoke('import_qwen');
      toast(t('providers.qwen_code_fournisseur_cree_modele', { providers: t('providers.n_created', { n: r.providers }), models: t('providers.n_imported', { n: r.models }), v2: r.keys ? t('providers.cle_rangee_dans', { keystore: S.info.keystore }) : '' }), 'success', 6000);
      await refreshProviders(); draw();
    } catch (e) { toast(t('providers.import_depuis_qwen_code', { error: errText(e) }), 'error', 8000); }
  } }, icon('download'), t('providers.importer_depuis_qwen_code'));
  return h('div', { class: 'providers-field' },
    h('div', { class: 'providers-split' },
      h('div', { class: 'providers-side' }, list,
        h('div', { class: 'col-btns' },
          h('button', { class: 'btn', onclick: () => add({ models: [] }) }, icon('plus'), t('providers.ajouter_fournisseur')),
          h('button', { class: 'btn', title: t('providers.api_anthropic_cle_api_console'), onclick: () => add({ name: 'Claude', url: 'https://api.anthropic.com/v1/', kind: 'anthropic', omitSampling: true, models: [] }) }, icon('plus'), t('providers.ajouter_claude_anthropic')),
          qwen)),
      detail),
    h('div', { class: 'hint' }, t('providers.serveur_compatible_avec_api_openai', { keystore: S.info.keystore })));
}

export function providerForm(p, redraw, onSaved = () => {}) {
  const name = h('input', { class: 'text-input name', placeholder: t('providers.nom_ex_ollama_labo'), value: p.name ?? '', spellcheck: 'false' });
  const url = h('input', { class: 'text-input url', placeholder: t('providers.http_10_33_228_11434'), value: p.url ?? '', spellcheck: 'false' });
  const key = h('input', { class: 'text-input key', type: 'password', autocomplete: 'off', placeholder: p.hasKey ? t('providers.cle_enregistree_vide_inchangee') : t('providers.cle_facultative') });
  const warn = h('div', { class: 'warn-text http' }, icon('circle-alert'), t('providers.adresse_http_messages_passent_clair'));
  const status = h('div', { class: 'hint status' }, p.models?.length ? t('providers.models_list', { n: p.models.length, list: p.models.map((m) => m.id).join(', ') }) : '');
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
      key.placeholder = p.hasKey ? t('providers.cle_enregistree_vide_inchangee') : t('providers.cle_facultative');
      form.dataset.id = p.id;
      url.value = p.url;
      await refreshProviders();
      onSaved(p);
      return true;
    } catch (e) { status.className = 'warn-text status'; status.textContent = errText(e); return false; }
  };
  const test = async () => {
    if (!(await save())) return;
    status.className = 'hint status';
    status.replaceChildren(h('span', { class: 'spinner' }), t('providers.test'));
    try {
      const ids = await invoke('test_provider', { id: p.id });
      status.textContent = ids.length ? t('providers.models_list', { n: ids.length, list: ids.join(', ') }) : t('providers.serveur_repond_mais_ne_propose');
      await refreshProviders();
      onSaved(p);
    } catch (e) { status.className = 'warn-text status'; status.textContent = errText(e); }
  };
  form.append(h('div', { class: 'row-btns' }, name, h('button', { class: 'btn', onclick: test }, icon('refresh-cw'), t('providers.tester')),
    h('button', { class: 'btn', onclick: async () => (await save()) && toast(t('providers.fournisseur_enregistre'), 'success', 2000) }, t('providers.enregistrer')),
    h('button', { class: 'btn danger', title: t('providers.supprimer_fournisseur_sa_cle'), onclick: async () => {
      if (!p.id) return redraw();   // pas encore enregistré
      await invoke('delete_provider', { id: p.id });
      if (S.model.remote?.provider === p.id) Object.assign(S.model, { name: null, remote: null, blockSize: null });
      await refreshProviders(); redraw(); renderStatus(); refreshContext();
    } }, t('providers.supprimer'))),
  url, h('div', { class: 'row-btns' }, key, p.hasKey ? h('button', { class: 'btn', onclick: () => save('').then(() => toast(t('providers.cle_retiree'), 'success', 2000)) }, t('providers.retirer_cle')) : null),
  h('label', { class: 'check' }, omit, t('providers.ne_pas_envoyer_temperature_top'), p.kind === 'anthropic' ? h('span', { class: 'badge' }, t('providers.anthropic')) : null), warn, status,
  p.id && p.models?.length ? visionTable(p) : null);
  return form;
}

// Images : chaque modèle, détecté automatiquement (Claude, Ollama, llama.cpp) ou réglé à la main.
function visionTable(p) {
  const detected = (m) => ({ true: t('providers.voit_images'), false: t('providers.ne_voit_pas') })[m.visionDetected] ?? 'inconnu';
  const rows = p.models.map((m) => {
    const sel = h('select', { class: 'text-input vision', 'data-model': m.id },
      h('option', { value: 'auto' }, t('providers.automatique', { detected: detected(m) })), h('option', { value: 'yes' }, t('providers.voit_images_2')), h('option', { value: 'no' }, t('providers.ne_voit_pas_images')));
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
  return h('details', { class: 'vision-models' }, h('summary', {}, icon('image'), t('providers.images')),
    h('table', {}, rows), h('div', { class: 'hint' }, t('providers.automatique_modeles_claude_voient_images')));
}
