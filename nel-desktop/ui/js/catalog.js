// Nel Code Desktop — catalog.js : Le catalogue de modèles ouverts : téléchargement vérifié.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.

// --- Catalogue de modèles ouverts ------------------------------------------------------------------------

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
      h('div', { class: 'head' }, h('b', {}, e.name), h('span', { class: 'meta' }, `${e.parameters} de paramètres · ${sizeText(e.bytes)}`)),
      h('div', { class: 'hint' }, e.description),
      h('div', { class: 'license' }, 'Licence : ', h('b', {}, e.license), ' · ', h('span', { class: 'url' }, e.licenseUrl)),
      busy ? h('div', { class: 'progress' }, h('div', { class: 'bar' }, h('div', { class: 'fill' })), h('span', { class: 'text' }, 'Téléchargement…'),
        h('button', { class: 'btn', onclick: () => invoke('cancel_catalog') }, 'Annuler'))
        : e.installed ? h('div', { class: 'hint ok' }, icon('check'), 'Installé')
          : h('button', { class: 'btn', disabled: !!C.name, onclick: () => downloadModel(e) }, icon('download'), 'Télécharger'));
  }));
  const redraw = async () => { if (rows.isConnected) { draw(await invoke('catalog')); catalogProgress(); } };
  draw(list);
  catalogProgress();
  dialog('Catalogue de modèles', [rows, h('div', { class: 'hint', style: 'margin-top:10px' },
    'Téléchargés depuis Hugging Face, empreinte SHA-256 vérifiée. Tu peux aussi glisser un fichier .gguf (Qwen2 ou Llama) dans la fenêtre.')],
  [{ label: 'Fermer', value: null, primary: true }]);
}

export function catalogProgress() {
  const box = document.querySelector(`.catalog .entry[data-name="${CSS.escape(C.name ?? '')}"] .progress`);
  if (!box) return;
  box.querySelector('.fill').style.width = C.total ? (100 * C.received / C.total).toFixed(1) + '%' : '0';
  box.querySelector('.text').textContent = C.extracting ? 'Vérification et installation…' : `${sizeText(C.received)} / ${sizeText(C.total)}`;
}

// La licence est montrée (et acceptée) avant le téléchargement.
export async function downloadModel(e) {
  const ok = await dialog(`Télécharger ${e.name} ?`, [
    h('p', {}, `${sizeText(e.bytes)} depuis Hugging Face, dans ton dossier de modèles.`),
    h('dl', { class: 'info-grid' }, h('dt', {}, 'Licence'), h('dd', {}, e.license), h('dt', {}, 'Texte'), h('dd', {}, e.licenseUrl), h('dt', {}, 'Page'), h('dd', {}, e.page), h('dt', {}, 'SHA-256'), h('dd', {}, e.sha256)),
    h('div', { class: 'hint' }, 'Le modèle est publié par ses auteurs sous cette licence ; Nel Code ne le modifie pas.'),
  ], [{ label: 'Annuler', value: false }, { label: `Accepter (${e.license}) et télécharger`, value: true, primary: true }]);
  if (!ok) return openCatalog();
  Object.assign(C, { name: e.name, received: 0, total: e.bytes, extracting: false });
  openCatalog();
  try {
    const r = await invoke('install_catalog_model', { name: e.name });
    toast(`Modèle « ${r.name} » installé.`, 'success');
    await refreshModels();
    if (!S.model.name) loadModel(r.name);
  } catch (err) {
    const t = errText(err);
    toast(t === 'annulé' ? 'Téléchargement annulé.' : `${e.name} : ${t}`, t === 'annulé' ? 'warning' : 'error', 8000);
  }
  C.name = null;
  if (document.querySelector('.catalog')) openCatalog();   // la liste à jour (installé, boutons)
}
