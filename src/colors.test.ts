import { describe, it, expect } from 'vitest';
import {
  applyDrag, clamp01, colorKey, dragDelta, hsvToRgb, hsvToWheel, hueDelta, isNeutral,
  rgbEquals, rgbToHex, rgbToHsv, wheelToHsv, wrapHue,
} from './colors';
import type { HSV, RGB } from './types';

const close = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('rgb <-> hsv', () => {
  const samples: RGB[] = [
    { r: 1, g: 0, b: 0 }, { r: 0, g: 1, b: 0 }, { r: 0, g: 0, b: 1 },
    { r: 1, g: 1, b: 1 }, { r: 0, g: 0, b: 0 }, { r: 0.5, g: 0.5, b: 0.5 },
    { r: 0.2, g: 0.7, b: 0.4 }, { r: 0.91, g: 0.13, b: 0.55 }, { r: 0.33, g: 0.44, b: 0.99 },
  ];
  it('round trips', () => {
    for (const c of samples) {
      const back = hsvToRgb(rgbToHsv(c));
      close(back.r, c.r); close(back.g, c.g); close(back.b, c.b);
    }
  });
  it('known hues', () => {
    expect(rgbToHsv({ r: 1, g: 0, b: 0 }).h).toBe(0);
    close(rgbToHsv({ r: 0, g: 1, b: 0 }).h, 120);
    close(rgbToHsv({ r: 0, g: 0, b: 1 }).h, 240);
    expect(rgbToHsv({ r: 0.5, g: 0.5, b: 0.5 })).toEqual({ h: 0, s: 0, v: 0.5 });
  });
});

describe('rgbToHex', () => {
  it('formats', () => {
    expect(rgbToHex({ r: 1, g: 0, b: 0 })).toBe('#FF0000');
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
    expect(rgbToHex({ r: 0.5, g: 0.5, b: 0.5 })).toBe('#808080');
  });
});

describe('hue math', () => {
  it('wrapHue', () => {
    expect(wrapHue(-10)).toBe(350);
    expect(wrapHue(370)).toBe(10);
    expect(wrapHue(360)).toBe(0);
  });
  it('hueDelta', () => {
    expect(hueDelta(350, 10)).toBe(20);
    expect(hueDelta(10, 350)).toBe(-20);
    expect(hueDelta(0, 180)).toBe(180);
  });
  it('clamp01', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.3)).toBe(0.3);
  });
});

describe('wheel', () => {
  it('hsvToWheel', () => {
    const a = hsvToWheel({ h: 0, s: 1, v: 1 }, 100);
    close(a.x, 100); close(a.y, 0);
    const b = hsvToWheel({ h: 90, s: 1, v: 1 }, 100);
    close(b.x, 0, 1e-9); close(b.y, -100, 1e-9);
    const c = hsvToWheel({ h: 200, s: 0, v: 1 }, 100);
    close(c.x, 0); close(c.y, 0);
  });
  it('wheelToHsv clamps beyond rim', () => {
    expect(wheelToHsv({ x: 300, y: 0 }, 100, 0.7, 0).s).toBe(1);
  });
  it('wheelToHsv dead zone keeps fallback hue', () => {
    const r = wheelToHsv({ x: 1, y: 1 }, 100, 0.5, 123);
    expect(r.h).toBe(123);
    expect(r.v).toBe(0.5);
  });
  it('round trips', () => {
    for (const hsv of [{ h: 30, s: 0.5, v: 0.8 }, { h: 200, s: 0.9, v: 0.4 }, { h: 359, s: 0.3, v: 1 }]) {
      const back = wheelToHsv(hsvToWheel(hsv, 120), 120, hsv.v, 0);
      close(back.h, hsv.h, 1e-6); close(back.s, hsv.s); expect(back.v).toBe(hsv.v);
    }
  });
  it('val axis puts v on the radius and keeps s fixed', () => {
    const a = hsvToWheel({ h: 0, s: 0.2, v: 0.6 }, 100, 'val');
    close(a.x, 60); close(a.y, 0);
    const c = hsvToWheel({ h: 200, s: 1, v: 0 }, 100, 'val');
    close(c.x, 0); close(c.y, 0);
    expect(wheelToHsv({ x: 50, y: 0 }, 100, 0.3, 0, 'val')).toEqual({ h: 0, s: 0.3, v: 0.5 });
    expect(wheelToHsv({ x: 300, y: 0 }, 100, 0.3, 0, 'val').v).toBe(1);
    const dead = wheelToHsv({ x: 1, y: 1 }, 100, 0.3, 77, 'val');
    expect(dead.h).toBe(77); expect(dead.s).toBe(0.3);
  });
  it('val axis round trips', () => {
    for (const hsv of [{ h: 30, s: 0.5, v: 0.8 }, { h: 200, s: 0.9, v: 0.4 }, { h: 359, s: 0.3, v: 1 }]) {
      const back = wheelToHsv(hsvToWheel(hsv, 120, 'val'), 120, hsv.s, 0, 'val');
      close(back.h, hsv.h, 1e-6); close(back.v, hsv.v); expect(back.s).toBe(hsv.s);
    }
  });
});

describe('applyDrag', () => {
  it('tints unlocked gray, white, and black with the linked palette', () => {
    const palette = [{ h: 30, s: 0.8, v: 0.7 }, { h: 0, s: 0, v: 0.85 }, { h: 0, s: 0, v: 0 }, { h: 0, s: 0, v: 1 }];
    const result = applyDrag(palette, [false, false, false, false], 0, { dh: 120, ds: 0, dv: 0 }, 'linked');
    expect(result).toEqual([{ h: 150, s: 0.8, v: 0.7 }, { h: 150, s: 0.8, v: 0.85 }, { h: 150, s: 0.8, v: 0.7 }, { h: 150, s: 0.8, v: 1 }]);
    expect(applyDrag(palette, [false, false, false, false], 0, { dh: 0, ds: 0, dv: 0 }, 'linked')).toEqual(palette);
  });
  it('lets a black-only selection receive a visible color by dragging', () => {
    const result = applyDrag([{ h: 0, s: 0, v: 0 }], [false], 0, { dh: 120, ds: 0.6, dv: 0 }, 'single');
    expect(result).toEqual([{ h: 120, s: 0.6, v: 1 }]);
    expect(hsvToRgb(result[0])).toEqual({ r: 0.4, g: 1, b: 0.4 });
  });
  it('edits an individual neutral without moving other colors', () => {
    const palette = [{ h: 30, s: 1, v: 1 }, { h: 0, s: 0, v: 0.85 }];
    expect(applyDrag(palette, [false, false], 1, { dh: 90, ds: 0.5, dv: 0 }, 'single')).toEqual([palette[0], { h: 90, s: 0.5, v: 0.85 }]);
  });
  const start: HSV[] = [
    { h: 10, s: 0.5, v: 0.9 },
    { h: 350, s: 0.8, v: 0.6 },
    { h: 0, s: 0, v: 0.5 },
  ];
  const locked = [false, false, true];
  it('linked rotates unlocked, keeps v, skips locked', () => {
    const out = applyDrag(start, locked, 0, { dh: 30, ds: 0, dv: 0 }, 'linked');
    close(out[0].h, 40); close(out[1].h, 20);
    expect(out[0].v).toBe(0.9); expect(out[1].v).toBe(0.6);
    expect(out[2]).toEqual(start[2]);
  });
  it('clamps saturation', () => {
    const out = applyDrag(start, locked, 0, { dh: 0, ds: 0.5, dv: 0 }, 'linked');
    expect(out[1].s).toBe(1);
    const down = applyDrag(start, locked, 0, { dh: 0, ds: -0.6, dv: 0 }, 'linked');
    expect(down[0].s).toBe(0);
  });
  it('single changes only active', () => {
    const out = applyDrag(start, locked, 1, { dh: 20, ds: 0.1, dv: 0 }, 'single');
    expect(out[0]).toEqual(start[0]);
    close(out[1].h, 10); close(out[1].s, 0.9);
    expect(out[2]).toEqual(start[2]);
  });
  it('single on locked returns unchanged copy', () => {
    const out = applyDrag(start, locked, 2, { dh: 50, ds: 0.5, dv: 0 }, 'single');
    expect(out).toEqual(start);
    expect(out).not.toBe(start);
  });
  it('wraps 359 -> 0 continuously', () => {
    const s: HSV[] = [{ h: 359, s: 0.5, v: 1 }];
    close(applyDrag(s, [false], 0, { dh: 1, ds: 0, dv: 0 }, 'linked')[0].h, 0);
    close(applyDrag(s, [false], 0, { dh: 2, ds: 0, dv: 0 }, 'linked')[0].h, 1);
  });
  it('does not mutate inputs', () => {
    const copy = JSON.parse(JSON.stringify(start));
    const lcopy = [...locked];
    applyDrag(start, locked, 0, { dh: 40, ds: 0.2, dv: 0 }, 'linked');
    expect(start).toEqual(copy);
    expect(locked).toEqual(lcopy);
  });
  it('dragDelta', () => {
    const d = dragDelta({ h: 350, s: 0.2, v: 1 }, { h: 10, s: 0.5, v: 0.75 });
    expect(d.dh).toBe(20);
    close(d.ds, 0.3);
    close(d.dv, -0.25);
  });
  it('linked dv shifts every unlocked v and clamps', () => {
    const out = applyDrag(start, locked, 0, { dh: 0, ds: 0, dv: 0.2 }, 'linked');
    expect(out[0].v).toBe(1); close(out[1].v, 0.8);
    expect(out[0].h).toBe(10); expect(out[0].s).toBe(0.5);
    expect(out[2]).toEqual(start[2]);
    const down = applyDrag(start, locked, 0, { dh: 0, ds: 0, dv: -0.95 }, 'linked');
    expect(down[0].v).toBe(0); expect(down[1].v).toBe(0);
  });
  it('dv alone keeps a neutral gray and changes only its v', () => {
    const palette = [{ h: 30, s: 0.8, v: 0.7 }, { h: 0, s: 0, v: 0.5 }];
    const out = applyDrag(palette, [false, false], 0, { dh: 0, ds: 0, dv: 0.3 }, 'linked');
    close(out[1].v, 0.8); expect(out[1].h).toBe(0); expect(out[1].s).toBe(0);
    const single = applyDrag(palette, [false, false], 1, { dh: 0, ds: 0, dv: -0.5 }, 'single');
    expect(single[0]).toEqual(palette[0]);
    expect(single[1]).toEqual({ h: 0, s: 0, v: 0 });
  });
});

describe('isNeutral / colorKey / rgbEquals', () => {
  it('isNeutral', () => {
    expect(isNeutral(rgbToHsv({ r: 0, g: 0, b: 0 }))).toBe(true);
    expect(isNeutral(rgbToHsv({ r: 1, g: 1, b: 1 }))).toBe(true);
    expect(isNeutral(rgbToHsv({ r: 0.5, g: 0.5, b: 0.5 }))).toBe(true);
    expect(isNeutral(rgbToHsv({ r: 1, g: 0.2, b: 0.2 }))).toBe(false);
  });
  it('colorKey is exact', () => {
    expect(colorKey({ r: 0.5, g: 0, b: 0 })).not.toBe(colorKey({ r: 0.5000001, g: 0, b: 0 }));
    expect(colorKey({ r: 0.5, g: 0, b: 0 })).toBe(colorKey({ r: 0.5, g: 0, b: 0 }));
  });
  it('rgbEquals', () => {
    expect(rgbEquals({ r: 0.5, g: 0, b: 0 }, { r: 0.5000001, g: 0, b: 0 })).toBe(true);
    expect(rgbEquals({ r: 0.5, g: 0, b: 0 }, { r: 0.51, g: 0, b: 0 })).toBe(false);
  });
});
