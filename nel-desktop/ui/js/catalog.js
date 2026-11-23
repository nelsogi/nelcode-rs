// Nel Code Desktop — catalog.js : Le catalogue de modèles ouverts : téléchargement vérifié.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

// --- Catalogue de modèles ouverts ------------------------------------------------------------------------

import { t } from './i18n.js';
import { dialog, errText, h, invoke, sizeText, toast } from './util.js';
import { S } from './state.js';
import { loadModel, refreshModels } from './conversation.js';

export const C = { name: null, received: 0, total: 0, extracting: false };   // le téléchargement en cours

export async function openCatalog() {
  const list = await invoke('catalog');
  const rows = h('div', { class: 'catalog' });
  const draw = (list) => rows.replaceChildren(...list.map((e) => {
    const busy = C.name === e.name;
    return h('div', { class: 'entry', 'data-name': e.name },
      h('div', { class: 'head' }, h('b', {}, e.name), h('span', { class: 'meta' }, t('catalog.parametres', { parameters: e.parameters, sizeText: sizeText(e.bytes) }))),
      h('div', { class: 'hint' }, t(e.description)),
      h('div', { class: 'license' }, t('catalog.licence'), h('b', {}, e.license), ' · ', h('span', { class: 'url' }, e.licenseUrl)),
      busy ? h('div', { class: 'progress' }, h('div', { class: 'bar' }, h('div', { class: 'fill' })), h('span', { class: 'text' }, t('catalog.telechargement')),
        h('button', { class: 'btn', onclick: () => invoke('cancel_catalog') }, t('catalog.annuler')))
        : e.installed ? h('div', { class: 'hint ok' }, icon('check'), t('catalog.installe'))
          : h('button', { class: 'btn', disabled: !!C.name, onclick: () => downloadModel(e) }, icon('download'), t('catalog.telecharger')));
  }));
  const redraw = async () => { if (rows.isConnected) { draw(await invoke('catalog')); catalogProgress(); } };
  draw(list);
  catalogProgress();
  dialog(t('catalog.catalogue_modeles'), [rows, h('div', { class: 'hint', style: 'margin-top:10px' },
    t('catalog.telecharges_depuis_hugging_face_empreinte'))],
  [{ label: t('catalog.fermer'), value: null, primary: true }]);
}

export function catalogProgress() {
  const box = document.querySelector(`.catalog .entry[data-name="${CSS.escape(C.name ?? '')}"] .progress`);
  if (!box) return;
  box.querySelector('.fill').style.width = C.total ? (100 * C.received / C.total).toFixed(1) + '%' : '0';
  box.querySelector('.text').textContent = C.extracting ? t('catalog.verification_installation') : `${sizeText(C.received)} / ${sizeText(C.total)}`;
}

// La licence est montrée (et acceptée) avant le téléchargement.
export async function downloadModel(e) {
  const ok = await dialog(t('catalog.telecharger_2', { name: e.name }), [
    h('p', {}, t('catalog.depuis_hugging_face_dans_ton', { sizeText: sizeText(e.bytes) })),
    h('dl', { class: 'info-grid' }, h('dt', {}, t('catalog.licence_2')), h('dd', {}, e.license), h('dt', {}, t('catalog.texte')), h('dd', {}, e.licenseUrl), h('dt', {}, t('catalog.page')), h('dd', {}, e.page), h('dt', {}, 'SHA-256'), h('dd', {}, e.sha256)),
    h('div', { class: 'hint' }, t('catalog.modele_est_publie_par_ses')),
  ], [{ label: t('catalog.annuler'), value: false }, { label: t('catalog.accepter_telecharger', { license: e.license }), value: true, primary: true }]);
  if (!ok) return openCatalog();
  Object.assign(C, { name: e.name, received: 0, total: e.bytes, extracting: false });
  openCatalog();
  try {
    const r = await invoke('install_catalog_model', { name: e.name });
    toast(t('catalog.modele_installe', { name: r.name }), 'success');
    await refreshModels();
    if (!S.model.name) loadModel(r.name);
  } catch (err) {
    const t = errText(err);
    toast(t === 'annulé' ? t('catalog.telechargement_annule') : `${e.name} : ${t}`, t === 'annulé' ? 'warning' : 'error', 8000);
  }
  C.name = null;
  if (document.querySelector('.catalog')) openCatalog();   // la liste à jour (installé, boutons)
}
