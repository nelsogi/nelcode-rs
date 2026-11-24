// Tests de la page Réglages : catégories, recherche, enregistrement automatique, erreurs de saisie, valeurs par défaut,
// liens directs (barre d'état, /settings, palette), clavier, zoom et densité, export et import sans secret.
// Usage : cargo build -p nel-desktop ; node --test e2e/settings.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { launch, sleep } from './harness.mjs';

let A;
const open = async (cat, id) => {
  await A.ev(`openSettings(${JSON.stringify(cat)}${id ? ', ' + JSON.stringify(id) : ''})`);
  await A.waitFor(`!!T.settings()`, 5_000, 'page Réglages');
};
const close = async () => { await A.ev(`T.key('Escape', {}, document)`); await A.waitFor(`!T.settings()`, 5_000, 'réglages fermés'); };
const selected = () => A.ev(`document.querySelector('#settings-nav .cat.sel')?.dataset.cat ?? null`);
const disk = (k) => A.readJson('settings.json')[k];

before(async () => { A = await launch({ settings: { temperature: 0.8, maxReplyTokens: 80 } }); });
after(async () => A?.close());

test('taille de l\'interface : texte de base de 15 px, fenêtre d\'environ 80 % de l\'écran', async () => {
  assert.equal(await A.ev(`getComputedStyle(document.documentElement).fontSize`), '15px');
  assert.equal(await A.ev(`getComputedStyle(document.body).fontSize`), '15px');
  const ratio = await A.ev(`[outerWidth / screen.availWidth, outerHeight / screen.availHeight]`);
  for (const r of ratio) assert.ok(r > 0.72 && r < 0.88, `fenêtre à ${(r * 100).toFixed(0)} % de l'écran`);
  // Centrée (à quelques pixels près : bordures de la fenêtre).
  const left = await A.ev(`screenX - (screen.availLeft ?? 0)`), right = await A.ev(`screen.availWidth - outerWidth - (screenX - (screen.availLeft ?? 0))`);
  assert.ok(Math.abs(left - right) < 40, `centrée (${left} / ${right})`);
});

test('page en deux colonnes : les 11 catégories, Ctrl+, ouvre, Échap ferme', async () => {
  await A.ev(`T.key(',', { ctrlKey: true }, document)`);
  await A.waitFor(`!!T.settings()`, 5_000);
  assert.deepEqual(await A.ev(`[...document.querySelectorAll('#settings-nav .cat')].map((b) => b.textContent)`),
    ['Général', 'Modèles', 'Fournisseurs', 'Agent', 'Claude Agent', 'MCP', 'Images', 'Calcul', 'Suivi et budget', 'Serveur local', 'Avancé']);
  assert.equal(await selected(), 'general');
  assert.equal(await A.ev(`document.getElementById('app').inert`), true, 'le reste de la fenêtre est inerte');
  // Chaque réglage : libellé, explication, contrôle.
  for (const k of ['language', 'theme', 'accent', 'textSize', 'density', 'markdown', 'autoUpdate']) {
    assert.ok(await A.ev(`!!T.row('${k}')?.querySelector('.setting-label') && !!T.row('${k}').querySelector('.setting-hint').textContent && !!T.control('${k}')`), k);
  }
  assert.equal(await A.ev(`T.control('markdown').getAttribute('role')`), 'switch');
  assert.equal(await A.ev(`T.row('textSize').querySelector('input[type=range]').max`), '150');
  await close();
  assert.equal(await A.ev(`document.getElementById('app').inert`), false);
  assert.equal(await A.ev(`document.activeElement.id`), 'input', 'le focus revient à la saisie');
});

test('enregistrement automatique : curseur et champ numérique, « Enregistré », point « modifié »', async () => {
  await open('models');
  assert.equal(await A.ev(`T.row('temperature').classList.contains('changed')`), false, 'valeur par défaut : pas de point');
  await A.ev(`T.setValue(T.control('temperature'), '1,2')`);
  await A.waitFor(`S.settings.temperature === 1.2`, 5_000, 'enregistré');
  await A.waitFor(`document.getElementById('settings-saved').textContent === 'Enregistré'`, 5_000, 'indication « Enregistré »');
  assert.equal(disk('temperature'), 1.2);
  assert.equal(await A.ev(`T.row('temperature').querySelector('input[type=range]').value`), '1.2', 'le curseur suit');
  assert.equal(await A.ev(`T.row('temperature').classList.contains('changed')`), true, 'point : différent du défaut');
  // Le curseur : enregistré au relâchement (événement change).
  await A.ev(`(() => { const r = T.row('topK').querySelector('input[type=range]'); r.value = 35; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); return true; })()`);
  await A.waitFor(`S.settings.topK === 35`, 5_000);
  assert.equal(await A.ev(`T.control('topK').value`), '35');
  // Une liste : enregistrée tout de suite.
  await A.ev(`T.setValue(T.control('defaultModel'), '')`);
  await close();
});

test('erreurs de saisie : sous le champ, rien d\'enregistré', async () => {
  await open('models', 'maxReplyTokens');
  for (const [bad, msg] of [['500', /Entre 16 et 128/], ['abc', /Un nombre/], ['20,5', /entier/]]) {
    await A.ev(`T.setValue(T.control('maxReplyTokens'), ${JSON.stringify(bad)})`);
    assert.match(await A.ev(`T.row('maxReplyTokens').querySelector('.setting-error').textContent`), msg, bad);
    assert.equal(await A.ev(`T.control('maxReplyTokens').getAttribute('aria-invalid')`), 'true');
  }
  await sleep(900);
  assert.equal(disk('maxReplyTokens'), 80, 'valeur invalide jamais enregistrée');
  await A.ev(`T.setValue(T.control('maxReplyTokens'), '100')`);
  await A.waitFor(`S.settings.maxReplyTokens === 100`, 5_000);
  assert.equal(await A.ev(`T.row('maxReplyTokens').querySelector('.setting-error').hidden`), true, 'erreur effacée');
  // Le port du serveur local : même règle.
  await A.ev(`openSettings('server')`);
  await A.waitFor(`T.control('serverPort')`, 5_000);
  await A.ev(`T.setValue(T.control('serverPort'), '80')`);
  assert.match(await A.ev(`T.row('serverPort').querySelector('.setting-error').textContent`), /Entre 1024 et 65535/);
  await sleep(900);
  assert.equal(disk('serverPort'), 8765);
  await close();
});

test('valeur par défaut : par réglage, et « Tout réinitialiser » de la catégorie avec confirmation', async () => {
  await open('models');
  assert.equal(await A.ev(`T.row('temperature').querySelector('.reset').disabled`), false);
  await A.ev(`T.row('temperature').querySelector('.reset').click()`);
  await A.waitFor(`S.settings.temperature === 0.8`, 5_000, 'température par défaut');
  assert.equal(await A.ev(`T.control('temperature').value`), '0,8');
  assert.equal(await A.ev(`T.row('temperature').classList.contains('changed')`), false);
  // Tout réinitialiser : la confirmation liste ce qui change ; Annuler ne touche à rien.
  assert.deepEqual([disk('topK'), disk('maxReplyTokens')], [35, 100]);
  await A.ev(`T.button('Tout réinitialiser', T.settings())`);
  await A.waitFor(`T.dialog()?.textContent.includes('Réinitialiser « Modèles »')`, 5_000, 'confirmation');
  const text = await A.ev(`T.dialog().textContent`);
  assert.ok(text.includes('Top-k') && text.includes('Longueur max') && !text.includes('Température'), text);
  await A.ev(`T.button('Annuler', T.dialog())`);
  await sleep(300);
  assert.equal(disk('topK'), 35);
  assert.equal(await A.ev(`!!T.settings()`), true, 'la page reste ouverte');
  await A.ev(`T.button('Tout réinitialiser', T.settings())`);
  await A.waitFor(`!!T.dialog()`, 5_000);
  await A.ev(`T.button('Tout réinitialiser', T.dialog())`);
  await A.waitFor(`S.settings.topK === 20 && S.settings.maxReplyTokens === 80`, 5_000, 'catégorie réinitialisée');
  assert.equal(await A.ev(`T.settings().querySelectorAll('.setting.changed').length`), 0);
  // Échap dans la confirmation ferme la confirmation, pas la page.
  await A.ev(`T.setValue(T.control('topP'), '0,5')`);
  await A.waitFor(`S.settings.topP === 0.5`, 5_000);
  await A.ev(`T.button('Tout réinitialiser', T.settings())`);
  await A.waitFor(`!!T.dialog()`, 5_000);
  await A.ev(`T.key('Escape', {}, document)`);
  await A.waitFor(`!T.dialog()`, 5_000);
  assert.equal(await A.ev(`!!T.settings()`), true);
  assert.equal(disk('topP'), 0.5, 'Échap : rien de réinitialisé');
  await A.ev(`T.row('topP').querySelector('.reset').click()`);
  await A.waitFor(`S.settings.topP === 0.9`, 5_000);
  await close();
});

test('recherche : toutes les catégories, résultat surligné, lien vers les blocs', async () => {
  await open('general');
  await A.ev(`(() => { const s = document.getElementById('settings-search'); s.value = 'explorateur'; s.dispatchEvent(new Event('input')); return true; })()`);
  await A.waitFor(`T.settings().querySelector('.settings-results')?.textContent.startsWith('4 réglages')`, 5_000, 'résultats');
  assert.deepEqual(await A.ev(`[...T.settings().querySelectorAll('.setting')].map((r) => r.dataset.id)`), ['explorerConcurrency', 'explorerMax', 'explorerTurns', 'explorerModel']);
  assert.equal(await A.ev(`T.row('explorerMax').querySelector('.setting-label mark').textContent`), 'Explorateur');
  assert.equal(await selected(), null, 'aucune catégorie choisie pendant la recherche');
  // Un réglage trouvé se modifie sur place.
  await A.ev(`T.setValue(T.control('explorerMax'), '3')`);
  await A.waitFor(`S.settings.explorerMax === 3`, 5_000);
  // Sans accents ni casse, dans les explications aussi ; plusieurs catégories.
  await A.ev(`(() => { const s = document.getElementById('settings-search'); s.value = 'DELAI'; s.dispatchEvent(new Event('input')); s.value = 'secondes'; s.dispatchEvent(new Event('input')); s.value = 'gpu'; s.dispatchEvent(new Event('input')); return true; })()`);
  await A.waitFor(`T.settings().querySelectorAll('.settings-section').length >= 1`, 5_000);
  assert.ok(await A.ev(`!!T.settings().querySelector('.cat-calc .setting[data-id="device"]')`));
  // Un bloc (carte graphique) : un lien vers sa catégorie, surligné à l'arrivée.
  await A.ev(`T.button('Ouvrir Calcul', T.settings().querySelector('.setting[data-id="gpu"]'))`);
  await A.waitFor(`document.querySelector('#settings-nav .cat.sel')?.dataset.cat === 'calc'`, 5_000);
  assert.ok(await A.ev(`T.row('gpu').classList.contains('flash')`));
  assert.equal(await A.ev(`document.getElementById('settings-search').value`), '');
  // Rien trouvé.
  await A.ev(`(() => { const s = document.getElementById('settings-search'); s.value = 'zzzz'; s.dispatchEvent(new Event('input')); return true; })()`);
  assert.match(await A.ev(`T.settings().querySelector('.settings-results').textContent`), /Aucun réglage ne correspond à « zzzz »/);
  // Échap dans la recherche : la vide d'abord ; ensuite, ferme la page.
  await A.ev(`T.key('Escape', {}, document.getElementById('settings-search'))`);
  assert.equal(await A.ev(`document.getElementById('settings-search').value`), '');
  assert.equal(await A.ev(`!!T.settings()`), true);
  await A.ev(`openSettings('agent')`);
  await A.waitFor(`T.row('explorerMax')?.classList.contains('changed')`, 5_000);
  await A.ev(`T.row('explorerMax').querySelector('.reset').click()`);
  await A.waitFor(`S.settings.explorerMax === 5`, 5_000);
  await close();
});

test('clavier : flèches dans les catégories, Entrée vers les réglages, Ctrl+F vers la recherche', async () => {
  await open('general');
  await A.ev(`document.getElementById('cat-general').focus(); T.key('ArrowDown', {}, document.getElementById('cat-general'))`);
  assert.equal(await selected(), 'models');
  assert.equal(await A.ev(`document.activeElement.id`), 'cat-models');
  await A.ev(`T.key('End', {}, document.activeElement)`);
  assert.equal(await selected(), 'advanced');
  await A.ev(`T.key('ArrowDown', {}, document.activeElement)`);
  assert.equal(await selected(), 'general', 'boucle');
  await A.ev(`T.key('ArrowUp', {}, document.activeElement)`);
  assert.equal(await selected(), 'advanced');
  await A.ev(`T.key('Home', {}, document.activeElement)`);
  await A.ev(`T.key('Enter', {}, document.activeElement)`);
  assert.equal(await A.ev(`document.activeElement === T.control('language')`), true, 'premier réglage');
  // Seule la catégorie choisie est dans l'ordre de tabulation (Tab : catégorie → réglages).
  assert.deepEqual(await A.ev(`[...document.querySelectorAll('#settings-nav .cat')].filter((b) => b.tabIndex === 0).map((b) => b.dataset.cat)`), ['general']);
  await A.ev(`T.key('f', { ctrlKey: true }, document.activeElement)`);
  assert.equal(await A.ev(`document.activeElement.id`), 'settings-search');
  await A.ev(`T.key('ArrowDown', {}, document.activeElement)`);
  assert.equal(await A.ev(`document.activeElement === T.control('language')`), true, 'flèche bas : vers les réglages');
  // Les raccourcis de la conversation ne partent pas derrière la page.
  await A.ev(`T.key('n', { ctrlKey: true }, document.activeElement)`);
  assert.equal(await A.ev(`!!T.settings()`), true);
  await close();
});

test('liens directs : barre d\'état (modèle, calcul, contexte), /settings <catégorie>, palette Ctrl+K', async () => {
  await A.ev(`Object.assign(S.model, { name: 'faux-modele', device: 'CPU', remote: null }); renderStatus(); true`);
  await A.ev(`document.querySelector('#status [data-settings="models"]').click()`);
  await A.waitFor(`document.querySelector('#settings-nav .cat.sel')?.dataset.cat === 'models'`, 5_000, 'modèle → Modèles');
  await close();
  await A.ev(`document.querySelector('#status [data-settings="calc"]').click()`);
  await A.waitFor(`document.querySelector('#settings-nav .cat.sel')?.dataset.cat === 'calc' && document.activeElement === T.control('device')`, 5_000, 'CPU → Calcul');
  await close();
  await A.ev(`document.getElementById('context').click()`);
  await A.waitFor(`document.activeElement === T.control('contextLimit')`, 5_000, 'contexte → Contexte et résumé');
  await close();
  await A.ev(`Object.assign(S.model, { name: null, device: null }); renderStatus(); true`);
  // /settings <catégorie> : id, nom ou alias, sans accents.
  for (const [arg, cat] of [['gpu', 'calc'], ['fournisseurs', 'providers'], ['Général', 'general'], ['avance', 'advanced'], ['suivi', 'usage'], ['claude', 'claude']]) {
    await A.ev(`T.submit('/settings ${arg}')`);
    await A.waitFor(`document.querySelector('#settings-nav .cat.sel')?.dataset.cat === '${cat}'`, 5_000, `/settings ${arg}`);
    await close();
  }
  await A.ev(`T.submit('/settings inconnue')`);
  await A.waitFor(`T.toasts().includes('Catégorie inconnue : inconnue') && !!T.settings()`, 5_000, 'catégorie inconnue : Général');
  assert.equal(await selected(), 'general');
  await close();
  // Palette : une catégorie, et un réglage précis.
  await A.ev(`T.key('k', { ctrlKey: true }, document)`);
  await A.waitFor(`T.dialog()?.classList.contains('palette')`, 5_000);
  await A.ev(`T.setValue(T.dialog().querySelector('input'), 'Réglages : Serveur')`);
  await A.waitFor(`T.dialog().querySelector('.item.sel')?.textContent.includes('Réglages : Serveur local')`, 5_000);
  await A.ev(`T.key('Enter', {}, T.dialog().querySelector('input'))`);
  await A.waitFor(`document.querySelector('#settings-nav .cat.sel')?.dataset.cat === 'server'`, 5_000, 'palette → Serveur local');
  await close();
  await A.ev(`T.key('k', { ctrlKey: true }, document)`);
  await A.waitFor(`T.dialog()?.classList.contains('palette')`, 5_000);
  await A.ev(`T.setValue(T.dialog().querySelector('input'), 'pénalité de répétition')`);
  await A.waitFor(`T.dialog().querySelector('.item.sel')?.textContent.includes('Pénalité de répétition (Modèles)')`, 5_000);
  await A.ev(`T.key('Enter', {}, T.dialog().querySelector('input'))`);
  await A.waitFor(`document.activeElement === T.control('repetitionPenalty') && T.row('repetitionPenalty').classList.contains('flash')`, 5_000, 'palette → le réglage');
  await close();
});

test('zoom : Ctrl + / Ctrl − / Ctrl 0, de 80 à 150 % par pas de 10, enregistré, aussi page ouverte', async () => {
  const base = await A.ev(`devicePixelRatio`);
  for (let i = 0; i < 8; i++) await A.ev(`T.key('+', { ctrlKey: true }, document)`);
  await A.waitFor(`S.settings.textSize === 150`, 5_000, 'borné à 150 %');
  await A.waitFor(`Math.abs(devicePixelRatio / ${base} - 1.5) < 0.03`, 5_000, 'page à 150 %');
  for (let i = 0; i < 9; i++) await A.ev(`T.key('-', { ctrlKey: true }, document)`);
  await A.waitFor(`S.settings.textSize === 80`, 5_000, 'borné à 80 %');
  await A.waitFor(`window.__TAURI__.core.invoke('get_settings').then((s) => s.textSize === 80)`, 5_000, 'enregistré');
  // Page Réglages ouverte : le zoom marche, et le réglage affiché suit.
  await open('general', 'textSize');
  await A.ev(`T.key('=', { ctrlKey: true }, document.activeElement)`);
  await A.waitFor(`S.settings.textSize === 90 && T.control('textSize').value === '90'`, 5_000, 'la ligne suit');
  // Et depuis la page : le champ numérique, par pas de 10.
  await A.ev(`T.setValue(T.control('textSize'), '125')`);
  assert.match(await A.ev(`T.row('textSize').querySelector('.setting-error').textContent`), /Par pas de 10/);
  await A.ev(`T.setValue(T.control('textSize'), '120')`);
  await A.waitFor(`S.settings.textSize === 120`, 5_000);
  await A.waitFor(`Math.abs(devicePixelRatio / ${base} - 1.2) < 0.03`, 5_000, 'page à 120 %');
  await A.ev(`T.key('0', { ctrlKey: true }, document.activeElement)`);
  await A.waitFor(`S.settings.textSize === 100 && Math.abs(devicePixelRatio - ${base}) < 0.02`, 5_000, '100 %');
  await close();
});

test('thème, densité et couleur d\'accent : appliqués tout de suite', async () => {
  await open('general');
  await A.ev(`T.setValue(T.control('density'), 'compact')`);
  await A.waitFor(`document.documentElement.dataset.density === 'compact' && S.settings.density === 'compact'`, 5_000);
  const pad = (d) => A.ev(`(document.documentElement.dataset.density = '${d}', parseFloat(getComputedStyle(document.querySelector('#topbar')).paddingTop))`);
  const [c, n, f] = [await pad('compact'), await pad('normal'), await pad('comfortable')];
  assert.ok(c < n && n < f, `${c} < ${n} < ${f}`);
  await A.ev(`T.setValue(T.control('theme'), 'light')`);
  await A.waitFor(`document.documentElement.dataset.theme === 'light'`, 5_000);
  await A.ev(`T.setValue(T.control('accent'), 'orange')`);
  await A.waitFor(`document.documentElement.dataset.accent === 'orange'`, 5_000);
  assert.deepEqual([disk('density'), disk('theme'), disk('accent')], ['compact', 'light', 'orange']);
  assert.equal(await A.ev(`T.control('language').value`), 'fr');
  // Tout réinitialiser (Général) : tout revient, y compris l'apparence.
  await A.ev(`T.button('Tout réinitialiser', T.settings())`);
  await A.waitFor(`!!T.dialog()`, 5_000);
  await A.ev(`T.button('Tout réinitialiser', T.dialog())`);
  await A.waitFor(`document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.accent === 'red' && document.documentElement.dataset.density === 'normal'`, 5_000);
  assert.equal(disk('autoUpdate'), true, 'les mises à jour aussi (désactivées par les tests)');
  await A.ev(`window.__TAURI__.core.invoke('save_settings', { changes: { autoUpdate: false } }).then((s) => (S.settings = s, true))`);
  await close();
});

test('export et import en JSON : sans aucun secret, changements montrés avant de confirmer', async () => {
  await A.ev(`window.__TAURI__.core.invoke('save_settings', { changes: { topK: 33, allowedCommands: ['dotnet build'] } }).then((s) => (S.settings = s, true))`);
  const p = await A.ev(`window.__TAURI__.core.invoke('save_provider', { id: null, name: 'Privé', url: 'http://10.9.8.7:11434/v1', key: 'sk-secret-export' })`);
  await A.ev(`window.__TAURI__.core.invoke('server_status')`);
  const text = await A.ev(`window.__TAURI__.core.invoke('settings_export_json')`);
  const out = JSON.parse(text);
  assert.equal(out.nelcode, 'settings');
  assert.equal(out.settings.topK, 33);
  assert.deepEqual(out.settings.allowedCommands, ['dotnet build']);
  for (const bad of ['sk-secret-export', '10.9.8.7', 'Privé', 'providers', 'serverKey', 'nc-', 'recentProjects', 'lastModel', 'onboarded']) assert.ok(!text.includes(bad), `${bad} exporté`);
  // Import : les changements, ceux qui touchent à la sécurité marqués, puis la confirmation.
  out.settings.topK = 44;
  out.settings.allowedCommands = ['node'];
  out.settings.serverKey = 'pirate';
  // Prix à zéro et confirmation du budget coupée : montrés en clair et marqués (le budget ne servirait plus à rien).
  out.settings.prices = [{ model: 'gpt-gratuit', input: 0, output: 0 }];
  out.settings.budgetConfirm = false;
  const parsed = await A.ev(`window.__TAURI__.core.invoke('parse_settings_import', { text: ${JSON.stringify(JSON.stringify(out))} })`);
  assert.deepEqual(parsed.ignored, ['serverKey']);
  await A.ev(`SETTINGS.applyImport(${JSON.stringify(parsed)}); true`);
  await A.waitFor(`T.dialog()?.getAttribute('aria-label') === 'Importer des réglages'`, 5_000);
  const t = await A.ev(`T.dialog().innerText`);
  assert.match(t, /4 réglages changent/);
  assert.match(t, /Prix par million de tokens : par défaut → gpt-gratuit : entrée 0 \$, sortie 0 \$/);
  assert.match(t, /Confirmer au-delà du budget : activé → désactivé/);
  assert.ok(!t.includes('[object Object]'), t);
  assert.equal(await A.ev(`[...T.dialog().querySelectorAll('.import-diff li.sensitive')].length`), 3, 'commandes, prix, budget marqués');
  assert.match(t, /Commandes autorisées sans confirmation : dotnet build → node/);
  assert.match(t, /Top-k : 33 → 44/);
  assert.match(t, /touchent à la sécurité/);
  assert.match(t, /Ignorés .*serverKey/);
  assert.equal(await A.ev(`T.dialog().querySelector('.import-diff li').classList.contains('sensitive')`), true, 'sécurité en premier');
  await A.ev(`T.button('Annuler', T.dialog())`);
  await sleep(300);
  assert.equal(disk('topK'), 33, 'Annuler : rien ne change');
  await A.ev(`SETTINGS.applyImport(${JSON.stringify(parsed)}); true`);
  await A.waitFor(`!!T.dialog()`, 5_000);
  await A.ev(`T.button('Importer', T.dialog())`);
  await A.waitFor(`S.settings.topK === 44`, 5_000);
  assert.deepEqual(disk('allowedCommands'), ['node']);
  assert.equal(disk('serverKey'), undefined);
  assert.equal(A.readJson('settings.json').providers.length, 1, 'les fournisseurs ne sont pas touchés');
  // Les boutons sont dans Avancé.
  await open('advanced', 'export');
  assert.ok(await A.ev(`!!T.row('export') && [...T.row('export').querySelectorAll('button')].map((b) => b.textContent).join() === 'Exporter…,Importer…'`));
  await close();
  await A.ev(`window.__TAURI__.core.invoke('delete_provider', { id: ${JSON.stringify(p.id)} })`);
  await A.ev(`window.__TAURI__.core.invoke('save_settings', { changes: { topK: 20, allowedCommands: [], prices: null, budgetConfirm: true } }).then((s) => (S.settings = s, true))`);
});

test('modèle par défaut : proposé dans Modèles, chargé au démarrage', async () => {
  await open('models', 'defaultModel');
  assert.deepEqual(await A.ev(`[...T.control('defaultModel').options].map((o) => o.value)`), ['']);
  assert.match(await A.ev(`T.control('defaultModel').options[0].textContent`), /Le dernier utilisé/);
  await close();
  // Le réglage sert au démarrage (main.js) : un modèle qui n'existe pas est ignoré, sans erreur.
  const B = await launch({ settings: { defaultModel: 'disparu', lastModel: 'disparu-aussi' } });
  try {
    await sleep(1500);
    assert.equal(await B.ev(`S.model.name`), null);
    assert.equal(await B.ev(`T.toasts()`), '');
  } finally { await B.close(); }
});
