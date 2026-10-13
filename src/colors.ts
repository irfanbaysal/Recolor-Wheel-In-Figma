import type { HSV, RGB } from './types';

export const NEUTRAL_EPSILON = 0.0001;
export const CENTER_DEAD_ZONE_PX = 2;

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function wrapHue(h: number): number {
  const w = ((h % 360) + 360) % 360;
  return w >= 360 ? 0 : w;
}

export function hueDelta(from: number, to: number): number {
  let d = wrapHue(to - from);
  if (d > 180) d -= 360;
  return d;
}

export function rgbToHsv(rgb: RGB): HSV {
  const { r, g, b } = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = wrapHue(h * 60);
  }
  const s = max === 0 ? 0 : d / max;
  return { h: s === 0 ? 0 : h, s, v: max };
}

export function hsvToRgb(hsv: HSV): RGB {
  const h = wrapHue(hsv.h);
  const { s, v } = hsv;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: r + m, g: g + m, b: b + m };
}

export function rgbToHex(rgb: RGB): string {
  const ch = (x: number) =>
    Math.round(clamp01(x) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${ch(rgb.r)}${ch(rgb.g)}${ch(rgb.b)}`;
}

export function colorKey(rgb: RGB): string {
  return `${rgb.r}:${rgb.g}:${rgb.b}`;
}

export function isNeutral(hsv: HSV): boolean {
  return hsv.s <= NEUTRAL_EPSILON || hsv.v <= NEUTRAL_EPSILON;
}

export interface WheelPoint { x: number; y: number }

export type WheelAxis = 'sat' | 'val';

export function hsvToWheel(hsv: HSV, radius: number, axis: WheelAxis = 'sat'): WheelPoint {
  const rad = (hsv.h * Math.PI) / 180;
  const dist = clamp01(axis === 'sat' ? hsv.s : hsv.v) * radius;
  return { x: Math.cos(rad) * dist, y: -Math.sin(rad) * dist };
}

export function wheelToHsv(
  p: WheelPoint,
  radius: number,
  fixed: number,
  fallbackHue: number,
  axis: WheelAxis = 'sat',
): HSV {
  const dist = Math.hypot(p.x, p.y);
  const radial = radius > 0 ? clamp01(dist / radius) : 0;
  const h = dist < CENTER_DEAD_ZONE_PX ? fallbackHue : wrapHue((Math.atan2(-p.y, p.x) * 180) / Math.PI);
  return axis === 'sat' ? { h, s: radial, v: fixed } : { h, s: fixed, v: radial };
}

export interface DragDelta { dh: number; ds: number; dv: number }

export function dragDelta(start: HSV, current: HSV): DragDelta {
  return { dh: hueDelta(start.h, current.h), ds: current.s - start.s, dv: current.v - start.v };
}

export type DragMode = 'linked' | 'single';

export function applyDrag(
  startHsv: HSV[],
  locked: boolean[],
  activeIndex: number,
  delta: DragDelta,
  mode: DragMode,
): HSV[] {
  const active = startHsv[activeIndex];
  const reference = active && !isNeutral(active) ? active
    : startHsv.find((c, i) => !locked[i] && !isNeutral(c)) ?? { h: active?.h ?? 0, s: 1, v: 1 };
  return startHsv.map((c, i) => {
    const moves = mode === 'linked' ? !locked[i] : i === activeIndex && !locked[i];
    if (!moves) return { ...c };
    if (isNeutral(c) && (delta.dh !== 0 || delta.ds !== 0)) {
      // Neutrals have no usable hue; black also needs value to become visible.
      const base = mode === 'linked' && i !== activeIndex ? reference : c;
      return {
        h: wrapHue(base.h + delta.dh),
        s: clamp01((base.s > NEUTRAL_EPSILON ? base.s : delta.ds !== 0 ? 0 : reference.s) + delta.ds),
        v: clamp01((c.v > NEUTRAL_EPSILON ? c.v : reference.v) + delta.dv),
      };
    }
    return { h: wrapHue(c.h + delta.dh), s: clamp01(c.s + delta.ds), v: clamp01(c.v + delta.dv) };
  });
}

export function rgbEquals(a: RGB, b: RGB, eps = 1e-6): boolean {
  return Math.abs(a.r - b.r) <= eps && Math.abs(a.g - b.g) <= eps && Math.abs(a.b - b.b) <= eps;
}
