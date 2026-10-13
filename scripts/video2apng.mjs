// Usage: node scripts/video2apng.mjs <input.mov> <output.png> [--fps 8] [--width 480]  (headless Chrome decodes the video; CHROME env overrides the binary)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apng } from './apng.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [, value] = args.splice(i, 2);
  return Number(value);
};
const fps = option('--fps', 8);
const width = option('--width', 480);
const [input, output] = args;
if (!input || !output || !(fps > 0) || !(width > 0)) {
  console.error('usage: node scripts/video2apng.mjs <input.mov> <output.png> [--fps 8] [--width 480]');
  process.exit(1);
}

const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dir = mkdtempSync(join(tmpdir(), 'video2apng-'));
const page = join(dir, 'extract.html');
writeFileSync(
  page,
  `<!doctype html><meta charset="utf-8">
<video muted playsinline preload="auto" src="${pathToFileURL(resolve(input)).href}"></video>
<canvas></canvas>
<script>
const video = document.querySelector('video');
const canvas = document.querySelector('canvas');
const ready = new Promise((ok, fail) => {
  if (video.readyState >= 1) ok();
  video.addEventListener('loadedmetadata', ok, { once: true });
  video.addEventListener('error', () => fail(new Error('video error ' + (video.error && video.error.code))), { once: true });
});
const frame = () => new Promise((ok) => requestAnimationFrame(ok));
window.extract = async (fps, width) => {
  await ready;
  const height = Math.round((video.videoHeight * width) / video.videoWidth / 2) * 2;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const urls = [];
  for (let i = 0; i / fps < video.duration; i++) {
    const seeked = new Promise((ok) => video.addEventListener('seeked', ok, { once: true }));
    video.currentTime = i / fps;
    await seeked;
    await frame();
    ctx.drawImage(video, 0, 0, width, height);
    urls.push(canvas.toDataURL('image/png'));
  }
  return urls;
};
</script>`,
);

const proc = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--remote-debugging-port=0',
  '--remote-allow-origins=*',
  '--allow-file-access-from-files',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1700,1400',
  `--user-data-dir=${join(dir, 'profile')}`,
  pathToFileURL(page).href,
]);

const port = new Promise((ok, fail) => {
  let log = '';
  proc.stderr.on('data', (data) => {
    log += data;
    const match = log.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
    if (match) ok(match[1]);
  });
  proc.on('exit', (code) => fail(new Error(`Chrome exited (${code})\n${log}`)));
});

async function run() {
  const targets = await (await fetch(`http://127.0.0.1:${await port}/json`)).json();
  const target = targets.find((t) => t.type === 'page' && t.url.endsWith('extract.html'));
  if (!target) throw new Error('page target not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error('DevTools socket failed'));
  });
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    pending.get(msg.id)?.(msg);
  };
  let id = 0;
  const evaluate = (expression) =>
    new Promise((ok, fail) => {
      pending.set(++id, (msg) => {
        if (msg.error) fail(new Error(msg.error.message));
        else if (msg.result.exceptionDetails) fail(new Error(msg.result.exceptionDetails.exception?.description ?? 'evaluate failed'));
        else ok(msg.result.result.value);
      });
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  const count = await evaluate(`extract(${fps}, ${width}).then((urls) => (window.urls = urls).length)`);
  const urls = [];
  for (let i = 0; i < count; i++) urls.push(await evaluate(`urls[${i}]`));
  ws.close();
  return urls;
}

let timer;
try {
  const urls = await Promise.race([
    run(),
    new Promise((_, fail) => (timer = setTimeout(() => fail(new Error('timed out after 120 s')), 120_000))),
  ]);
  const frames = urls.map((url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  const png = apng(frames, 1, fps);
  writeFileSync(output, png);
  console.log(`${output}: ${frames.length} frames, ${Math.round(png.length / 1024)} KB`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  proc.removeAllListeners('exit');
  proc.kill();
  await new Promise((ok) => setTimeout(ok, 300));
  rmSync(dir, { recursive: true, force: true });
}
