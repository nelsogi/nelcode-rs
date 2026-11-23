// Nel Code Desktop — images.js : Les images des messages : ajout (coller, glisser-déposer, bouton), miniatures au-dessus
// de la saisie, affichage dans l'historique (clic pour agrandir), modèles qui voient les images, estimation des tokens.
// Les textes (messages, noms) passent toujours par textContent, jamais par innerHTML.
//
// La partie Rust prépare chaque image (taille réglable, réencodée sans métadonnées) et la range dans le dossier de la
// conversation ; un message garde seulement { file, name, width, height, tokens } dans `images`. L'affichage passe par
// des data URL (la CSP n'accepte que self et data: pour les images).

import { locale, t } from './i18n.js';
import { $, dialog, errText, h, invoke, toast } from './util.js';
import { S } from './state.js';
import { refreshContext, summaryOf } from './conversation.js';

export const MAX_IMAGES = 5;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;

// Les images ajoutées mais pas encore envoyées, par conversation (elles attendent si l'on change de conversation).
const pending = new Map();
// Les data URL déjà lues (miniatures, historique).
const urls = new Map();

export const pendingOf = (s = S.current) => pending.get(s?.id) ?? [];
export const isImagePath = (p) => IMAGE_EXT.test(p);

// Le modèle actif voit-il les images ? { ok, why } : why explique le bouton désactivé.
export function vision(s = S.current) {
  if (s?.claudeAgent) return { ok: false, why: t('images.claude_agent_ne_recoit_pas') };
  if (s?.compare) return { ok: false, why: t('images.pas_images_dans_conversation_comparee') };
  if (!S.model.name) return { ok: false, why: t('images.aucun_modele_charge') };
  if (!S.model.remote) return { ok: false, why: t('images.nelmodel_modeles_gguf_ce_pc') };
  if (S.model.vision === true) return { ok: true, why: '' };
  if (S.model.vision === false) return { ok: false, why: t('images.ne_voit_pas_images_pour', { name: S.model.name, v1: S.model.visionManual === false ? t('images.reglage_manuel') : t('images.detecte_aupres_serveur') }) };
  return { ok: false, why: t('images.nel_code_ne_sait_pas', { name: S.model.name }) };
}

// Ce que le serveur dit du modèle distant actif (détection gardée dans les réglages ; `again` : la refaire).
export async function refreshVision(again = false) {
  const r = S.model.remote;
  if (!r) { S.model.vision = false; S.model.visionManual = null; return renderAttach(); }
  try {
    const v = await invoke('model_vision', { provider: r.provider, model: r.model, again });
    if (S.model.remote !== r) return;
    S.model.vision = v.vision;
    S.model.visionManual = v.manual;
  } catch { S.model.vision = null; }
  S.model.visionOf = r.model;   // la réponse est arrivée (même inconnue)
  renderAttach();
}

const tokensText = (n) => `≈ ${Number(n ?? 0).toLocaleString(locale())} tokens (estimation)`;
const about = (img) => `${img.name} · ${img.width} × ${img.height} · ${tokensText(img.tokens)}`;

async function dataUrl(session, file) {
  const key = `${session}/${file}`;
  if (!urls.has(key)) urls.set(key, invoke('image_data', { session, file }).catch(() => null));
  return urls.get(key);
}

// Une miniature : l'image se charge à part ; clic : agrandie.
export function thumb(session, img, extra = null) {
  const pic = h('img', { alt: img.name, draggable: 'false' });
  dataUrl(session, img.file).then((u) => { if (u) pic.src = u; else pic.replaceWith(h('span', { class: 'missing' }, 'image introuvable')); });
  return h('div', { class: 'thumb', title: about(img) }, h('button', { class: 'thumb-open', title: t('images.agrandir'), 'aria-label': t('images.agrandir_2', { value: img.name }), onclick: () => enlarge(session, img) }, pic), extra);
}

export async function enlarge(session, img) {
  const u = await dataUrl(session, img.file);
  if (!u) return toast(t('images.image_introuvable', { value: img.name }), 'warning');
  const done = dialog(img.name, [h('img', { class: 'image-large', src: u, alt: img.name }), h('div', { class: 'hint' }, t('images.px', { width: img.width, height: img.height, tokensText: tokensText(img.tokens) }))], [{ label: t('images.fermer'), value: null, primary: true }]);
  $('overlay').querySelector('.dialog')?.classList.add('image-dialog');
  return done;
}

// Les images d'un message de l'historique.
export function messageImages(session, m) {
  if (!m.images?.length) return null;
  return h('div', { class: 'msg-images' }, m.images.map((img) => thumb(session, img)));
}

// Les miniatures au-dessus de la saisie, et l'état du bouton.
export function renderAttach() {
  const s = S.current, box = $('attachments'), btn = $('image-btn');
  if (!s || !box) return;
  const list = pendingOf(s);
  box.hidden = !list.length;
  box.replaceChildren(...list.map((img) => thumb(s.id, img, h('button', { class: 'thumb-remove', title: t('images.retirer_image'), 'aria-label': t('images.retirer', { value: img.name }), onclick: () => remove(s, img) }, icon('x')))));
  const v = vision(s);
  btn.classList.toggle('off', !v.ok);
  btn.setAttribute('aria-disabled', String(!v.ok));
  btn.title = v.ok ? t('images.ajouter_image_au_plus_par', { MAX_IMAGES: MAX_IMAGES }) : v.why;
}

async function remove(s, img) {
  pending.set(s.id, pendingOf(s).filter((x) => x !== img));
  invoke('image_delete', { session: s.id, file: img.file }).catch(() => {});
  renderAttach();
  refreshContext();
}

// Ajoute des images (chacune : () => Promise<info>), dans la limite de 5 par message.
async function add(makers) {
  const s = S.current, v = vision(s);
  if (!v.ok) return toast(v.why, 'warning', 8000);
  const room = MAX_IMAGES - pendingOf(s).length;
  if (makers.length > room) toast(room > 0 ? t('images.max_some_added', { max: MAX_IMAGES, n: room }) : t('images.max_none_added', { max: MAX_IMAGES }), 'warning');
  for (const make of makers.slice(0, Math.max(0, room))) {
    try {
      const img = await make();
      pending.set(s.id, [...pendingOf(s), img]);
      renderAttach();
    } catch (e) { toast(t('images.image', { error: errText(e) }), 'error', 8000); }
  }
  refreshContext();
}

// Coller (Ctrl+V) : les fichiers image du presse-papiers.
export function addFiles(files) {
  const imgs = [...files].filter((f) => IMAGE_MIME.test(f.type));
  if (!imgs.length) return false;
  add(imgs.map((f) => () => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => invoke('image_prepare_data', { session: S.current.id, data: r.result, name: f.name || t('images.image_collee') }).then(resolve, reject);
    r.onerror = () => reject(new Error('image illisible'));
    r.readAsDataURL(f);
  })));
  return true;
}

// Glisser-déposer et bouton : des fichiers du PC.
export const addPaths = (paths) => add(paths.map((path) => () => invoke('image_prepare_path', { session: S.current.id, path })));

export async function pickImages() {
  const v = vision();
  if (!v.ok) return toast(v.why, 'warning', 8000);
  const paths = await invoke('pick_images');
  if (paths.length) addPaths(paths);
}

// À l'envoi : les images en attente partent avec le message (et ne sont plus en attente).
export function takePending(s = S.current) {
  const list = pendingOf(s);
  pending.delete(s.id);
  renderAttach();
  return list.length ? list : undefined;
}

// Un envoi qui échoue : ses images reviennent au-dessus de la saisie.
export function giveBack(s, images) {
  if (!images?.length) return;
  pending.set(s.id, [...images, ...pendingOf(s)].slice(0, MAX_IMAGES));
  renderAttach();
}

// Les images de chaque tour envoyé, dans le même ordre que historyOf (même règle de paires que turnsOf ; le résumé, s'il
// y en a un, n'en a pas).
export function imagesOf(s, end = s.messages.length) {
  const sm = summaryOf(s, end);
  const from = sm ? sm.upTo : 0;
  const turns = [];
  const msgs = s.messages;
  for (let i = from; i + 1 < end; i += 2)
    if (msgs[i].role === 'user' && msgs[i + 1].role === 'assistant') turns.push((msgs[i].images ?? []).map((x) => x.file));
  return sm ? [[], ...turns] : turns;
}

// Ce qui part avec une demande : { session, history, message } (rien si aucune image).
export function attached(s, end, message) {
  const history = imagesOf(s, end);
  const files = (message ?? []).map((x) => x.file);
  if (!files.length && !history.some((tx) => tx.length)) return null;
  return { session: s.id, history, message: files };
}

// L'estimation des tokens des images que le modèle verra au prochain message : [total, nombre, détail].
export function imageTokens(s = S.current) {
  const sm = summaryOf(s);
  const sent = s.messages.slice(sm ? sm.upTo : 0).filter((m) => m.role === 'user').flatMap((m) => m.images ?? []);
  const all = [...sent, ...pendingOf(s)];
  return [all.reduce((n, x) => n + (x.tokens ?? 0), 0), all.length, all.map((x) => `${x.name} : ${tokensText(x.tokens)}`)];
}

// Le texte d'une image pour le résumé : « [image : capture.png] ».
export const imageLines = (m) => (m.images ?? []).map((x) => `[image : ${x.name}]`).join(' ');

