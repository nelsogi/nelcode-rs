// Nel Code Desktop — mcp.js : Les serveurs MCP : la page MCP (état, outils, erreurs, journal, Redémarrer, Tester, ajout,
// import, accords des serveurs de projet), les serveurs de la conversation (puce MCP, barre de contexte), l'accord
// demandé pour un serveur de projet, et l'arrêt des serveurs d'une conversation fermée.
// Les textes (noms, commandes, journaux, descriptions d'outils) passent toujours par textContent, jamais par innerHTML.

import { locale, num, t, tr } from './i18n.js';
import { $, confirmDialog, dialog, errText, h, invoke, toast } from './util.js';
import { S, UI } from './state.js';
import { refreshContext, saveSession } from './conversation.js';
import { commit, openSettings } from './settings-page.js';

// L'état et la portée d'un serveur, traduits à l'affichage (mcp.state.*, mcp.scope.*).
const STATE = (s) => t('mcp.state.' + s);
const SCOPE = (s) => t('mcp.scope.' + s);

/** Les serveurs désactivés pour la conversation (clés « g:nom », « p…:nom »). */
export const mcpOff = (s) => s?.mcpOff ?? [];

const dirOf = () => (S.current?.workingDirectory || null);

// --- Les conversations qui ont lancé des serveurs : arrêtés quand on en ouvre une autre --------------------

const started = new Set();

/** Une demande Agent va lancer les serveurs MCP de `s`. */
export function mcpStarted(s) { started.add(s.id); }

/** Après un changement de conversation : les serveurs des autres conversations sont arrêtés (sauf réponse en cours). */
export function closeOtherMcp() {
  for (const id of [...started]) {
    if (id === S.current?.id || S.gen?.session?.id === id) continue;
    started.delete(id);
    invoke('mcp_close_session', { session: id }).catch(() => {});
  }
}

// --- Puce MCP et barre de contexte ------------------------------------------------------------------------

/** Les définitions d'outils du mode Agent (Nel Code et serveurs MCP actifs), puis la puce et la barre de contexte. */
export async function refreshMcp() {
  const s = S.current, chip = $('mcp-chip'), ask = (UI.mcpAsk = (UI.mcpAsk ?? 0) + 1);
  if (!s?.agent || s.claudeAgent) { S.mcpCtx = null; chip.hidden = true; return; }
  let ctx;
  try { ctx = await invoke('mcp_context', { dir: dirOf(), off: mcpOff(s) }); } catch { return; }
  if (ask !== UI.mcpAsk) return;
  S.mcpCtx = ctx;
  const avail = ctx.servers.filter((x) => x.available);
  chip.hidden = !ctx.servers.length;
  const on = avail.filter((x) => x.on).length;
  chip.classList.toggle('on', on > 0);
  chip.replaceChildren(icon('plug'), h('span', {}, `MCP ${on}/${avail.length}`));
  chip.title = t('mcp.serveurs_mcp_cette_conversation_sur', { on: on, v1: avail.length, v2: ctx.servers.filter((x) => x.on).reduce((a, x) => a + x.tools, 0) });
  if (!$('menu').hidden && $('menu').classList.contains('mcp-pop')) drawPopover();
  refreshContext();
  checkApprovals();
}

/** Les serveurs de la conversation, cochés ou non (enregistré tout de suite ; moins d'outils envoyés au modèle) :
 *  dans la fenêtre de la puce MCP et dans Réglages → MCP. `states` : l'état de chaque serveur (clé → état), s'il est
 *  connu. null hors du mode Agent. */
export function conversationServers(states) {
  const s = S.current, ctx = S.mcpCtx;
  if (!s?.agent || s.claudeAgent || !ctx?.servers.length) return null;
  const boxes = ctx.servers.map((x) => {
    const c = h('input', { type: 'checkbox', checked: x.on, disabled: !x.available, 'data-key': x.key });
    c.addEventListener('change', save);
    const state = x.available && states?.[x.key];
    return h('label', { class: 'check mcp-choice' }, c, h('span', { class: 'name' }, x.name),
      state ? h('span', { class: 'mcp-state ' + state }, STATE(state)) : null,
      h('span', { class: 'meta' },
        x.available ? t('mcp.scope_tools_tokens', { scope: SCOPE(x.scope), n: x.tools, tokens: num(x.tokens) }) : `${SCOPE(x.scope)} · ${x.scope === 'project' ? t('mcp.non_autorise') : t('mcp.desactive')}`));
  });
  async function save() {
    const off = boxes.map((b) => b.querySelector('input')).filter((c) => !c.checked && !c.disabled).map((c) => c.dataset.key);
    // Les serveurs indisponibles gardent leur choix.
    const kept = mcpOff(s).filter((k) => ctx.servers.some((x) => x.key === k && !x.available));
    s.mcpOff = [...new Set([...off, ...kept])];
    if (!s.mcpOff.length) delete s.mcpOff;
    if (s.messages.length) await saveSession(s);
    UI.settingsSaved?.();
    refreshMcp();
  }
  return h('div', { class: 'mcp-conversation' }, ...boxes);
}

// --- La fenêtre de la puce MCP ------------------------------------------------------------------------------
// Ancrée sous la puce (l'élément #menu : fermée par un clic dehors ou Échap). Les accords des serveurs de projet et le
// reste restent dans Réglages → MCP.

/** Ouvre (ou ferme, si elle est déjà ouverte) la fenêtre des serveurs de la conversation. */
export async function serversPopover() {
  const menu = $('menu');
  if (!menu.hidden && menu.classList.contains('mcp-pop')) { menu.hidden = true; return; }
  if (!S.mcpCtx) return;
  menu.className = 'menu mcp-pop';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', t('mcp.serveurs_mcp_conversation'));
  menu.replaceChildren();
  menu.hidden = false;
  await drawPopover();
  menu.querySelector('input:not(:disabled), button')?.focus();
}

async function drawPopover() {
  const menu = $('menu'), chip = $('mcp-chip');
  if (menu.hidden || !menu.classList.contains('mcp-pop')) return;
  const states = {};
  try { for (const v of (await invoke('mcp_list', { dir: dirOf() })).servers) states[v.key] = v.status?.state ?? 'stopped'; } catch { /* sans les états */ }
  if (menu.hidden || !menu.classList.contains('mcp-pop')) return;
  const focused = document.activeElement?.dataset?.key;
  menu.replaceChildren(h('div', { class: 'pop-title' }, t('mcp.serveurs_mcp_conversation')),
    conversationServers(states) ?? h('p', { class: 'hint' }, t('mcp.aucun_serveur_mcp_pour_cette')),
    h('p', { class: 'hint' }, t('mcp.outils_serveurs_coches_sont_envoyes')),
    h('hr'),
    h('button', { class: 'pop-link', onclick: () => { menu.hidden = true; openSettings('mcp', 'mcp-servers'); } }, icon('settings'), t('mcp.reglages_mcp')));
  if (focused) menu.querySelector(`input[data-key="${CSS.escape(focused)}"]`)?.focus();
  // Sous la puce, aligné sur son bord droit, sans sortir de la fenêtre.
  const r = chip.getBoundingClientRect(), m = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.right - m.width, innerWidth - m.width - 8)) + 'px';
  menu.style.top = Math.min(r.bottom + 6, innerHeight - m.height - 8) + 'px';
}

// --- Accord pour un serveur de projet ---------------------------------------------------------------------

const asked = new Set();   // « clé:empreinte » déjà demandés (Échap : redemandé au prochain lancement)

/** Ce que l'utilisateur doit voir avant d'autoriser : commande exacte, arguments, dossier (ou adresse). */
export function launchInfo(v) {
  const rows = v.type === 'http'
    ? [[t('mcp.adresse'), v.config.url], [t('mcp.tetes'), Object.keys(v.config.headers ?? {}).concat(v.config.secretHeaders ?? []).join(', ') || '(aucun)']]
    : [[t('mcp.commande'), v.program ?? v.config.command], [t('mcp.arguments'), (v.config.args ?? []).length ? null : '(aucun)'], [t('mcp.dossier'), v.cwd ?? '?'],
      [t('mcp.variables'), Object.keys(v.config.env ?? {}).concat(v.config.secretEnv ?? []).join(', ') || '(aucune)']];
  return h('dl', { class: 'mcp-launch' }, rows.flatMap(([k, val]) => [h('dt', {}, k),
    k === 'Arguments' && val === null ? h('dd', {}, h('ol', { class: 'args' }, v.config.args.map((a) => h('li', {}, a)))) : h('dd', {}, val)]));
}

async function decide(v, allow) {
  try {
    await invoke('mcp_approve', { dir: dirOf(), key: v.key, hash: v.hash, allow });
    toast(allow ? t('mcp.serveur_mcp_autorise_pour_ce', { name: v.name }) : t('mcp.serveur_mcp_refuse_il_ne', { name: v.name }), allow ? 'success' : '', 4000);
  } catch (e) { toast(errText(e), 'error'); }
}

/** Mode Agent dans un dossier dont un serveur de projet n'est pas encore autorisé : on demande (une fois). */
export async function checkApprovals() {
  const s = S.current;
  if (!s?.agent || !dirOf() || S.gen || !$('overlay').hidden) return;
  let list;
  try { list = await invoke('mcp_list', { dir: dirOf() }); } catch { return; }
  for (const v of list.servers) {
    const id = `${v.key}:${v.hash}`;
    if (v.scope !== 'project' || v.approval !== 'pending' || v.problem || asked.has(id) || !$('overlay').hidden) continue;
    asked.add(id);
    const choice = await dialog(t('mcp.serveur_mcp_projet'), [
      h('p', {}, t('mcp.dossier_demande_lancer_ce_serveur', { dirOf: dirOf(), name: v.name })),
      launchInfo(v),
      h('p', { class: 'hint' }, t('mcp.autorise_que_si_tu_connais'))],
    [{ label: t('mcp.refuser'), value: 'deny' }, { label: t('mcp.autoriser'), value: 'allow', primary: true }]);
    if (choice) { await decide(v, choice === 'allow'); refreshMcp(); }
  }
}

// --- La page MCP ------------------------------------------------------------------------------------------

/** Réglages → MCP : les serveurs (état, outils, journal, Redémarrer, Tester, ajout, import, accords). */
export async function mcpPanel() {
  const box = h('div', { class: 'mcp-page' });
  const logs = new Set(), shown = new Set();   // journaux et listes d'outils dépliés (gardés au rafraîchissement)
  let form = null;
  const draw = async () => {
    let list;
    try { list = await invoke('mcp_list', { dir: dirOf() }); } catch (e) { box.replaceChildren(h('p', { class: 'warn-text' }, errText(e))); return; }
    const files = h('div', { class: 'hint' }, t('mcp.serveurs_globaux', { globalFile: list.globalFile }), list.projectFile ? h('br') : '', list.projectFile ? t('mcp.serveurs_projet', { projectFile: list.projectFile }) : '');
    const actions = h('div', { class: 'row-btns' },
      h('button', { class: 'btn', onclick: () => { form = form ? null : addForm(); draw(); } }, icon('plus'), t('mcp.ajouter_serveur')),
      h('button', { class: 'btn', onclick: importClaude }, icon('download'), t('mcp.importer_claude_desktop')),
      h('button', { class: 'btn', onclick: importFile }, icon('file'), t('mcp.importer_fichier')));
    const errors = list.errors.map((e) => h('div', { class: 'warn-text' }, e.name ? t('mcp.config_error_named', { where: e.scope === 'project' ? t('mcp.projet') : 'mcp.json', name: e.name, error: tr(e.error) }) : t('mcp.config_error', { where: e.scope === 'project' ? t('mcp.projet') : 'mcp.json', error: tr(e.error) })));
    const cards = list.servers.length ? list.servers.map(card) : [h('p', { class: 'hint' }, t('mcp.aucun_serveur_mcp_ajoute_importe'))];
    box.replaceChildren(files, actions, form ?? '', ...errors, ...cards,
      h('p', { class: 'hint' }, t('mcp.outils_serveurs_sont_proposes_au')));
  };

  const run = async (what, fn) => {
    try { await fn(); } catch (e) { toast(t('mcp.action_error', { what, error: errText(e) }), 'error', 8000); }
    draw();
  };

  function card(v) {
    const st = v.status ?? {};
    const state = st.state ?? 'stopped';
    const toolList = v.tools ?? [];
    const meta = [SCOPE(v.scope), v.type, toolList.length ? t('mcp.tools_tokens', { n: toolList.length, tokens: num(v.tokens) }) : null, v.disabled ? t('mcp.desactive') : null].filter(Boolean).join(' · ');
    const what = v.type === 'http' ? v.config.url : [v.program ?? v.config.command, ...(v.config.args ?? [])].join(' ');
    const btns = h('div', { class: 'row-btns' },
      h('button', { class: 'btn', onclick: () => run(t('mcp.test'), async () => {
        const r = await invoke('mcp_test', { dir: dirOf(), key: v.key });
        toast(t('mcp.test_ok', { name: v.name, n: r.tools.length, seconds: num(r.seconds, { maximumFractionDigits: 1 }) }), 'success');
      }) }, icon('check'), t('mcp.tester')),
      h('button', { class: 'btn', onclick: () => run(t('mcp.redemarrage'), async () => { await invoke('mcp_restart', { dir: dirOf(), key: v.key, session: S.current?.id ?? null }); toast(t('mcp.redemarre', { name: v.name }), 'success', 2500); }) }, icon('refresh-cw'), t('mcp.redemarrer')),
      h('button', { class: 'btn', onclick: () => { logs.has(v.key) ? logs.delete(v.key) : logs.add(v.key); draw(); } }, icon('file-text'), t('mcp.journal')),
      v.scope === 'global' ? h('button', { class: 'btn', onclick: () => run(t('mcp.reglage'), () => invoke('mcp_set_disabled', { name: v.name, disabled: !v.disabled })) }, v.disabled ? t('mcp.activer') : t('mcp.desactiver')) : null,
      v.scope === 'global' ? h('button', { class: 'btn danger', onclick: async () => {
        if (await confirmDialog(t('mcp.supprimer_serveur_mcp'), t('mcp.sera_retire_mcp_json_avec', { name: v.name }), t('mcp.supprimer'), true)) {
          try { await invoke('mcp_delete_server', { name: v.name }); } catch (e) { toast(errText(e), 'error'); }
        }
        draw();
      } }, t('mcp.supprimer')) : null);
    const approval = v.scope === 'project' ? h('div', { class: 'mcp-approval', 'data-approval': v.approval },
      h('span', {}, { allow: t('mcp.autorise_pour_ce_projet_cette'), deny: t('mcp.refuse_il_ne_demarre_pas'), pending: t('mcp.attente_ton_accord_il_ne') }[v.approval]),
      v.approval !== 'allow' && !v.problem ? h('button', { class: 'btn primary', onclick: () => run(t('mcp.accord'), () => decide(v, true)) }, t('mcp.autoriser')) : null,
      v.approval !== 'deny' && !v.problem ? h('button', { class: 'btn', onclick: () => run(t('mcp.accord'), () => decide(v, false)) }, t('mcp.refuser')) : null) : null;
    const secrets = (v.secrets ?? []).map((x) => {
      const input = h('input', { class: 'text-input key', type: 'password', autocomplete: 'off', placeholder: x.set ? t('mcp.valeur_enregistree_vide_inchangee') : 'valeur manquante' });
      return h('div', { class: 'row-btns mcp-secret' }, h('span', { class: 'name' }, `${x.kind === 'env' ? t('mcp.variable') : t('mcp.tete')} ${x.name}`), input,
        h('button', { class: 'btn', onclick: () => input.value && run(t('mcp.valeur_secrete'), async () => { await invoke('mcp_set_secret', { dir: dirOf(), key: v.key, kind: x.kind, name: x.name, value: input.value }); toast(t('mcp.valeur_rangee_dans_gestionnaire_identification'), 'success', 3000); }) }, t('mcp.ranger')));
    });
    const tools = toolList.length ? h('details', { class: 'mcp-tools', open: shown.has(v.key), ontoggle: (e) => (e.target.open ? shown.add(v.key) : shown.delete(v.key)) },
      h('summary', {}, t('mcp.outils', { v0: toolList.length })), h('ul', {}, toolList.map((tx) => h('li', {}, h('code', {}, tx.name), tx.description ? ` — ${tx.description}` : '')))) : null;
    const log = logs.has(v.key) ? h('pre', { class: 'mcp-log' }, '…') : null;
    if (log) invoke('mcp_log', { key: v.key }).then((tx) => (log.textContent = tx || '(journal vide)')).catch((e) => (log.textContent = errText(e)));
    // Activé par défaut dans les nouvelles conversations (sinon : ajouté à leur mcpOff à la création).
    const byDefault = h('input', { type: 'checkbox', class: 'mcp-default', checked: !(S.settings.mcpDefaultOff ?? []).includes(v.key), 'data-key': v.key });
    byDefault.addEventListener('change', async () => {
      const off = new Set(S.settings.mcpDefaultOff ?? []);
      byDefault.checked ? off.delete(v.key) : off.add(v.key);
      const e = await commit({ mcpDefaultOff: [...off] });
      if (e) toast(e, 'error');
    });
    const defaultRow = h('label', { class: 'check mcp-default-row' }, byDefault, t('mcp.active_par_defaut_dans_nouvelles'));
    const error = tr(st.error || v.problem);
    return h('div', { class: 'mcp-server', 'data-key': v.key, 'data-state': state },
      h('div', { class: 'row' }, icon('plug'), h('strong', {}, v.name), h('span', { class: 'meta' }, meta), h('span', { class: 'mcp-state ' + state }, STATE(state))),
      h('div', { class: 'mcp-what' }, what), v.type === 'stdio' && v.cwd ? h('div', { class: 'hint' }, t('mcp.dossier_2', { cwd: v.cwd })) : null,
      error ? h('div', { class: 'warn-text' }, error) : null, approval, ...secrets, defaultRow, btns, tools, log);
  }

  function addForm() {
    const name = h('input', { class: 'text-input', placeholder: t('mcp.nom_lettres_chiffres'), spellcheck: 'false' });
    const type = h('select', { class: 'text-input' }, h('option', { value: 'stdio' }, t('mcp.stdio_programme_lance_par_nel')), h('option', { value: 'http' }, t('mcp.streamable_http_adresse')));
    const command = h('input', { class: 'text-input', placeholder: t('mcp.commande_par_exemple_npx_outils'), spellcheck: 'false' });
    const args = h('textarea', { class: 'text-input', rows: 3, spellcheck: 'false', placeholder: t('mcp.argument_par_ligne_modelcontextprotocol_server') });
    const cwd = h('input', { class: 'text-input', placeholder: t('mcp.dossier_chemin_complet_vide_ton'), spellcheck: 'false' });
    const url = h('input', { class: 'text-input', placeholder: t('mcp.https_exemple_org_mcp'), spellcheck: 'false' });
    const env = h('textarea', { class: 'text-input', rows: 2, spellcheck: 'false', placeholder: t('mcp.nom_valeur_par_ligne') });
    const headers = h('textarea', { class: 'text-input', rows: 2, spellcheck: 'false', placeholder: t('mcp.authorization_bearer_par_ligne') });
    const stdio = h('div', { class: 'mcp-stdio' }, command, args, cwd, h('div', { class: 'hint' }, t('mcp.variables_environnement_secretes')), env);
    const http = h('div', { class: 'mcp-http', hidden: true }, url, h('div', { class: 'hint' }, t('mcp.tetes_secrets_pas_oauth')), headers);
    type.addEventListener('change', () => { stdio.hidden = type.value !== 'stdio'; http.hidden = type.value !== 'http'; });
    const pairs = (text, sep) => Object.fromEntries(text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(sep); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, '']; }));
    const add = () => run(t('mcp.ajout'), async () => {
      const def = type.value === 'http' ? { type: 'http', url: url.value.trim() }
        : { command: command.value.trim(), args: args.value.split('\n').map((l) => l.trim()).filter(Boolean), ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}) };
      const secrets = type.value === 'http' ? { headers: pairs(headers.value, ':') } : { env: pairs(env.value, '=') };
      await invoke('mcp_add_server', { name: name.value.trim(), def, secrets });
      form = null;
      toast(t('mcp.serveur_ajoute_valeurs_secretes_dans', { v0: name.value.trim(), keystore: S.info.keystore }), 'success');
    });
    return h('div', { class: 'mcp-form' }, name, type, stdio, http, h('div', { class: 'hint' }, t('mcp.valeurs_variables_tetes_vont_dans', { keystore: S.info.keystore })),
      h('div', { class: 'row-btns' }, h('button', { class: 'btn primary', onclick: add }, t('mcp.ajouter')), h('button', { class: 'btn', onclick: () => { form = null; draw(); } }, t('mcp.annuler'))));
  }

  const report = (r) => {
    const ok = r.imported.map((x) => x.warning ? t('mcp.import_warning', { name: x.name, warning: tr(x.warning) }) : x.name);
    const bad = r.rejected.map((x) => t('mcp.import_rejected', { name: x.name, error: tr(x.error) }));
    toast([ok.length ? t('mcp.imported', { n: ok.length, list: ok.join(', ') }) : t('mcp.aucun_serveur_importe'), ...bad.map((b) => h('div', { class: 'line' }, t('mcp.refuse', { b: b })))], bad.length ? 'warning' : 'success', 10000);
  };
  const importClaude = () => run(t('mcp.import'), async () => {
    const path = await invoke('mcp_claude_desktop');
    if (!path) return toast(t('mcp.configuration_claude_desktop_introuvable_appdata'), 'warning');
    report(await invoke('mcp_import', { path }));
  });
  const importFile = () => run(t('mcp.import'), async () => {
    const path = await invoke('pick_mcp_config');
    if (path) report(await invoke('mcp_import', { path }));
  });

  UI.mcpRedraw = draw;   // retiré à la fermeture des réglages
  await draw();
  return box;
}
