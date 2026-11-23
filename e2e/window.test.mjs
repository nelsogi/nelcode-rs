// Tests de la fenêtre : taille, position et état agrandi retenus (settings.json, clé windowState), et retour à 80 %
// de l'écran, centrée, quand la position enregistrée tombe hors des écrans actuels.
// Usage : cargo build -p nel-desktop ; node --test e2e/window.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { launch, sleep } from './harness.mjs';

/** Ce que la page voit de la fenêtre, en pixels physiques (zoom à 100 % : devicePixelRatio = échelle de l'écran). */
const geometry = (A) => A.ev(`(() => { const r = devicePixelRatio; return { x: Math.round(screenX * r), y: Math.round(screenY * r), width: Math.round(innerWidth * r), height: Math.round(innerHeight * r),
  outer: [outerWidth, outerHeight], avail: [screen.availWidth, screen.availHeight, screen.availLeft ?? 0, screen.availTop ?? 0], ratio: r }; })()`);

const maximized = (A) => A.ev(`window.__TAURI__.window.getCurrentWindow().isMaximized()`);
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what} : ${a} au lieu de ${b}`);

/** Attend que settings.json ait un windowState qui vérifie `ok`. */
async function savedState(A, ok, what) {
  const end = Date.now() + 10_000;
  for (;;) {
    let s;
    try { s = A.readJson('settings.json').windowState; } catch { /* en cours d'écriture */ }
    if (s && ok(s)) return s;
    if (Date.now() > end) throw new Error(`délai dépassé : ${what} (${JSON.stringify(s)})`);
    await sleep(100);
  }
}

test('premier lancement : 80 % centrée, puis taille et position enregistrées', async () => {
  const A = await launch();
  try {
    const g = await geometry(A);
    const s = await savedState(A, (s) => s.maximized === false, 'état enregistré');
    near(s.width, g.width, 2, 'largeur enregistrée');
    near(s.height, g.height, 2, 'hauteur enregistrée');
    assert.ok(g.outer[0] / g.avail[0] > 0.72 && g.outer[0] / g.avail[0] < 0.88, `largeur ${g.outer[0]} / ${g.avail[0]}`);
    assert.equal(A.readJson('settings.json').window, undefined, 'la clé « window » de Nel Code C# n\'est pas touchée');
  } finally { await A.close(); }
});

test('lancement suivant : taille et position retenues', async () => {
  const A = await launch({ settings: { windowState: { x: 70, y: 60, width: 900, height: 640, maximized: false } } });
  try {
    const g = await geometry(A);
    near(g.width, 900, 2, 'largeur');
    near(g.height, 640, 2, 'hauteur');
    // screenX/screenY : le coin de la zone de contenu (WebView2), juste à droite de la bordure et sous la barre de
    // titre de la fenêtre placée en (70, 60).
    assert.ok(g.x >= 70 && g.x <= 70 + 16, `position x : ${g.x}`);
    assert.ok(g.y >= 60 && g.y <= 60 + 64, `position y : ${g.y}`);
    assert.equal(await maximized(A), false);
    // L'état enregistré reste le même (la restauration ne le déforme pas).
    await sleep(1200);
    const s = A.readJson('settings.json').windowState;
    near(s.width, 900, 2, 'largeur enregistrée');
    near(s.x, 70, 2, 'x enregistré');
    assert.equal(s.maximized, false);
  } finally { await A.close(); }
});

test('état agrandi retenu, avec la taille normale pour plus tard', async () => {
  const A = await launch({ settings: { windowState: { x: 70, y: 60, width: 900, height: 640, maximized: true } } });
  try {
    await A.waitFor(`window.__TAURI__.window.getCurrentWindow().isMaximized()`, 5_000, 'fenêtre agrandie');
    // Toute la largeur de l'écran (outerWidth/outerHeight : la zone de contenu, sans la barre de titre).
    assert.ok(await A.ev(`outerWidth >= screen.availWidth - 2`));
    const s = await savedState(A, (s) => s.maximized === true, 'agrandie enregistrée');
    // La taille et la position normales ne sont pas remplacées par celles de l'écran entier.
    assert.deepEqual([s.x, s.y, s.width, s.height], [70, 60, 900, 640]);
  } finally { await A.close(); }
});

test('position hors des écrans (écran débranché) : 80 % centrée, état remplacé', async () => {
  for (const off of [{ x: -40000, y: 100 }, { x: 100, y: 30000 }, { x: 100, y: -3000 }]) {
    const A = await launch({ settings: { windowState: { ...off, width: 900, height: 640, maximized: true } } });
    try {
      const g = await geometry(A);
      assert.equal(await maximized(A), false, 'pas agrandie');
      const r = g.outer[0] / g.avail[0];
      assert.ok(r > 0.72 && r < 0.88, `80 % de l'écran (${(r * 100).toFixed(0)} %)`);
      // Centrée sur l'écran principal.
      const left = g.x / g.ratio - g.avail[2], right = g.avail[0] - g.outer[0] - left;
      assert.ok(Math.abs(left - right) < 40, `centrée (${left} / ${right})`);
      const s = await savedState(A, (s) => s.x !== off.x || s.y !== off.y, 'nouvel état enregistré');
      assert.equal(s.maximized, false);
      const logs = fs.readdirSync(path.join(A.home, 'logs')).map((f) => fs.readFileSync(path.join(A.home, 'logs', f), 'utf8')).join('');
      assert.match(logs, /saved position outside the current screens/);
    } finally { await A.close(); }
  }
});
