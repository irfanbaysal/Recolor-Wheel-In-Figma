import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');
const mainEntry = path.join(srcDir, 'main.ts');
const uiEntry = path.join(srcDir, 'ui.ts');
const uiHtmlPath = path.join(srcDir, 'ui.html');
const uiCssPath = path.join(srcDir, 'ui.css');
const watchMode = process.argv.includes('--watch');

const CSS_PLACEHOLDER = '<!-- INLINE_CSS -->';
const JS_PLACEHOLDER = '<!-- INLINE_JS -->';

const mainOptions = {
  entryPoints: [mainEntry],
  outfile: path.join(distDir, 'main.js'),
  bundle: true,
  format: 'iife',
  target: 'es2020',
  platform: 'browser',
  minify: false,
  sourcemap: false,
};

function timestamp() {
  return new Date().toLocaleTimeString();
}

async function buildUiJs() {
  const result = await esbuild.build({
    entryPoints: [uiEntry],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2020',
    platform: 'browser',
  });
  return result.outputFiles[0].text;
}

function inlineUi(js) {
  const html = fs.readFileSync(uiHtmlPath, 'utf8');
  const css = fs.readFileSync(uiCssPath, 'utf8');
  for (const placeholder of [CSS_PLACEHOLDER, JS_PLACEHOLDER]) {
    if (!html.includes(placeholder)) {
      throw new Error(`ui.html is missing placeholder ${placeholder}`);
    }
  }
  const out = html
    .replace(CSS_PLACEHOLDER, () => `<style>${css}</style>`)
    .replace(JS_PLACEHOLDER, () => `<script>${js}</script>`);
  fs.writeFileSync(path.join(distDir, 'ui.html'), out);
}

async function buildUi() {
  inlineUi(await buildUiJs());
}

function logRebuildPlugin() {
  return {
    name: 'log-rebuild',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) {
          console.log(`[${timestamp()}] main rebuilt`);
        }
      });
    },
  };
}

async function main() {
  fs.mkdirSync(distDir, { recursive: true });

  if (!watchMode) {
    await esbuild.build(mainOptions);
    await buildUi();
    return;
  }

  const ctx = await esbuild.context({ ...mainOptions, plugins: [logRebuildPlugin()] });
  await ctx.watch();
  await buildUi();
  console.log(`[${timestamp()}] ui rebuilt`);

  let timer = null;
  fs.watch(srcDir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await buildUi();
        console.log(`[${timestamp()}] ui rebuilt`);
      } catch (err) {
        console.error(`[${timestamp()}] ui build failed: ${err.message ?? err}`);
      }
    }, 100);
  });
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
