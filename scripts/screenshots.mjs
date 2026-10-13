// Usage: npm run build && node scripts/screenshots.mjs  (renders docs/features/*.png with headless Chrome; CHROME env overrides the binary)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outDir = join(root, 'docs', 'features');
const html = readFileSync(join(root, 'dist', 'ui.html'), 'utf8');

function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: f(5), g: f(3), b: f(1) };
}

const palette = [
  ['Coin_Icon', 10, 0.85, 0.95, ['fill', 'drop-shadow']],
  ['Rim', 20, 0.8, 1, ['fill']],
  ['Highlight', 32, 0.7, 1, ['fill']],
  ['Edge', 5, 0.9, 0.75, ['stroke']],
  ['Outline', 350, 0.8, 0.45, ['stroke', 'inner-shadow']],
  ['Glint', 40, 0.5, 1, ['gradient']],
  ['Shadow', 0, 0, 0.5, ['drop-shadow']],
];

const colors = palette.map(([name, h, s, v, uses], i) => ({
  id: `c${i}-${name.toLowerCase()}`,
  source: hsvToRgb(h, s, v),
  hsv: { h, s, v },
  neutral: s === 0,
  names: [name],
  uses,
  targets: [],
}));

const skipped = { styleBound: 0, variableBound: 0, unsupportedPaints: 0, hiddenOrLocked: 0, text: 0, other: 0 };
const session = { pluginMessage: { type: 'session', session: { sessionId: 'shots', nodeCount: 5, colors, skipped } } };

const dark = {
  '--figma-color-bg': '#2c2c2c',
  '--figma-color-bg-secondary': '#383838',
  '--figma-color-text': '#ffffff',
  '--figma-color-text-secondary': '#b3b3b3',
  '--figma-color-border': '#444444',
  '--figma-color-bg-brand': '#0d99ff',
  '--figma-color-text-onbrand': '#ffffff',
  '--figma-color-text-warning': '#f3b545',
};

const actions = {
  hover: `() => {
    const dot = [...document.querySelectorAll('#dots button.dot')].find((d) => d.getAttribute('aria-label').startsWith('Coin_Icon'));
    dot.dispatchEvent(new PointerEvent('pointerenter', { pointerId: 1, pointerType: 'mouse' }));
  }`,
  linked: `() => {
    const w = document.getElementById('wheel').getBoundingClientRect();
    const dot = [...document.querySelectorAll('#dots button.dot')].find((d) => d.getAttribute('aria-label').startsWith('Coin_Icon'));
    const d = dot.getBoundingClientRect();
    const dx = d.left + d.width / 2, dy = d.top + d.height / 2;
    for (const type of ['pointerdown', 'pointerup']) {
      try {
        dot.dispatchEvent(new PointerEvent(type, { clientX: dx, clientY: dy, pointerId: 1, pointerType: 'mouse', bubbles: true }));
      } catch {}
    }
    dot.blur();
    dot.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1, pointerType: 'mouse' }));
    const cx = w.left + 140, cy = w.top + 140;
    const x = (cx + dx) / 2, y = (cy + dy) / 2;
    document.getElementById('lines').dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', bubbles: true }));
  }`,
  axis: `() => document.getElementById('axis-val').click()`,
  individual: `() => {
    document.getElementById('mode-single').click();
    const dot = [...document.querySelectorAll('#dots button.dot')].find((d) => d.getAttribute('aria-label').startsWith('Highlight'));
    const r = dot.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const fire = (type, x, y) => {
      try {
        dot.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', bubbles: true }));
      } catch {}
    };
    dot.focus();
    fire('pointerdown', cx, cy);
    fire('pointermove', cx - 110, cy - 80);
    fire('pointerup', cx - 110, cy - 80);
    dot.blur();
    dot.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1, pointerType: 'mouse' }));
  }`,
};

function inject(action) {
  return `<script>
(() => {
  const vars = ${JSON.stringify(dark)};
  for (const k in vars) document.documentElement.style.setProperty(k, vars[k]);
  window.postMessage = (msg) => {
    const m = msg && msg.pluginMessage;
    if (!m || m.type !== 'preview') return;
    setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { pluginMessage: { type: 'previewed', sessionId: m.sessionId, revision: m.revision } } })), 0);
  };
  window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(session)} }));
  requestAnimationFrame(() => requestAnimationFrame(${action}));
})();
</script>`;
}

function shoot(action, page, out, scale = 2) {
  writeFileSync(page, html.replace(/<\/body>(?![\s\S]*<\/body>)/, `${inject(action)}</body>`));
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=360,640',
    `--force-device-scale-factor=${scale}`,
    '--virtual-time-budget=8000',
    `--screenshot=${out}`,
    pathToFileURL(page).href,
  ], { stdio: 'ignore' });
}

mkdirSync(outDir, { recursive: true });
for (const [name, action] of Object.entries(actions)) {
  const out = join(outDir, `${name}.png`);
  shoot(action, join(tmpdir(), `recolor-shot-${name}.html`), out);
  console.log(out);
}
