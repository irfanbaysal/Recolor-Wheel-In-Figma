import { colorKey, isNeutral, rgbToHsv } from './colors';
import type { ColorEntry, ColorTarget, ColorUse, PaintField, PaintTarget, RGB, SkippedCounts } from './types';

export type Snapshot = Map<string, { fills?: Paint[]; strokes?: Paint[]; effects?: Effect[] }>;

export interface ScanResult {
  nodeCount: number;
  colors: ColorEntry[];
  skipped: SkippedCounts;
  snapshot: Snapshot;
}

const FIELDS: PaintField[] = ['fills', 'strokes'];

function emptySkipped(): SkippedCounts {
  return { styleBound: 0, variableBound: 0, unsupportedPaints: 0, hiddenOrLocked: 0, text: 0, other: 0 };
}

function hasBound(value: unknown): boolean {
  const bv = (value as { boundVariables?: object } | null | undefined)?.boundVariables;
  return !!bv && Object.keys(bv).length > 0;
}

function paintHasVariables(paint: Paint): boolean {
  if (hasBound(paint)) return true;
  if (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_ANGULAR' || paint.type === 'GRADIENT_DIAMOND') {
    return paint.gradientStops.some((s) => hasBound(s));
  }
  return false;
}

export async function scanSelection(nodes: readonly SceneNode[]): Promise<ScanResult> {
  const skipped = emptySkipped();
  const snapshot: Snapshot = new Map();
  const entries = new Map<string, ColorEntry>();
  const visited = new Set<string>();
  const contributing = new Set<string>();

  const addTarget = (rgb: RGB, target: ColorTarget, name: string, use: ColorUse) => {
    const source = { r: rgb.r, g: rgb.g, b: rgb.b };
    const key = colorKey(source);
    let entry = entries.get(key);
    if (!entry) {
      const hsv = rgbToHsv(source);
      entry = { id: key, source, hsv, neutral: isNeutral(hsv), names: [], uses: [], targets: [] };
      entries.set(key, entry);
    }
    if (!entry.names.includes(name)) entry.names.push(name);
    if (!entry.uses.includes(use)) entry.uses.push(use);
    entry.targets.push(target);
    contributing.add(target.nodeId);
  };

  const scanField = (node: SceneNode, field: PaintField) => {
    const rec = node as unknown as Record<string, unknown>;
    if (!(field in rec)) return;
    const value = (node as any)[field] as readonly Paint[] | symbol;
    if (value === figma.mixed) {
      skipped.other++;
      return;
    }
    const styleId = rec[field === 'fills' ? 'fillStyleId' : 'strokeStyleId'];
    if (typeof styleId === 'string' && styleId !== '') {
      skipped.styleBound++;
      return;
    }
    const paints = value as readonly Paint[];
    if (paints.some(paintHasVariables)) {
      skipped.variableBound++;
      return;
    }
    const found: PaintTarget[] = [];
    const colorsOf: RGB[] = [];
    const usesOf: ColorUse[] = [];
    paints.forEach((paint, paintIndex) => {
      if (paint.visible === false) return;
      switch (paint.type) {
        case 'SOLID':
          found.push({ nodeId: node.id, field, paintIndex });
          colorsOf.push(paint.color);
          usesOf.push(field === 'fills' ? 'fill' : 'stroke');
          break;
        case 'GRADIENT_LINEAR':
        case 'GRADIENT_RADIAL':
        case 'GRADIENT_ANGULAR':
        case 'GRADIENT_DIAMOND':
          paint.gradientStops.forEach((stop, stopIndex) => {
            found.push({ nodeId: node.id, field, paintIndex, stopIndex });
            colorsOf.push(stop.color);
            usesOf.push('gradient');
          });
          break;
        default:
          skipped.unsupportedPaints++;
      }
    });
    if (found.length === 0) return;
    found.forEach((t, i) => addTarget(colorsOf[i], t, node.name, usesOf[i]));
    const saved = snapshot.get(node.id) ?? {};
    saved[field] = JSON.parse(JSON.stringify(paints)) as Paint[];
    snapshot.set(node.id, saved);
  };

  const scanEffects = (node: SceneNode) => {
    if (!('effects' in node) || node.effects.length === 0) return;
    if (typeof node.effectStyleId === 'string' && node.effectStyleId !== '') {
      skipped.styleBound++;
      return;
    }
    if (node.effects.some(hasBound)) {
      skipped.variableBound++;
      return;
    }
    let found = false;
    node.effects.forEach((effect, effectIndex) => {
      if (effect.visible === false) return;
      if (effect.type !== 'INNER_SHADOW' && effect.type !== 'DROP_SHADOW') return;
      addTarget(effect.color, { nodeId: node.id, field: 'effects', effectIndex }, node.name, effect.type === 'DROP_SHADOW' ? 'drop-shadow' : 'inner-shadow');
      found = true;
    });
    if (!found) return;
    const saved = snapshot.get(node.id) ?? {};
    saved.effects = JSON.parse(JSON.stringify(node.effects)) as Effect[];
    snapshot.set(node.id, saved);
  };

  const walk = (node: SceneNode) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    if (node.visible === false || node.locked === true) {
      skipped.hiddenOrLocked++;
      return;
    }
    if ('isMask' in node && node.isMask && node.maskType !== 'ALPHA' && node.maskType !== 'VECTOR') {
      skipped.other++;
      return;
    }
    if (node.type === 'TEXT') {
      skipped.text++;
      return;
    }
    for (const field of FIELDS) scanField(node, field);
    scanEffects(node);
    if ('children' in node) {
      for (const child of node.children) walk(child);
    }
  };

  for (const node of nodes) walk(node);

  return { nodeCount: contributing.size, colors: [...entries.values()], skipped, snapshot };
}
