// Nel Code Desktop — mcp.js : Les serveurs MCP : la page MCP (état, outils, erreurs, journal, Redémarrer, Tester, ajout,
// import, accords des serveurs de projet), les serveurs de la conversation (puce MCP, barre de contexte), l'accord
// demandé pour un serveur de projet, et l'arrêt des serveurs d'une conversation fermée.
// Les textes (noms, commandes, journaux, descriptions d'outils) passent toujours par textContent, jamais par innerHTML.

import { $, confirmDialog, dialog, errText, h, invoke, toast } from './util.js';
import { S, UI } from './state.js';
import { refreshContext, saveSession } from './conversation.js';

const STATE = { stopped: 'arrêté', starting: 'démarrage…', running: 'en marche', error: 'erreur' };
const SCOPE = { global: 'global', project: 'projet' };

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
  chip.title = `Serveurs MCP de cette conversation : ${on} sur ${avail.length} activé(s), ${ctx.servers.filter((x) => x.on).reduce((a, x) => a + x.tools, 0)} outil(s).\nClic : choisir les serveurs.`;
  refreshContext();
  checkApprovals();
}

/** Réglages → MCP : les serveurs de la conversation, cochés ou non (enregistré tout de suite ; moins d'outils envoyés
 *  au modèle). null hors du mode Agent. */
export function conversationServers() {
  const s = S.current, ctx = S.mcpCtx;
  if (!s?.agent || s.claudeAgent || !ctx?.servers.length) return null;
  const boxes = ctx.servers.map((x) => {
    const c = h('input', { type: 'checkbox', checked: x.on, disabled: !x.available, 'data-key': x.key });
    c.addEventListener('change', save);
    return h('label', { class: 'check mcp-choice' }, c, h('span', {}, x.name), h('span', { class: 'meta' },
      x.available ? `${SCOPE[x.scope]} · ${x.tools} outil${x.tools > 1 ? 's' : ''} · ≈ ${x.tokens.toLocaleString('fr-CH')} tokens` : `${SCOPE[x.scope]} · ${x.scope === 'project' ? 'non autorisé' : 'désactivé'}`));
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

// --- Accord pour un serveur de projet ---------------------------------------------------------------------

const asked = new Set();   // « clé:empreinte » déjà demandés (Échap : redemandé au prochain lancement)

/** Ce que l'utilisateur doit voir avant d'autoriser : commande exacte, arguments, dossier (ou adresse). */
export function launchInfo(v) {
  const rows = v.type === 'http'
    ? [['Adresse', v.config.url], ['En-têtes', Object.keys(v.config.headers ?? {}).concat(v.config.secretHeaders ?? []).join(', ') || '(aucun)']]
    : [['Commande', v.program ?? v.config.command], ['Arguments', (v.config.args ?? []).length ? null : '(aucun)'], ['Dossier', v.cwd ?? '?'],
      ['Variables', Object.keys(v.config.env ?? {}).concat(v.config.secretEnv ?? []).join(', ') || '(aucune)']];
  return h('dl', { class: 'mcp-launch' }, rows.flatMap(([k, val]) => [h('dt', {}, k),
    k === 'Arguments' && val === null ? h('dd', {}, h('ol', { class: 'args' }, v.config.args.map((a) => h('li', {}, a)))) : h('dd', {}, val)]));
}

async function decide(v, allow) {
  try {
    await invoke('mcp_approve', { dir: dirOf(), key: v.key, hash: v.hash, allow });
    toast(allow ? `Serveur MCP « ${v.name} » autorisé pour ce projet.` : `Serveur MCP « ${v.name} » refusé : il ne démarrera pas.`, allow ? 'success' : '', 4000);
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
    const choice = await dialog('Serveur MCP du projet', [
      h('p', {}, `Le dossier « ${dirOf()} » demande de lancer ce serveur MCP (« ${v.name} », .nelcode/mcp.json). Il ne démarre jamais sans ton accord, donné pour cette configuration précise.`),
      launchInfo(v),
      h('p', { class: 'hint' }, 'N\'autorise que si tu connais ce projet : le programme tourne sur ton PC avec tes droits.')],
    [{ label: 'Refuser', value: 'deny' }, { label: 'Autoriser', value: 'allow', primary: true }]);
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
    const files = h('div', { class: 'hint' }, `Serveurs globaux : ${list.globalFile}`, list.projectFile ? h('br') : '', list.projectFile ? `Serveurs du projet : ${list.projectFile}` : '');
    const actions = h('div', { class: 'row-btns' },
      h('button', { class: 'btn', onclick: () => { form = form ? null : addForm(); draw(); } }, icon('plus'), 'Ajouter un serveur'),
      h('button', { class: 'btn', onclick: importClaude }, icon('download'), 'Importer de Claude Desktop'),
      h('button', { class: 'btn', onclick: importFile }, icon('file'), 'Importer un fichier…'));
    const errors = list.errors.map((e) => h('div', { class: 'warn-text' }, `${e.scope === 'project' ? 'Projet' : 'mcp.json'}${e.name ? ` — « ${e.name} »` : ''} : ${e.error}`));
    const cards = list.servers.length ? list.servers.map(card) : [h('p', { class: 'hint' }, 'Aucun serveur MCP. Ajoute-en un, ou importe ceux de Claude Desktop.')];
    box.replaceChildren(files, actions, form ?? '', ...errors, ...cards,
      h('p', { class: 'hint' }, 'Les outils des serveurs sont proposés au modèle en mode Agent (mcp__serveur__outil) ; chaque appel te demande ton accord. Pas d\'OAuth (en-têtes fixes seulement), ni ressources ni prompts MCP dans cette version.'));
  };

  const run = async (what, fn) => {
    try { await fn(); } catch (e) { toast(`${what} : ${errText(e)}`, 'error', 8000); }
    draw();
  };

  function card(v) {
    const st = v.status ?? {};
    const state = st.state ?? 'stopped';
    const toolList = v.tools ?? [];
    const meta = [SCOPE[v.scope], v.type, toolList.length ? `${toolList.length} outil${toolList.length > 1 ? 's' : ''} · ≈ ${v.tokens.toLocaleString('fr-CH')} tokens` : null, v.disabled ? 'désactivé' : null].filter(Boolean).join(' · ');
    const what = v.type === 'http' ? v.config.url : [v.program ?? v.config.command, ...(v.config.args ?? [])].join(' ');
    const btns = h('div', { class: 'row-btns' },
      h('button', { class: 'btn', onclick: () => run('Test', async () => {
        const r = await invoke('mcp_test', { dir: dirOf(), key: v.key });
        toast(`« ${v.name} » répond : ${r.tools.length} outil${r.tools.length > 1 ? 's' : ''} (${r.seconds.toLocaleString('fr-CH', { maximumFractionDigits: 1 })} s).`, 'success');
      }) }, icon('check'), 'Tester'),
      h('button', { class: 'btn', onclick: () => run('Redémarrage', async () => { await invoke('mcp_restart', { dir: dirOf(), key: v.key, session: S.current?.id ?? null }); toast(`« ${v.name} » redémarré.`, 'success', 2500); }) }, icon('refresh-cw'), 'Redémarrer'),
      h('button', { class: 'btn', onclick: () => { logs.has(v.key) ? logs.delete(v.key) : logs.add(v.key); draw(); } }, icon('file-text'), 'Journal'),
      v.scope === 'global' ? h('button', { class: 'btn', onclick: () => run('Réglage', () => invoke('mcp_set_disabled', { name: v.name, disabled: !v.disabled })) }, v.disabled ? 'Activer' : 'Désactiver') : null,
      v.scope === 'global' ? h('button', { class: 'btn danger', onclick: async () => {
        if (await confirmDialog('Supprimer le serveur MCP ?', `« ${v.name} » sera retiré de mcp.json, avec ses valeurs secrètes.`, 'Supprimer', true)) {
          try { await invoke('mcp_delete_server', { name: v.name }); } catch (e) { toast(errText(e), 'error'); }
        }
        draw();
      } }, 'Supprimer') : null);
    const approval = v.scope === 'project' ? h('div', { class: 'mcp-approval', 'data-approval': v.approval },
      h('span', {}, { allow: 'Autorisé pour ce projet et cette configuration.', deny: 'Refusé : il ne démarre pas.', pending: 'En attente de ton accord : il ne démarre pas.' }[v.approval]),
      v.approval !== 'allow' && !v.problem ? h('button', { class: 'btn primary', onclick: () => run('Accord', () => decide(v, true)) }, 'Autoriser') : null,
      v.approval !== 'deny' && !v.problem ? h('button', { class: 'btn', onclick: () => run('Accord', () => decide(v, false)) }, 'Refuser') : null) : null;
    const secrets = (v.secrets ?? []).map((x) => {
      const input = h('input', { class: 'text-input key', type: 'password', autocomplete: 'off', placeholder: x.set ? 'valeur enregistrée (vide : inchangée)' : 'valeur manquante' });
      return h('div', { class: 'row-btns mcp-secret' }, h('span', { class: 'name' }, `${x.kind === 'env' ? 'Variable' : 'En-tête'} ${x.name}`), input,
        h('button', { class: 'btn', onclick: () => input.value && run('Valeur secrète', async () => { await invoke('mcp_set_secret', { dir: dirOf(), key: v.key, kind: x.kind, name: x.name, value: input.value }); toast('Valeur rangée dans le Gestionnaire d\'identification.', 'success', 3000); }) }, 'Ranger'));
    });
    const tools = toolList.length ? h('details', { class: 'mcp-tools', open: shown.has(v.key), ontoggle: (e) => (e.target.open ? shown.add(v.key) : shown.delete(v.key)) },
      h('summary', {}, `Outils (${toolList.length})`), h('ul', {}, toolList.map((t) => h('li', {}, h('code', {}, t.name), t.description ? ` — ${t.description}` : '')))) : null;
    const log = logs.has(v.key) ? h('pre', { class: 'mcp-log' }, '…') : null;
    if (log) invoke('mcp_log', { key: v.key }).then((t) => (log.textContent = t || '(journal vide)')).catch((e) => (log.textContent = errText(e)));
    const error = st.error || v.problem;
    return h('div', { class: 'mcp-server', 'data-key': v.key, 'data-state': state },
      h('div', { class: 'row' }, icon('plug'), h('strong', {}, v.name), h('span', { class: 'meta' }, meta), h('span', { class: 'mcp-state ' + state }, STATE[state] ?? state)),
      h('div', { class: 'mcp-what' }, what), v.type === 'stdio' && v.cwd ? h('div', { class: 'hint' }, `Dossier : ${v.cwd}`) : null,
      error ? h('div', { class: 'warn-text' }, error) : null, approval, ...secrets, btns, tools, log);
  }

  function addForm() {
    const name = h('input', { class: 'text-input', placeholder: 'nom (lettres, chiffres, - et _)', spellcheck: 'false' });
    const type = h('select', { class: 'text-input' }, h('option', { value: 'stdio' }, 'stdio (un programme lancé par Nel Code)'), h('option', { value: 'http' }, 'Streamable HTTP (une adresse)'));
    const command = h('input', { class: 'text-input', placeholder: 'commande, par exemple npx ou C:\\outils\\serveur.exe', spellcheck: 'false' });
    const args = h('textarea', { class: 'text-input', rows: 3, spellcheck: 'false', placeholder: 'un argument par ligne\n-y\n@modelcontextprotocol/server-filesystem' });
    const cwd = h('input', { class: 'text-input', placeholder: 'dossier (chemin complet ; vide : ton dossier personnel)', spellcheck: 'false' });
    const url = h('input', { class: 'text-input', placeholder: 'https://exemple.org/mcp', spellcheck: 'false' });
    const env = h('textarea', { class: 'text-input', rows: 2, spellcheck: 'false', placeholder: 'NOM=valeur (une par ligne)' });
    const headers = h('textarea', { class: 'text-input', rows: 2, spellcheck: 'false', placeholder: 'Authorization: Bearer … (un par ligne)' });
    const stdio = h('div', { class: 'mcp-stdio' }, command, args, cwd, h('div', { class: 'hint' }, 'Variables d\'environnement (secrètes) :'), env);
    const http = h('div', { class: 'mcp-http', hidden: true }, url, h('div', { class: 'hint' }, 'En-têtes (secrets, pas d\'OAuth) :'), headers);
    type.addEventListener('change', () => { stdio.hidden = type.value !== 'stdio'; http.hidden = type.value !== 'http'; });
    const pairs = (text, sep) => Object.fromEntries(text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(sep); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, '']; }));
    const add = () => run('Ajout', async () => {
      const def = type.value === 'http' ? { type: 'http', url: url.value.trim() }
        : { command: command.value.trim(), args: args.value.split('\n').map((l) => l.trim()).filter(Boolean), ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}) };
      const secrets = type.value === 'http' ? { headers: pairs(headers.value, ':') } : { env: pairs(env.value, '=') };
      await invoke('mcp_add_server', { name: name.value.trim(), def, secrets });
      form = null;
      toast(`Serveur « ${name.value.trim()} » ajouté (valeurs secrètes dans le ${S.info.keystore}).`, 'success');
    });
    return h('div', { class: 'mcp-form' }, name, type, stdio, http, h('div', { class: 'hint' }, `Les valeurs des variables et des en-têtes vont dans le ${S.info.keystore}, jamais dans mcp.json.`),
      h('div', { class: 'row-btns' }, h('button', { class: 'btn primary', onclick: add }, 'Ajouter'), h('button', { class: 'btn', onclick: () => { form = null; draw(); } }, 'Annuler')));
  }

  const report = (r) => {
    const ok = r.imported.map((x) => x.warning ? `${x.name} (attention : ${x.warning})` : x.name);
    const bad = r.rejected.map((x) => `${x.name} : ${x.error}`);
    toast([ok.length ? `Importé${ok.length > 1 ? 's' : ''} : ${ok.join(', ')}.` : 'Aucun serveur importé.', ...bad.map((b) => h('div', { class: 'line' }, `Refusé — ${b}`))], bad.length ? 'warning' : 'success', 10000);
  };
  const importClaude = () => run('Import', async () => {
    const path = await invoke('mcp_claude_desktop');
    if (!path) return toast('Configuration de Claude Desktop introuvable (%APPDATA%\\Claude\\claude_desktop_config.json).', 'warning');
    report(await invoke('mcp_import', { path }));
  });
  const importFile = () => run('Import', async () => {
    const path = await invoke('pick_mcp_config');
    if (path) report(await invoke('mcp_import', { path }));
  });

  UI.mcpRedraw = draw;   // retiré à la fermeture des réglages
  await draw();
  return box;
}
