import type { ColorEntry, ColorMapping, ColorUse, EmptyReason, HSV, MainMessage, SkippedCounts, UIMessage } from './types';
import {
  CENTER_DEAD_ZONE_PX,
  applyDrag,
  dragDelta,
  hsvToRgb,
  hsvToWheel,
  rgbEquals,
  rgbToHex,
  wheelToHsv,
} from './colors';
import type { DragMode, WheelAxis, WheelPoint } from './colors';

const SIZE = 280;
const C = SIZE / 2;
const R = C - 1;
const OVERLAP_PX = 8;
const THROTTLE_MS = 33;
const ACK_TIMEOUT_MS = 500;
const SVG_NS = 'http://www.w3.org/2000/svg';

const EMPTY_TEXT: Record<EmptyReason, string> = {
  'no-selection': 'Select vectors or a group to start.',
  'no-colors': 'No editable colors in the selection.',
};

interface DragState {
  index: number;
  pointerId: number;
  grab: WheelPoint;
  start: HSV[];
  lastHue: number;
  group: boolean;
  ref: HSV;
  origin?: WheelPoint;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const statusEl = el<HTMLParagraphElement>('status');
const noteEl = el<HTMLParagraphElement>('note');
const emptyEl = el<HTMLParagraphElement>('empty');
const wheelEl = el<HTMLDivElement>('wheel');
const canvas = el<HTMLCanvasElement>('canvas');
const linesEl = document.getElementById('lines') as unknown as SVGSVGElement;
const dotsEl = el<HTMLDivElement>('dots');
const tipEl = el<HTMLDivElement>('tip');
const popEl = el<HTMLDivElement>('pop');
const modeLinked = el<HTMLButtonElement>('mode-linked');
const modeSingle = el<HTMLButtonElement>('mode-single');
const axisEl = el<HTMLDivElement>('axis');
const axisSat = el<HTMLButtonElement>('axis-sat');
const axisVal = el<HTMLButtonElement>('axis-val');
const slider = el<HTMLInputElement>('slider');
const sliderLabel = el<HTMLSpanElement>('slider-label');
const resetBtn = el<HTMLButtonElement>('reset');
const cancelBtn = el<HTMLButtonElement>('cancel');
const applyBtn = el<HTMLButtonElement>('apply');

let sessionId: string | null = null;
let entries: ColorEntry[] = [];
let startHsv: HSV[] = [];
let currentHsv: HSV[] = [];
let locked: boolean[] = [];
let dots: HTMLButtonElement[] = [];
let lines: SVGLineElement[] = [];
let hits: SVGLineElement[] = [];
let fan: SVGPolygonElement | null = null;
let rot: SVGGElement | null = null;
let mode: DragMode = 'linked';
let activeIndex: number | null = null;
let tipIndex: number | null = null;
let drag: DragState | null = null;
let hoverGlyph: WheelPoint | null = null;
let axis: WheelAxis = 'sat';
let sliderStart: HSV[] | null = null;
let busy = false;
let statusText = '';
let frame = 0;

let revision = 0;
let inFlight: number | null = null;
let inFlightAt = 0;
let lastSent = 0;
let dirty = false;
let timer: number | null = null;

function post(msg: UIMessage): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

function clone(h: HSV): HSV {
  return { ...h };
}

function describe(skipped: SkippedCounts, colors: ColorEntry[]): string {
  const editable = colors.length;
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  const parts: string[] = [];
  if (editable > 0) parts.push(`${editable} ${editable === 1 ? 'color' : 'colors'} in selection`);
  if (skippedTotal > 0) {
    const labels: Record<keyof SkippedCounts, string> = {
      styleBound: 'style-bound lists', variableBound: 'variable-bound lists',
      unsupportedPaints: 'unsupported paints', hiddenOrLocked: 'hidden/locked layers',
      text: 'text layers', other: 'mixed paints or luminance masks',
    };
    const reasons = (Object.keys(labels) as (keyof SkippedCounts)[])
      .filter((key) => skipped[key] > 0).map((key) => `${skipped[key]} ${labels[key]}`);
    parts.push(`Skipped: ${reasons.join(', ')}`);
  }
  return parts.join(' · ');
}

function drawWheel(): void {
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const px = SIZE * dpr;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(px, px);
  const radius = R * dpr;
  const center = C * dpr;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      const edge = radius - Math.hypot(dx, dy) + 0.5;
      if (edge <= 0) continue;
      const rgb = hsvToRgb(wheelToHsv({ x: dx, y: dy }, radius, 1, 0, axis));
      const o = (y * px + x) * 4;
      img.data[o] = Math.round(rgb.r * 255);
      img.data[o + 1] = Math.round(rgb.g * 255);
      img.data[o + 2] = Math.round(rgb.b * 255);
      img.data[o + 3] = Math.round(Math.min(1, edge) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
}

function hexOf(i: number): string {
  return rgbToHex(hsvToRgb(currentHsv[i]));
}

function nameLabel(i: number): string {
  const names = entries[i]?.names ?? [];
  if (names.length === 0) return '';
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
}

const USE_LABELS: Record<ColorUse, string> = {
  fill: 'Fill',
  stroke: 'Stroke',
  gradient: 'Gradient',
  'drop-shadow': 'Drop shadow',
  'inner-shadow': 'Inner shadow',
};

function useLabel(i: number): string {
  return (entries[i]?.uses ?? []).map((u) => USE_LABELS[u]).join(' · ');
}

function dotLabel(i: number, hex: string): string {
  const name = nameLabel(i);
  const base = name ? `${name} · ${hex}` : hex;
  const uses = useLabel(i);
  return uses ? `${base} · ${uses}` : base;
}

function dotPos(i: number): WheelPoint {
  const p = hsvToWheel(currentHsv[i], R, axis);
  return { x: C + p.x, y: C + p.y };
}

function cross(o: WheelPoint, a: WheelPoint, b: WheelPoint): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function convexHull(points: WheelPoint[]): WheelPoint[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const uniq = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.5);
  if (uniq.length < 3) return uniq;
  const build = (list: WheelPoint[]): WheelPoint[] => {
    const out: WheelPoint[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(uniq), ...build([...uniq].reverse())];
}

function toWheel(e: PointerEvent): WheelPoint {
  const rect = wheelEl.getBoundingClientRect();
  return { x: e.clientX - rect.left - C, y: e.clientY - rect.top - C };
}

function requestRender(): void {
  if (frame) return;
  frame = requestAnimationFrame(render);
}

function renderRot(): void {
  if (!rot) return;
  if (mode !== 'linked' || !hoverGlyph || drag) {
    rot.style.display = 'none';
    return;
  }
  const { x, y } = hoverGlyph;
  rot.setAttribute('transform', `translate(${C + x} ${C + y}) rotate(${(Math.atan2(y, x) * 180) / Math.PI})`);
  rot.style.display = '';
}

function render(): void {
  frame = 0;
  statusEl.textContent = statusText || ' ';
  const ready = sessionId !== null && !busy;
  resetBtn.disabled = !ready;
  applyBtn.disabled = !ready;
  cancelBtn.disabled = busy;
  modeLinked.disabled = !ready || drag !== null;
  modeSingle.disabled = !ready || drag !== null;
  modeLinked.classList.toggle('on', mode === 'linked');
  modeSingle.classList.toggle('on', mode === 'single');
  modeLinked.setAttribute('aria-pressed', String(mode === 'linked'));
  modeSingle.setAttribute('aria-pressed', String(mode === 'single'));
  axisEl.hidden = !ready;
  const act = activeIndex !== null && activeIndex < dots.length ? activeIndex : null;
  slider.disabled = !ready || act === null || locked[act];
  if (sliderStart === null && act !== null) {
    slider.value = String(Math.round((axis === 'sat' ? currentHsv[act].v : currentHsv[act].s) * 100));
  }
  sliderLabel.textContent = axis === 'sat' ? 'Brightness' : 'Saturation';
  const axisLocked = !ready || drag !== null || sliderStart !== null;
  axisSat.disabled = axisLocked;
  axisVal.disabled = axisLocked;
  axisSat.classList.toggle('on', axis === 'sat');
  axisVal.classList.toggle('on', axis === 'val');
  axisSat.setAttribute('aria-pressed', String(axis === 'sat'));
  axisVal.setAttribute('aria-pressed', String(axis === 'val'));
  for (let i = 0; i < dots.length; i++) {
    const pos = dotPos(i);
    const hex = hexOf(i);
    const dot = dots[i];
    dot.style.left = `${pos.x}px`;
    dot.style.top = `${pos.y}px`;
    const label = dotLabel(i, hex);
    if (dot.dataset.label !== label) {
      dot.dataset.label = label;
      dot.style.background = hex;
      dot.setAttribute('aria-label', label);
    }
    dot.classList.toggle('active', activeIndex === i);
    const line = lines[i];
    const show = mode === 'linked' && !locked[i];
    const hit = hits[i];
    line.style.display = show ? '' : 'none';
    hit.style.display = show ? '' : 'none';
    if (show) {
      line.setAttribute('x2', String(pos.x));
      line.setAttribute('y2', String(pos.y));
      hit.setAttribute('x2', String(pos.x));
      hit.setAttribute('y2', String(pos.y));
    }
  }
  if (fan) {
    const hull =
      mode === 'linked'
        ? convexHull([{ x: C, y: C }, ...dots.map((_, i) => i).filter((i) => !locked[i]).map(dotPos)])
        : [];
    if (hull.length >= 3) {
      fan.style.display = '';
      fan.setAttribute('points', hull.map((q) => `${q.x},${q.y}`).join(' '));
    } else {
      fan.style.display = 'none';
    }
  }
  renderRot();
  const ti = drag ? (drag.group ? null : drag.index) : tipIndex;
  if (ti !== null && ti < dots.length) {
    const pos = dotPos(ti);
    tipEl.hidden = false;
    tipEl.style.left = `${pos.x}px`;
    tipEl.style.top = `${pos.y - (locked[ti] ? 10 : activeIndex === ti ? 18 : 14)}px`;
    (tipEl.querySelector('.nm') as HTMLElement).textContent = nameLabel(ti);
    (tipEl.querySelector('.sw') as HTMLElement).style.background = hexOf(ti);
    (tipEl.querySelector('.hx') as HTMLElement).textContent = hexOf(ti);
    (tipEl.querySelector('.kd') as HTMLElement).textContent = useLabel(ti);
    const r = tipEl.getBoundingClientRect();
    const w = document.body.clientWidth;
    const pad = 4;
    let left = pos.x;
    if (r.right > w - pad) left -= r.right - (w - pad);
    else if (r.left < pad) left += pad - r.left;
    tipEl.style.left = `${left}px`;
  } else {
    tipEl.hidden = true;
  }
}

function buildMapping(): ColorMapping {
  const mapping: ColorMapping = {};
  entries.forEach((entry, i) => {
    if (locked[i]) return;
    const next = hsvToRgb(currentHsv[i]);
    if (rgbEquals(next, hsvToRgb(startHsv[i]))) return;
    mapping[entry.id] = next;
  });
  return mapping;
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function pump(immediate = false): void {
  clearTimer();
  if (sessionId === null || busy || !dirty) return;
  const now = performance.now();
  let wait = 0;
  if (inFlight !== null) wait = inFlightAt + ACK_TIMEOUT_MS - now;
  else if (!immediate) wait = lastSent + THROTTLE_MS - now;
  if (wait > 0) {
    timer = window.setTimeout(() => pump(immediate), wait);
    return;
  }
  dirty = false;
  revision += 1;
  inFlight = revision;
  inFlightAt = now;
  lastSent = now;
  post({ type: 'preview', sessionId, revision, mapping: buildMapping() });
}

function schedulePreview(): void {
  dirty = true;
  pump();
}

function closePop(): void {
  popEl.hidden = true;
  popEl.textContent = '';
}

function openPop(group: number[]): void {
  closePop();
  const anchor = dotPos(group[0]);
  for (const j of group) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pop-item';
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = hexOf(j);
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = nameLabel(j);
    const label = document.createElement('span');
    label.textContent = hexOf(j);
    item.append(name, sw, label);
    item.addEventListener('click', () => {
      closePop();
      activeIndex = j;
      dots[j].focus();
      requestRender();
    });
    popEl.append(item);
  }
  popEl.style.left = `${Math.min(anchor.x + 14, SIZE - 110)}px`;
  popEl.style.top = `${Math.min(anchor.y + 14, SIZE - 20 * group.length)}px`;
  popEl.hidden = false;
  (popEl.firstElementChild as HTMLElement).focus();
}

function overlapping(i: number): number[] {
  const a = dotPos(i);
  const group = [i];
  for (let j = 0; j < dots.length; j++) {
    if (j === i || locked[j]) continue;
    const b = dotPos(j);
    if (Math.hypot(a.x - b.x, a.y - b.y) <= OVERLAP_PX) group.push(j);
  }
  return group;
}

function finishDrag(): void {
  drag = null;
  dirty = true;
  pump(true);
  requestRender();
}

function endDrag(e: PointerEvent, dot: HTMLButtonElement): void {
  if (!drag || drag.pointerId !== e.pointerId) return;
  if (dot.hasPointerCapture(e.pointerId)) dot.releasePointerCapture(e.pointerId);
  if (drag.origin && !locked[drag.index]) {
    const p = toWheel(e);
    if (Math.hypot(p.x - drag.origin.x, p.y - drag.origin.y) < 4) activeIndex = drag.index;
  }
  finishDrag();
}

function endGroupDrag(e: PointerEvent): void {
  if (!drag || !drag.group || drag.pointerId !== e.pointerId) return;
  if (linesEl.hasPointerCapture(e.pointerId)) linesEl.releasePointerCapture(e.pointerId);
  linesEl.classList.remove('dragging');
  finishDrag();
}

function firstUnlocked(): number {
  if (activeIndex !== null && activeIndex < dots.length && !locked[activeIndex]) return activeIndex;
  const chromatic = currentHsv.findIndex((c, i) => !locked[i] && c.s > 0.0001 && c.v > 0.0001);
  if (chromatic >= 0) return chromatic;
  return locked.findIndex((l) => !l);
}

linesEl.addEventListener('pointerdown', (e) => {
  const target = e.target as Element;
  if (e.button !== 0 || busy || mode !== 'linked' || drag) return;
  if (!target.classList.contains('fan') && !target.classList.contains('hit')) return;
  const index = firstUnlocked();
  if (index < 0) return;
  closePop();
  const ref = wheelToHsv(toWheel(e), R, 1, currentHsv[index].h, axis);
  drag = {
    index,
    pointerId: e.pointerId,
    grab: { x: 0, y: 0 },
    start: currentHsv.map(clone),
    lastHue: ref.h,
    group: true,
    ref,
    origin: toWheel(e),
  };
  hoverGlyph = null;
  linesEl.setPointerCapture(e.pointerId);
  linesEl.classList.add('dragging');
  requestRender();
});

linesEl.addEventListener('pointermove', (e) => {
  if (!drag || !drag.group || drag.pointerId !== e.pointerId) return;
  const p = toWheel(e);
  const cur = wheelToHsv(p, R, 1, drag.lastHue, axis);
  if (Math.hypot(p.x, p.y) >= CENTER_DEAD_ZONE_PX) drag.lastHue = cur.h;
  const d = dragDelta(drag.ref, cur);
  currentHsv = applyDrag(drag.start, locked, drag.index, { ...d, ds: 0, dv: 0 }, 'linked');
  requestRender();
  schedulePreview();
});

linesEl.addEventListener('pointermove', (e) => {
  if (mode !== 'linked' || drag) return;
  hoverGlyph = toWheel(e);
  tipIndex = null;
  requestRender();
});

linesEl.addEventListener('pointerout', (e) => {
  if (e.relatedTarget instanceof Node && linesEl.contains(e.relatedTarget)) return;
  hoverGlyph = null;
  requestRender();
});

linesEl.addEventListener('pointerup', endGroupDrag);
linesEl.addEventListener('pointercancel', endGroupDrag);

function attachDot(dot: HTMLButtonElement, i: number): void {
  dot.addEventListener('pointerenter', () => {
    tipIndex = i;
    requestRender();
  });
  dot.addEventListener('pointerleave', () => {
    if (tipIndex === i) tipIndex = null;
    requestRender();
  });
  dot.addEventListener('focus', () => {
    if (dot.matches(':focus-visible')) tipIndex = i;
    if (!locked[i] && !drag) activeIndex = i;
    requestRender();
  });
  dot.addEventListener('blur', () => {
    if (tipIndex === i) tipIndex = null;
    requestRender();
  });
  if (locked[i]) return;
  dot.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || busy) return;
    e.stopPropagation();
    closePop();
    const chosen = activeIndex === i;
    const group = overlapping(i);
    if (group.length > 1 && !chosen) {
      openPop(group);
      requestRender();
      return;
    }
    const pos = dotPos(i);
    const p = toWheel(e);
    drag = {
      index: i,
      pointerId: e.pointerId,
      grab: { x: p.x + C - pos.x, y: p.y + C - pos.y },
      start: currentHsv.map(clone),
      lastHue: currentHsv[i].h,
      group: false,
      ref: currentHsv[i],
      origin: p,
    };
    dot.setPointerCapture(e.pointerId);
    requestRender();
  });
  dot.addEventListener('pointermove', (e) => {
    if (!drag || drag.pointerId !== e.pointerId || drag.index !== i) return;
    const p = toWheel(e);
    const q = { x: p.x - drag.grab.x, y: p.y - drag.grab.y };
    const res = wheelToHsv(q, R, axis === 'sat' ? drag.start[i].v : drag.start[i].s, drag.lastHue, axis);
    if (Math.hypot(q.x, q.y) >= CENTER_DEAD_ZONE_PX) drag.lastHue = res.h;
    const d = dragDelta(drag.start[i], res);
    const rotateOnly = mode === 'linked' && i !== activeIndex;
    currentHsv = applyDrag(drag.start, locked, i, rotateOnly ? { ...d, ds: 0, dv: 0 } : d, mode);
    requestRender();
    schedulePreview();
  });
  dot.addEventListener('pointerup', (e) => endDrag(e, dot));
  dot.addEventListener('pointercancel', (e) => endDrag(e, dot));
  dot.addEventListener('keydown', (e) => {
    if (busy || drag) return;
    const big = e.shiftKey;
    let dh = 0;
    let ds = 0;
    let dv = 0;
    if (e.key === 'ArrowLeft') dh = big ? -10 : -1;
    else if (e.key === 'ArrowRight') dh = big ? 10 : 1;
    else if (e.key === 'ArrowUp') {
      if (axis === 'sat') ds = big ? 0.1 : 0.01;
      else dv = big ? 0.1 : 0.01;
    } else if (e.key === 'ArrowDown') {
      if (axis === 'sat') ds = big ? -0.1 : -0.01;
      else dv = big ? -0.1 : -0.01;
    }
    else return;
    e.preventDefault();
    activeIndex = i;
    currentHsv = applyDrag(currentHsv, locked, i, { dh, ds, dv }, mode);
    requestRender();
    schedulePreview();
  });
}

function buildDots(): void {
  dotsEl.textContent = '';
  linesEl.textContent = '';
  dots = [];
  lines = [];
  hits = [];
  fan = document.createElementNS(SVG_NS, 'polygon');
  fan.setAttribute('class', 'fan');
  fan.style.display = 'none';
  linesEl.append(fan);
  entries.forEach((entry, i) => {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(C));
    line.setAttribute('y1', String(C));
    linesEl.append(line);
    lines.push(line);
    const hit = document.createElementNS(SVG_NS, 'line');
    hit.setAttribute('class', 'hit');
    hit.setAttribute('x1', String(C));
    hit.setAttribute('y1', String(C));
    hit.style.display = 'none';
    linesEl.append(hit);
    hits.push(hit);
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = locked[i] ? 'dot locked' : 'dot';
    dot.disabled = false;
    dotsEl.append(dot);
    dots.push(dot);
    attachDot(dot, i);
  });
  rot = document.createElementNS(SVG_NS, 'g');
  rot.setAttribute('class', 'rot');
  rot.style.display = 'none';
  const makePath = (cls: string): SVGPathElement => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', cls);
    rot!.append(path);
    return path;
  };
  const arc = 'M1 -8.66A10 10 0 0 1 1 8.66';
  const heads = 'M-5.062 12.16L-1 5.196L3 12.124ZM-5.062 -12.16L3 -12.124L-1 -5.196Z';
  makePath('rot-outline').setAttribute('d', arc);
  makePath('rot-arc').setAttribute('d', arc);
  makePath('rot-heads-outline').setAttribute('d', heads);
  makePath('rot-heads').setAttribute('d', heads);
  linesEl.append(rot);
}

function showEmpty(reason: EmptyReason, skipped: SkippedCounts): void {
  sessionId = null;
  entries = [];
  startHsv = [];
  currentHsv = [];
  locked = [];
  buildDots();
  statusText = describe(skipped, []);
  emptyEl.textContent = EMPTY_TEXT[reason];
  emptyEl.hidden = false;
  noteEl.hidden = true;
  wheelEl.hidden = true;
  requestRender();
}

function showNote(text: string, warn: boolean): void {
  noteEl.textContent = text;
  noteEl.classList.toggle('warn', warn);
  noteEl.hidden = false;
}

window.onmessage = (e: MessageEvent) => {
  const m = e.data && (e.data.pluginMessage as MainMessage | undefined);
  if (!m) return;
  if (m.type === 'session') {
    sessionId = m.session.sessionId;
    entries = m.session.colors;
    startHsv = entries.map((c) => clone(c.hsv));
    currentHsv = startHsv.map(clone);
    locked = entries.map(() => false);
    activeIndex = null;
    activeIndex = firstUnlocked() >= 0 ? firstUnlocked() : null;
    tipIndex = null;
    drag = null;
    sliderStart = null;
    dirty = false;
    inFlight = null;
    clearTimer();
    closePop();
    buildDots();
    statusText = describe(m.session.skipped, entries);
    emptyEl.hidden = true;
    noteEl.hidden = true;
    wheelEl.hidden = false;
    requestRender();
  } else if (m.type === 'empty') {
    showEmpty(m.reason, m.skipped);
  } else if (m.type === 'previewed') {
    if (m.sessionId === sessionId && inFlight !== null && m.revision >= inFlight) {
      inFlight = null;
      pump();
    }
  } else if (m.type === 'selection-changed') {
    showNote('Selection changed. Keeping your edits on the original layers; press Reset to switch to the new selection.', false);
  } else if (m.type === 'conflict') {
    if (m.sessionId === sessionId) showNote(m.message, true);
  } else if (m.type === 'restored') {
    if (m.sessionId === sessionId) requestRender();
  }
};

function setMode(next: DragMode): void {
  if (drag || busy) return;
  mode = next;
  requestRender();
}

modeLinked.addEventListener('click', () => setMode('linked'));
modeSingle.addEventListener('click', () => setMode('single'));

function setAxis(next: WheelAxis): void {
  if (drag || sliderStart || axis === next) return;
  axis = next;
  drawWheel();
  requestRender();
}

axisSat.addEventListener('click', () => setAxis('sat'));
axisVal.addEventListener('click', () => setAxis('val'));

slider.addEventListener('input', () => {
  if (busy || sessionId === null || activeIndex === null || locked[activeIndex]) return;
  if (sliderStart === null) sliderStart = currentHsv.map(clone);
  const base = sliderStart[activeIndex];
  const delta = Number(slider.value) / 100 - (axis === 'sat' ? base.v : base.s);
  currentHsv = applyDrag(
    sliderStart, locked, activeIndex,
    axis === 'sat' ? { dh: 0, ds: 0, dv: delta } : { dh: 0, ds: delta, dv: 0 },
    mode,
  );
  requestRender();
  schedulePreview();
});

slider.addEventListener('change', () => {
  if (sliderStart === null) return;
  sliderStart = null;
  dirty = true;
  pump(true);
  requestRender();
});

resetBtn.addEventListener('click', () => {
  if (sessionId === null || busy) return;
  post({ type: 'reset', sessionId });
  currentHsv = startHsv.map(clone);
  sliderStart = null;
  dirty = false;
  inFlight = null;
  clearTimer();
  requestRender();
});

cancelBtn.addEventListener('click', () => {
  busy = true;
  clearTimer();
  post({ type: 'cancel', sessionId: sessionId ?? '' });
  requestRender();
});

applyBtn.addEventListener('click', () => {
  if (sessionId === null || busy) return;
  busy = true;
  dirty = false;
  clearTimer();
  revision += 1;
  post({ type: 'apply', sessionId, revision, mapping: buildMapping() });
  requestRender();
});

document.addEventListener('pointerdown', (e) => {
  if (!popEl.hidden && !popEl.contains(e.target as Node)) closePop();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || popEl.hidden) return;
  closePop();
  if (activeIndex !== null && dots[activeIndex]) dots[activeIndex].focus();
});

drawWheel();
requestRender();
post({ type: 'ready' });
