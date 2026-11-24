// Le rendu Markdown des réponses. D'abord des tests unitaires de ui/js/markdown.js, avec un petit faux DOM qui refuse
// innerHTML et tout élément hors de la liste ; puis l'application, avec un faux serveur (réponse en morceaux, agent,
// liens, images, réglage, Copier).

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { launch, sleep, ROOT } from './harness.mjs';

const F3 = '`'.repeat(3);

// --- Faux DOM ----------------------------------------------------------------------------------------------

const ALLOWED = new Set('p h1 h2 h3 h4 h5 h6 ul ol li blockquote hr br a em strong s code pre div span button table thead tbody tr th td input svg'.split(' '));
const ATTRS = new Set(['class', 'role', 'tabindex', 'title', 'type', 'disabled', 'checked', 'aria-label', 'start', 'data-lang']);

class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) { super(); this.textContent = t; }
  get html() { return this.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    assert.ok(ALLOWED.has(tag), `élément interdit : ${tag}`);
    Object.assign(this, { tag, attrs: {}, kids: [], on: {} });
    this.classList = { add: (c) => { if (!this.className.split(' ').includes(c)) this.className = `${this.className} ${c}`.trim(); }, remove: (c) => { this.className = this.className.split(' ').filter((x) => x !== c).join(' '); } };
  }
  get className() { return this.attrs.class ?? ''; }
  set className(v) { this.attrs.class = v; }
  setAttribute(k, v) { assert.ok(ATTRS.has(k), `attribut interdit : ${k}`); assert.equal(typeof v, 'string'); this.attrs[k] = v; }
  addEventListener(k, f) { assert.equal(typeof f, 'function'); this.on[k] = f; }
  append(...list) {
    for (const x of list) {
      const n = x instanceof FakeNode ? x : new FakeText(String(x));
      n.parentNode = this;
      this.kids.push(n);
    }
  }
  remove() { this.parentNode.kids.splice(this.parentNode.kids.indexOf(this), 1); this.parentNode = null; }
  replaceWith(n) { this.parentNode.kids[this.parentNode.kids.indexOf(this)] = n; n.parentNode = this.parentNode; this.parentNode = null; }
  replaceChildren(...list) { for (const k of this.kids) k.parentNode = null; this.kids = []; this.append(...list); }
  get childNodes() { return this.kids; }
  get textContent() { return this.kids.map((k) => k.textContent).join(''); }
  set textContent(t) { this.replaceChildren(t); }
  set innerHTML(_) { throw new Error('innerHTML interdit'); }
  set outerHTML(_) { throw new Error('outerHTML interdit'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML interdit'); }
  all(tag) { return this.kids.flatMap((k) => (k instanceof FakeElement ? [...(k.tag === tag ? [k] : []), ...k.all(tag)] : [])); }
  querySelector(tag) { return this.all(tag)[0] ?? null; }
  get html() {
    const attrs = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
    return `<${this.tag}${attrs}>${this.kids.map((k) => k.html).join('')}</${this.tag}>`;
  }
}

let M, STATE;
const el = (tag = 'div') => new FakeElement(tag);
/** Le Markdown rendu, en texte HTML (pour comparer). */
const html = (text, live = false) => { const box = el(); M.drawMarkdown(box, text, live); return box.kids.map((k) => k.html).join(''); };
const draw = (text, live = false) => { const box = el(); M.drawMarkdown(box, text, live); return box; };

describe('rendu (unitaire)', () => {
  before(async () => {
    // Le Rust n'est appelé que pour les textes de l'interface (i18n_catalog, set_language), jamais pendant le rendu.
    const catalog = (lang) => fs.readFileSync(path.join(ROOT, 'nel-desktop', 'ui', 'i18n', `${lang}.json`), 'utf8');
    let rendering = false;
    const invoke = async (cmd, args) => {
      assert.ok(!rendering, 'rien ne doit appeler le Rust pendant le rendu');
      if (cmd === 'i18n_catalog') return catalog(args.lang);
      if (cmd === 'set_language') return null;
      assert.fail(`appel inattendu : ${cmd}`);
    };
    Object.assign(globalThis, {
      Node: FakeNode, icon: () => el('svg'), document: { createElement: (t) => el(t), documentElement: {} },
      window: { __TAURI__: { core: { invoke }, event: { listen() {} } } },
    });
    const ui = (f) => import(pathToFileURL(path.join(ROOT, 'nel-desktop', 'ui', 'js', f)).href);
    await (await ui('i18n.js')).loadLang('fr');
    rendering = true;
    M = await ui('markdown.js');
    STATE = (await ui('state.js')).S;
  });

  test('titres, gras, italique, barré, code en ligne, citations, séparateurs, retours à la ligne', () => {
    assert.equal(html('# Un\n\n### Trois\n\nDeux\n---'), '<h1>Un</h1><h3>Trois</h3><h2>Deux</h2>');
    assert.equal(html('**gras** *ital* __g__ _i_ ~~non~~ `a < b`'), '<p><strong>gras</strong> <em>ital</em> <strong>g</strong> <em>i</em> <s>non</s> <code class="md-code">a &lt; b</code></p>');
    assert.equal(html('***x*** \\*pas\\* snake_case_ici 2 * 3 * 4'), '<p><em><strong>x</strong></em> *pas* snake_case_ici 2 * 3 * 4</p>');
    assert.equal(html('> a\n> > b\n\n---\n\nfin'), '<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote><hr></hr><p>fin</p>');
    assert.equal(html('un\ndeux'), '<p>un<br></br>deux</p>', 'les retours à la ligne du modèle sont gardés');
    assert.equal(html('&amp; &lt;b&gt; &copy; é'), '<p>&amp; &lt;b> © é</p>');
  });

  test('listes : à puces, numérotées (départ), imbriquées, serrées ou non, tâches', () => {
    assert.equal(html('- a\n- b\n  - c'), '<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>');
    assert.equal(html('3. a\n4. b'), '<ol start="3"><li>a</li><li>b</li></ol>');
    assert.equal(html('- a\n\n- b'), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
    const t = draw('- [ ] à **faire**\n- [x] fait\n- [X] aussi\n- [y] non\n- texte [ ] non').all('li');
    assert.deepEqual(t.map((li) => [li.className, li.textContent, li.querySelector('input')?.attrs.checked]), [
      ['task', 'à faire', undefined], ['task', 'fait', ''], ['task', 'aussi', ''], ['', '[y] non', undefined], ['', 'texte [ ] non', undefined]]);
    assert.ok(t.slice(0, 3).every((li) => li.querySelector('input').attrs.disabled === '' && li.querySelector('input').attrs.type === 'checkbox'));
    assert.equal(draw('[ ] hors d\'une liste').all('input').length, 0);
  });

  test('tableaux GFM : alignement, mise en forme, cellules qui manquent, barre échappée', () => {
    assert.equal(html('| a | b | c |\n|:--|:-:|--:|\n| **1** | x \\| y |'),
      '<div class="table-wrap"><table><thead><tr><th class="al-left">a</th><th class="al-center">b</th><th class="al-right">c</th></tr></thead>'
      + '<tbody><tr><td class="al-left"><strong>1</strong></td><td class="al-center">x | y</td><td class="al-right"></td></tr></tbody></table></div>');
    assert.equal(html('a | b'), '<p>a | b</p>', 'pas un tableau');
  });

  test('blocs de code : coloration, langage, Copier ; HTML dedans intact', () => {
    const box = draw(`Voici :\n${F3}rust\nfn main() {}\n${F3}\n\n    indenté\n\n~~~html\n<script>x</script>\n~~~`);
    const codes = box.all('code');
    assert.deepEqual(codes.map((c) => c.textContent), ['fn main() {}', 'indenté', '<script>x</script>']);
    assert.deepEqual(box.kids.slice(1).map((b) => b.attrs['data-lang']), ['rust', '', 'html']);
    assert.ok(codes[0].all('span').some((s) => s.className === 'hl-kw' && s.textContent === 'fn'));
    assert.equal(box.all('button').length, 3);
    assert.equal(draw(`- a\n  ${F3}js\n  let x\n  ${F3}`).all('li')[0].all('code')[0].textContent, 'let x', 'dans une liste');
  });

  test('liens : http et https seulement, sans href ; les autres montrent leur adresse', () => {
    const a = (text) => draw(text).all('a');
    const [l] = a('[site](https://exemple.ch/a?b=1 "titre")');
    assert.deepEqual([l.textContent, l.attrs.title, l.attrs.role, l.attrs.tabindex, l.attrs.href], ['site', 'https://exemple.ch/a?b=1', 'link', '0', undefined]);
    assert.ok(l.on.click && l.on.keydown);
    assert.deepEqual(a('<http://a.ch> et https://b.ch/x. et [r][1]\n\n[1]: http://c.ch').map((x) => x.attrs.title), ['http://a.ch/', 'https://b.ch/x', 'http://c.ch/']);
    assert.deepEqual(a('[](https://a.ch)').map((x) => x.textContent), ['https://a.ch/'], 'un lien sans texte montre son adresse');
    assert.deepEqual(a('main.rs www.a.ch a@b.ch //commentaire [fichier](src/main.rs) [m](mailto:a@b.ch) [f](ftp://a.ch) <a@b.ch> [h](#titre)'), []);
    assert.equal(draw('[fichier](src/main.rs) [src/a.rs](src/a.rs) <a@b.ch>').textContent, 'fichier (src/main.rs) src/a.rs a@b.ch');
    // Un nom d'hôte trompeur : l'adresse montrée est celle qui s'ouvrirait.
    assert.equal(a('[apple](https://\u0430pple.com)')[0].attrs.title, 'https://xn--pple-43d.com/');
    assert.deepEqual(a('[banque](https://banque.ch@pirate.ch/)'), [], 'identifiants dans l\'adresse');
    assert.equal(M.webUrl('https://x/' + 'a'.repeat(5000)), null);
  });

  test('images : jamais chargées, leur lien à la place', () => {
    const box = draw('![Un chat](https://exemple.ch/chat.png) ![](http://t.ch/pixel.gif) ![dans le texte](data:image/png;base64,iVBORw0KGgo=) [![badge](https://b.ch/b.svg)](https://c.ch)');
    assert.deepEqual(box.all('a').map((x) => [x.textContent, x.attrs.title]), [['Un chat', 'https://exemple.ch/chat.png'], ['http://t.ch/pixel.gif', 'http://t.ch/pixel.gif'], ['badge', 'https://c.ch/']]);
    assert.match(box.textContent, /dans le texte \(image intégrée, non affichée\)/);
    assert.ok(!box.html.includes('iVBOR'));
  });

  test('réponses piégées : HTML brut affiché comme du texte, adresses dangereuses jamais cliquables', () => {
    for (const trap of [
      '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<svg/onload=alert(1)>', '<iframe src="https://a.b"></iframe>', '<style>*{display:none}</style>',
      '<div onclick="alert(1)">x</div>', '<!-- x -->', '<?php x ?>', '<![CDATA[x]]>', '<input autofocus onfocus=alert(1)>', '<math><mtext></mtext></math>', 'a <b onmouseover=alert(1)>b</b> c', '<details open ontoggle=alert(1)>',
    ]) {
      for (const text of [trap, `- ${trap}`, `> ${trap}`, `| a |\n|---|\n| ${trap} |`, `# ${trap}`, `**${trap}**`]) {
        const box = draw(text);
        assert.ok(box.textContent.includes(trap), `${text} → ${box.textContent}`);
        for (const tag of ['img', 'script', 'iframe', 'style', 'svg', 'details']) assert.equal(box.all(tag).length, 0, text);
        assert.ok(box.all('a').every((l) => /^https?:/.test(l.attrs.title)), text);
      }
    }
    for (const trap of [
      '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](java&#10;script:alert(1))', '[x](&#x6A;avascript:alert(1))', '[x](<javascript:alert(1)>)', '[x]( javascript:alert(1))', '<javascript:alert(1)>',
      '[x](data:text/html;base64,PHNjcmlwdD4=)', '[x](vbscript:msgbox)', '[x](file:///C:/Windows/System32/calc.exe)', '[x](\\\\serveur\\partage)', '[x][r]\n\n[r]: javascript:alert(1)', '![x](javascript:alert(1))',
      '[x](ms-settings:display)', '[x](//pirate.ch)', '[x](http:pirate.ch)', '[x](https:/pirate.ch)', '![x](data:image/svg+xml;base64,PHN2Zz4=)', '![x](data:text/html,<script>)', '[x](blob:https://a.ch/1)',
    ]) {
      const box = draw(trap);
      assert.equal(box.all('a').length, 0, `${trap} → ${box.html}`);
      assert.ok(!/ (href|src|on\w+)="/.test(box.html), trap);
    }
    // Des attributs ne peuvent pas sortir de leur valeur : l'adresse n'est qu'un titre et un texte.
    const [l] = draw('[x](https://a.ch/"onmouseover="alert(1) "t\\" onclick=\\"x")').all('a').concat(draw('[y](https://a.ch/%22onclick=alert)').all('a'));
    assert.ok(!l || Object.keys(l.attrs).every((k) => ATTRS.has(k)));
    // Le nom du langage d'un bloc de code aussi.
    assert.equal(draw(`${F3}"><script>alert(1)</script>\nx\n${F3}`).all('code')[0].textContent, 'x');
    // Prototype : des noms de références piégés.
    assert.equal(draw('[__proto__] [constructor] [toString][]').all('a').length, 0);
  });

  test('textes pathologiques : rendus en un temps raisonnable', () => {
    const t = Date.now();
    for (const text of ['*'.repeat(20_000) + 'a', '['.repeat(20_000), '>'.repeat(2000) + 'a', 'http://'.repeat(5000), '<'.repeat(20_000), '![['.repeat(5000), '- '.repeat(1000) + 'a', '|a'.repeat(1000) + '\n' + '|-'.repeat(1000)]) { draw(text); draw(text, true); }
    assert.ok(Date.now() - t < 10_000, `${Date.now() - t} ms`);
  });

  test('pendant la réponse : une longue ligne d\'espaces ne fige pas l\'interface (pas de temps cubique)', () => {
    const t = Date.now();
    const spaces = ' '.repeat(50_000);
    for (const text of [spaces + 'a', '> ' + spaces + '- a', '**a' + spaces + 'b', 'x\n' + spaces + '*']) { draw(text, true); M.closeOpen(text); }
    const box = el();
    box.append(...M.inlineMarkdown('**a' + spaces + 'b'));
    assert.ok(Date.now() - t < 2_000, `${Date.now() - t} ms`);
    // Le sens ne change pas : des signes seuls attendent, un gras pas refermé est refermé.
    assert.equal(M.closeOpen('a\n  > - [ ]  '), 'a');
    assert.equal(M.closeOpen('a\n---  '), 'a');
    assert.equal(M.closeOpen('**gras pas fini  '), '**gras pas fini**');
    assert.equal(M.closeOpen('a **b *'), 'a **b**');
  });

  test('pendant la réponse : code, tableau, gras, lien pas terminés affichés proprement', () => {
    // Bloc de code pas fermé, puis fermeture en morceaux : toujours un bloc de code, sans les accents graves.
    for (const end of ['', '\n', '\n`', '\n``', `\n${F3}`]) {
      const box = draw(`Voici\n\n${F3}js\nlet a = 1;${end}`, true);
      assert.deepEqual([box.kids.length, box.all('code')[0].textContent.trim()], [2, 'let a = 1;'], JSON.stringify(end));
    }
    assert.equal(draw(`${F3}md\n| a | b`, true).all('table').length, 0, 'rien n\'est complété dans un bloc de code');
    assert.equal(draw(`${F3}py\nx = **kw`, true).textContent.includes('x = **kw**'), false);
    // Un tableau en morceaux : une seule table, à chaque caractère, dès l'en-tête.
    const table = 'Avant\n\n| Nom | Prix |\n|:----|-----:|\n| Thé | **3** |\n| Café | 4 |\n\nAprès';
    for (let n = table.indexOf('| Nom') + 4; n <= table.length; n++) {
      const box = draw(table.slice(0, n), true);
      assert.equal(box.all('table').length, 1, JSON.stringify(table.slice(0, n)));
      assert.ok(!/\||---|\*/.test(box.textContent), `${JSON.stringify(table.slice(0, n))} → ${box.textContent}`);
    }
    // Gras, code et lien : mis en forme avant d'être refermés ; jamais les signes.
    assert.equal(html('du **gra', true), '<p>du <strong>gra</strong></p>');
    assert.equal(html('du **gras*', true), '<p>du <strong>gras</strong></p>');
    assert.equal(html('du **', true), '<p>du</p>');
    assert.equal(html('de l\'*ital', true), '<p>de l\'<em>ital</em></p>');
    assert.equal(html('* un\n* deux *tr', true), '<ul><li>un</li><li>deux <em>tr</em></li></ul>');
    assert.equal(html('du `co', true), '<p>du <code class="md-code">co</code></p>');
    assert.equal(html('voir [le site](https://exe', true), '<p>voir le site</p>');
    assert.equal(html('2**3 et a * b', true), '<p>2**3 et a * b</p>');
    // Une liste qui commence n'est pas un titre souligné.
    for (const t of ['Voici :\n', 'Voici :\n-', 'Voici :\n- ', 'Voici :\n- [', 'Voici :\n- [ ]', 'Voici :\n=', 'Voici :\n1.']) assert.equal(html(t, true), '<p>Voici :</p>', JSON.stringify(t));
    // La fin de la réponse (pas `live`) montre exactement le texte.
    assert.equal(html('du **gra'), '<p>du **gra</p>');
  });

  test('pendant la réponse : les blocs finis ne sont pas redessinés, le bloc de code garde son élément', () => {
    const box = el();
    const full = `# Titre\n\nUn **paragraphe**.\n\n- a\n- b\n\n${F3}js\nlet a = 1;\nlet b = 2;\n${F3}\n\n| a |\n|---|\n| 1 |\n\nFin [r].\n`;
    let first, code, changes = 0;
    for (let n = 1; n <= full.length; n++) {
      M.drawMarkdown(box, full.slice(0, n), true);
      if (box.kids.length > 1) { if (first && first !== box.kids[0]) changes++; first = box.kids[0]; }
      const c = box.kids.find((k) => k.className === 'code-block' && k.attrs['data-lang'] === 'js');
      if (c) { if (code && code !== c) changes++; code = c; }
    }
    assert.equal(changes, 0);
    M.drawMarkdown(box, full, true);
    assert.equal(box.kids.map((k) => k.html).join(''), html(full), 'le même résultat qu\'un rendu en une fois');
    // Une définition de lien arrivée à la fin : les blocs d'avant la prennent en compte.
    M.drawMarkdown(box, full + '\n[r]: https://r.ch\n', true);
    assert.deepEqual(box.all('a').map((a) => a.attrs.title), ['https://r.ch/']);
    // Le contenu remplacé d'ailleurs (« travaille… ») : tout est redessiné, sans reste.
    box.replaceChildren('travaille…');
    M.drawMarkdown(box, 'Suite', true);
    assert.equal(box.textContent, 'Suite');
    // Un texte plus court : les blocs en trop partent.
    M.drawMarkdown(box, 'a\n\nb\n\nc', true);
    M.drawMarkdown(box, 'a', true);
    assert.equal(box.textContent, 'a');
  });

  test('réglage désactivé : le texte brut ; titre d\'une étape : mise en forme dans la ligne, sans lien', () => {
    const title = (t) => { const b = el(); b.append(...M.inlineMarkdown(t)); return b; };
    assert.equal(title('## **Je regarde** `a.rs` et [x](https://a.ch) <b>').kids.map((k) => k.html).join(''), '<strong>Je regarde</strong> <code class="md-code">a.rs</code> et <span>x</span> &lt;b>');
    assert.equal(title('- Je lis **Program…').textContent, 'Je lis Program…', 'un titre coupé');
    assert.equal(title('![i](https://a.ch/i.png) x').all('a').length, 0);
    STATE.settings.markdown = false;
    try {
      const box = el();
      M.drawMarkdown(box, '# a\n\n**b** <script>', true);
      assert.deepEqual([box.textContent, box.kids.length, box.className], ['# a\n\n**b** <script>', 1, '']);
      assert.equal(title('**a**').textContent, '**a**');
    } finally { delete STATE.settings.markdown; }
  });

  test('au plus un rendu toutes les 100 ms', async () => {
    const box = el(), out = { text: '' };
    let draws = 0;
    const t = performance.now();
    while (performance.now() - t < 650) { out.text += 'mot '; M.scheduleLive(out, () => (draws++, box), () => {}); await sleep(5); }
    await sleep(150);
    assert.ok(draws >= 4 && draws <= 8, `${draws} rendus en 650 ms`);
    assert.equal(box.textContent, out.text.trim(), 'le dernier morceau est affiché');
  });
});

// --- L'application -----------------------------------------------------------------------------------------

describe('application', () => {
  let A, server, DIR, OPENED, PROVIDER;
  const ANSWER = `## Résultat\n\nDu **gras**, du \`code\` et ~~non~~.\n\n| Nom | Prix |\n|:----|-----:|\n| Thé | 3 |\n| Café | 4 |\n\n- [x] lire\n- [ ] écrire\n  1. puis\n\n${F3}rust\nfn main() {}\n${F3}\n\n> Cité\n\nVoir [le site](https://exemple.ch/page?a=1) et ![Un chat](https://exemple.ch/chat.png).`;
  const TRAP = '<script>window.__pirate = 1</script>\n\n<img src=x onerror="window.__pirate = 2">\n\n[clic](javascript:window.__pirate=3) [data](data:text/html,<script>window.__pirate=4</script>)\n\n![p](http://127.0.0.1:PORT/pixel.gif)';
  const MODELS = { reponse: ANSWER, piege: TRAP, lent: ANSWER, agent: '', coupe: 'x' };
  const hits = [];

  const chunk = (res, delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  async function chat(res, body) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const explorer = body.messages[0].content?.startsWith?.('Tu es un explorateur');
    const n = body.messages.filter((m) => m.role === 'tool').length;
    const call = (name, args) => { chunk(res, { tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); chunk(res, {}, 'tool_calls'); return res.end('data: [DONE]\n\n'); };
    let text = MODELS[body.model].replace('PORT', server.address().port), size = 7, delay = 5;
    if (explorer) text = '### Trouvé\n\n- `a.txt`\n- **rien d\'autre**';
    else if (body.model === 'agent' && n === 0) { chunk(res, { content: '**Je délègue** à un `explorateur`.\n\n1. un\n2. deux' }); return call('spawn_explorer', { task: 'Explore' }); }
    else if (body.model === 'agent') text = 'Fini, en *bref*.';
    if (body.model === 'lent') { size = 3; delay = 12; }
    for (let i = 0; i < text.length && !res.destroyed; i += size) { chunk(res, { content: text.slice(i, i + size) }); await sleep(delay); }
    chunk(res, {}, 'stop');
    res.end('data: [DONE]\n\n');
  }

  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url);
      let data = '';
      req.on('data', (d) => (data += d));
      req.on('end', () => {
        if (!req.url.startsWith('/v1/')) { res.writeHead(404); return res.end(); }
        if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: Object.keys(MODELS).map((id) => ({ id })) })); }
        chat(res, JSON.parse(data));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nelcode-md-'));
    OPENED = path.join(DIR, 'liens-ouverts.txt');
    fs.mkdirSync(path.join(DIR, 'projet'));
    fs.writeFileSync(path.join(DIR, 'projet', 'a.txt'), 'a\n');
    A = await launch({ env: { NELCODE_OPEN_LOG: OPENED } });
    const p = await A.ev(`window.__TAURI__.core.invoke('save_provider', { id: null, name: 'Faux', url: 'http://127.0.0.1:${server.address().port}/v1', key: null })`);
    PROVIDER = p.id;
    await A.ev(`window.__TAURI__.core.invoke('test_provider', { id: ${JSON.stringify(PROVIDER)} }).then(() => refreshProviders())`);
    await A.waitFor(`document.querySelectorAll('#models li.remote').length === ${Object.keys(MODELS).length}`, 10_000, 'modèles du faux serveur');
    // Tout ce que la page essaierait de charger elle-même.
    await A.ev(`window.__bloque = []; document.addEventListener('securitypolicyviolation', (e) => window.__bloque.push(e.blockedURI)); true`);
  });

  after(async () => {
    if (PROVIDER) await A.ev(`window.__TAURI__.core.invoke('delete_provider', { id: ${JSON.stringify(PROVIDER)} })`).catch(() => {});
    await A?.close();
    server?.close();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  const pick = async (model) => {
    await A.ev(`(() => { startNew(); [...document.querySelectorAll('#models li.remote')].find((li) => li.dataset.model === '${model}').click(); return true; })()`);
    await A.waitFor(`S.model.remote?.model === '${model}'`, 5_000, model);
  };
  const body = `[...document.querySelectorAll('#messages .msg.assistant')].pop().querySelector(':scope > .body')`;
  const texts = (sel) => A.ev(`[...${body}.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent)`);
  const opened = () => (fs.existsSync(OPENED) ? fs.readFileSync(OPENED, 'utf8').trim().split('\n') : []);
  const checkAnswer = async () => {
    assert.deepEqual(await texts('h2'), ['Résultat']);
    assert.deepEqual(await texts('strong'), ['gras']);
    assert.deepEqual(await texts('s'), ['non']);
    assert.deepEqual(await texts('.md-code'), ['code']);
    assert.deepEqual(await A.ev(`[...${body}.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.textContent))`), [['Nom', 'Prix'], ['Thé', '3'], ['Café', '4']]);
    assert.equal(await A.ev(`getComputedStyle(${body}.querySelectorAll('td')[1]).textAlign`), 'right');
    assert.deepEqual(await A.ev(`[...${body}.querySelectorAll('li.task > input')].map((i) => [i.checked, i.disabled])`), [[true, true], [false, true]]);
    assert.deepEqual(await texts('ol > li'), ['puis']);
    assert.deepEqual(await texts('.code-block code'), ['fn main() {}']);
    assert.deepEqual(await texts('.code-block .copy'), ['Copier']);
    assert.deepEqual(await texts('blockquote'), ['Cité']);
    assert.deepEqual(await texts('.md-link'), ['le site', 'Un chat']);
    assert.equal(await A.ev(`${body}.querySelectorAll('img, [href], [src], [style]').length`), 0);
  };

  test('tableau, liste, gras, code, citation : la réponse du faux serveur, en morceaux', async () => {
    await pick('reponse');
    await A.ask('Montre');
    await checkAnswer();
    assert.equal(await A.ev(`S.current.messages.at(-1).content`), ANSWER, 'le texte gardé est le Markdown d\'origine');
    assert.deepEqual(await A.ev(`window.__bloque`), []);
  });

  test('Markdown en morceaux : rendu au plus toutes les 100 ms, sans refaire les blocs finis ; même résultat à la fin', async () => {
    await pick('lent');
    await A.ev(`(() => {
      window.__vu = { n: 0, titres: new Set(), textes: [], t: [] };
      new MutationObserver((list) => {
        const b = ${body};
        if (!S.gen || !b?.classList.contains('md')) return;
        __vu.t.push(performance.now());
        const t = b.querySelector('h2'); if (t && b.children.length > 1) __vu.titres.add(t);
        __vu.textes.push(b.innerText);
      }).observe(document.getElementById('messages'), { childList: true, subtree: true, characterData: true });
      return true;
    })()`);
    await A.ev(`T.submit('Montre en morceaux')`);
    // En cours : le tableau est déjà un tableau.
    await A.waitFor(`S.gen && ${body}.querySelector('table')`, 10_000, 'tableau en cours');
    await A.waitFor('!S.gen', 60_000, 'fin');
    await checkAnswer();
    const seen = await A.ev(`({ titres: __vu.titres.size, gaps: __vu.t.slice(1).map((x, i) => x - __vu.t[i]), textes: __vu.textes })`);
    assert.equal(seen.titres, 1, 'le titre n\'est dessiné qu\'une fois pendant la réponse');
    assert.ok(seen.gaps.length >= 5, 'rendu au fil de la réponse');
    assert.ok(seen.gaps.filter((g) => g < 85).length <= 1, `au plus un rendu toutes les 100 ms : ${seen.gaps.map(Math.round)}`);
    assert.ok(seen.textes.every((t) => !/\*\*|\|\s*Nom|---|```|~~/.test(t)), 'jamais de Markdown à moitié lu : ' + JSON.stringify(seen.textes.find((t) => /\*\*|\|\s*Nom|---|```|~~/.test(t))));
  });

  test('réponse piégée : rien ne s\'exécute, rien n\'est chargé', async () => {
    await pick('piege');
    await A.ask('Piège');
    const text = await A.ev(`${body}.textContent`);
    assert.ok(text.includes('<script>window.__pirate = 1</script>') && text.includes('<img src=x onerror="window.__pirate = 2">') && text.includes('[clic](javascript:'), text);
    assert.equal(await A.ev(`${body}.querySelectorAll('script, img, iframe, [href], [src], [onerror]').length`), 0);
    await A.ev(`(() => { for (const e of ${body}.querySelectorAll('*')) e.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
    await A.waitFor(`T.dialog()`, 5_000, 'seul le lien de l\'image demande');
    await A.ev(`T.button('Annuler', T.dialog())`);
    await sleep(300);
    assert.equal(await A.ev(`window.__pirate ?? null`), null);
    assert.ok(!hits.some((u) => u.includes('pixel')), 'image distante jamais demandée');
    assert.deepEqual(await A.ev(`window.__bloque`), []);
    assert.deepEqual(opened(), []);
  });

  test('liens : confirmation avec l\'adresse complète, puis le navigateur par la partie Rust ; la fenêtre ne bouge pas', async () => {
    await pick('reponse');
    await A.ask('Un lien');
    const here = await A.ev(`location.href`);
    const click = (k) => A.ev(`${body}.querySelectorAll('.md-link')[${k}].click(); true`);
    await click(0);
    await A.waitFor(`T.dialog()?.textContent.includes('Ouvrir ce lien ?')`, 5_000);
    assert.equal(await A.ev(`T.dialog().querySelector('.link-url').textContent`), 'https://exemple.ch/page?a=1');
    await A.ev(`T.button('Annuler', T.dialog())`);
    await sleep(200);
    assert.deepEqual(opened(), [], 'Annuler n\'ouvre rien');
    await click(0);
    await A.waitFor(`T.dialog()`, 5_000);
    await A.ev(`T.button('Ouvrir dans le navigateur', T.dialog())`);
    for (let i = 0; i < 50 && !opened().length; i++) await sleep(50);
    assert.deepEqual(opened(), ['https://exemple.ch/page?a=1']);
    // Au clavier, et l'image : son lien.
    await A.ev(`(() => { const l = ${body}.querySelectorAll('.md-link')[1]; l.focus(); T.key('Enter', {}, l); return true; })()`);
    await A.waitFor(`T.dialog()?.querySelector('.link-url')?.textContent === 'https://exemple.ch/chat.png'`, 5_000);
    await A.ev(`T.key('Escape', {}, document)`);
    // La partie Rust vérifie elle-même.
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'data:text/html,x', 'calc.exe', 'https://a@b.ch/'])
      assert.match(await A.ev(`window.__TAURI__.core.invoke('open_link', { url: ${JSON.stringify(url)} }).then(() => 'ouvert', (e) => I18N.tr(String(e)))`), /adresse refusée/, url);
    assert.equal(opened().length, 1);
    // Une navigation ou une nouvelle fenêtre demandée par la page est bloquée par la partie Rust.
    await A.ev(`location.href = 'http://127.0.0.1:${server.address().port}/ailleurs'; window.open('http://127.0.0.1:${server.address().port}/fenetre'); true`);
    await sleep(500);
    assert.equal(await A.ev(`location.href`), here);
    assert.equal(await A.ev(`typeof S === 'object' && !!${body}`), true, 'la page est toujours là');
    // (WebView2 peut avoir demandé la page « ailleurs » avant d'annuler la navigation ; elle n'est jamais affichée.)
    assert.ok(!hits.some((u) => u.includes('fenetre')), 'nouvelle fenêtre refusée');
  });

  test('Copier copie le Markdown d\'origine ; réglage désactivé : texte brut', async () => {
    const copy = async () => {
      await A.ev(`navigator.clipboard.writeText = async (t) => { window.__copied = t; }; window.__copied = null; T.button('Copier', [...document.querySelectorAll('#messages .msg.assistant')].pop().querySelector('.actions')); true`);
      assert.equal(await A.waitFor(`window.__copied`, 5_000), ANSWER);
    };
    await copy();
    const save = async (on) => {
      await A.ev(`openSettings('general', 'markdown')`);
      await A.waitFor(`T.control('markdown')`, 10_000, 'réglage');
      assert.equal(await A.ev(`T.control('markdown').checked`), !on);
      await A.ev(`T.control('markdown').click(); true`);
      await A.waitFor(`S.settings.markdown === ${on}`, 10_000);
      await A.ev(`T.key('Escape', {}, document)`);
    };
    await save(false);
    assert.equal(A.readJson('settings.json').markdown, false);
    await A.waitFor(`!${body}.classList.contains('md')`, 5_000);
    assert.equal(await A.ev(`${body}.textContent`), ANSWER);
    assert.equal(await A.ev(`${body}.children.length`), 0);
    assert.equal(await A.ev(`getComputedStyle(${body}).whiteSpace`), 'pre-wrap');
    await copy();
    await A.ask('Encore, en brut');
    assert.equal(await A.ev(`${body}.textContent`), ANSWER);
    await save(true);
    await A.waitFor(`${body}.querySelector('table')`, 5_000);
  });

  test('mode Agent : lignes ✱, détail et résumé d\'un explorateur en Markdown', async () => {
    await pick('agent');
    await A.ev(`S.current.workingDirectory = ${JSON.stringify(path.join(DIR, 'projet'))}; S.current.agent = true; renderHeader(); true`);
    await A.ask('Explore');
    const step = (kind) => `[...document.querySelectorAll('#messages .msg.assistant')].pop().querySelector('.step.${kind}')`;
    assert.deepEqual(await A.ev(`[...${step('note')}.querySelector('.title').childNodes].map((n) => [n.nodeName, n.textContent])`),
      [['STRONG', 'Je délègue'], ['#text', ' à un '], ['CODE', 'explorateur'], ['#text', '. 1. un 2. deux']]);
    assert.deepEqual(await A.ev(`[...${step('note')}.querySelectorAll('.detail.md ol > li')].map((l) => l.textContent)`), ['un', 'deux']);
    assert.equal(await A.ev(`${step('explorer')}.querySelector('.detail.md h3').textContent`), 'Trouvé');
    assert.deepEqual(await A.ev(`[...${step('explorer')}.querySelectorAll('.detail.md li')].map((l) => l.textContent)`), ['a.txt', 'rien d\'autre']);
    assert.deepEqual(await texts('em'), ['bref']);
    assert.ok((await A.ev(`S.current.messages.at(-1).agent.steps.find((s) => s.kind === 'note').detail`)).startsWith('**Je délègue**'), 'le texte gardé ne change pas');
  });

  test('Claude Agent et sous-agents : même rendu ; la sortie d\'un outil reste telle quelle', async () => {
    const steps = [
      { id: 's1', kind: 'note', tool: 'Task', title: 'Sous-agent : A', status: 'done', detail: '**rapport**' },
      { id: 's2', kind: 'note', title: 'Message du sous-agent', status: 'done', detail: '- un', parent: 's1' },
      { id: 's3', kind: 'note', tool: 'WebFetch', title: 'Lecture web : https://a.ch', status: 'done', detail: '# brut **x**' },
      { id: 's4', kind: 'read', title: 'Lecture de *a*', status: 'done', detail: '# brut' },
    ];
    await A.ev(`startNew(); S.current.claudeAgent = {}; S.current.messages.push({ role: 'user', content: '**moi**' }, { role: 'assistant', content: '**Fait**', agent: { request: 'r', steps: ${JSON.stringify(steps)} } }); renderMessages(); true`);
    assert.deepEqual(await texts('strong'), ['Fait']);
    const detail = (id) => A.ev(`(() => { const d = document.querySelector('#messages [data-step="${id}"] > .step-body > .detail'); return [d.nodeName, d.textContent, d.children.length]; })()`);
    assert.deepEqual([await detail('s1'), await detail('s2'), await detail('s3'), await detail('s4')], [['DIV', 'rapport', 1], ['DIV', 'un', 1], ['PRE', '# brut **x**', 0], ['PRE', '# brut', 0]]);
    assert.equal(await A.ev(`document.querySelector('#messages [data-step="s4"] .title').textContent`), 'Lecture de *a*');
    assert.equal(await A.ev(`document.querySelector('#messages .msg.user .body').textContent`), '**moi**', 'les messages de l\'utilisateur ne changent pas');
  });
});
