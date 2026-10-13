import { scanSelection } from './scan';
import type { Snapshot } from './scan';
import type { ColorEntry, ColorField, ColorMapping, ColorTarget, MainMessage, RGB, SessionInfo, SkippedCounts, UIMessage } from './types';

figma.showUI(__html__, { width: 360, height: 560, themeColors: true });

interface Pending { revision: number; mapping: ColorMapping }
type FieldTarget = ColorTarget & { colorId: string };
const FIELDS: ColorField[] = ['fills', 'strokes', 'effects'];

function newSessionId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

let sessionId = newSessionId();
let snapshot: Snapshot = new Map();
let colors: ColorEntry[] = [];
let session: SessionInfo | null = null;
let targetIndex = new Map<string, Map<ColorField, FieldTarget[]>>();
let lastAppliedRevision = 0;
let revisionFloor = 0;
let highestSeen = 0;
let applying = false;
let pending: Pending | null = null;
let closed = false;
let selectionDirty = false;
let canvasTouched = false;
let reportedLost = 0;
let current: Promise<void> = Promise.resolve();
let queue: Promise<void> = Promise.resolve();

function post(msg: MainMessage): void {
  if (!closed) figma.ui.postMessage(msg);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildIndex(): void {
  targetIndex = new Map();
  for (const entry of colors) {
    for (const t of entry.targets) {
      let fields = targetIndex.get(t.nodeId);
      if (!fields) {
        fields = new Map();
        targetIndex.set(t.nodeId, fields);
      }
      let list = fields.get(t.field);
      if (!list) {
        list = [];
        fields.set(t.field, list);
      }
      list.push({ ...t, colorId: entry.id });
    }
  }
}

function floor(): number {
  return Math.max(lastAppliedRevision, revisionFloor);
}

async function applyMapping(mapping: ColorMapping, revision: number): Promise<boolean> {
  let lost = 0;
  let ok = true;
  for (const [nodeId, saved] of snapshot) {
    const node = await figma.getNodeByIdAsync(nodeId);
    const fields = targetIndex.get(nodeId);
    if (!node || node.removed) {
      if (fields) for (const list of fields.values()) lost += list.length;
      continue;
    }
    for (const field of FIELDS) {
      const original = saved[field];
      if (!original) continue;
      const values = clone(original);
      for (const t of fields?.get(field) ?? []) {
        const rgb = mapping[t.colorId];
        if (!rgb) continue;
        if (t.field === 'effects') {
          const effect = values[t.effectIndex] as Effect | undefined;
          if (effect?.type === 'INNER_SHADOW' || effect?.type === 'DROP_SHADOW') {
            (effect as { color: RGBA }).color = { r: rgb.r, g: rgb.g, b: rgb.b, a: effect.color.a };
          }
          continue;
        }
        const paint = values[t.paintIndex] as Paint | undefined;
        if (!paint) continue;
        if (paint.type === 'SOLID') {
          (paint as { color: RGB }).color = { r: rgb.r, g: rgb.g, b: rgb.b };
        } else if (
          t.stopIndex !== undefined &&
          (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_ANGULAR' || paint.type === 'GRADIENT_DIAMOND')
        ) {
          const stop = paint.gradientStops[t.stopIndex];
          if (stop) (stop as { color: RGBA }).color = { r: rgb.r, g: rgb.g, b: rgb.b, a: stop.color.a };
        }
      }
      canvasTouched = true;
      try {
        (node as any)[field] = values;
      } catch (err) {
        ok = false;
        post({ type: 'conflict', sessionId, lostTargets: 0, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  if (ok) lastAppliedRevision = revision;
  if (lost > 0 && lost !== reportedLost) {
    reportedLost = lost;
    post({ type: 'conflict', sessionId, lostTargets: lost, message: 'Some target nodes were removed; they are skipped.' });
  }
  return ok;
}

async function restoreSnapshot(): Promise<void> {
  let ok = true;
  for (const [nodeId, saved] of snapshot) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node || node.removed) continue;
    for (const field of FIELDS) {
      const original = saved[field];
      if (!original) continue;
      try {
        (node as any)[field] = clone(original);
      } catch (err) {
        ok = false;
        post({ type: 'conflict', sessionId, lostTargets: 0, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  if (ok) canvasTouched = false;
}

function drain(): void {
  if (applying) return;
  applying = true;
  current = (async () => {
    try {
      while (pending && pending.revision > floor()) {
        const job = pending;
        pending = null;
        const ok = await applyMapping(job.mapping, job.revision);
        if (ok) post({ type: 'previewed', sessionId, revision: job.revision });
      }
    } catch (err) {
      post({ type: 'conflict', sessionId, lostTargets: 0, message: err instanceof Error ? err.message : String(err) });
    } finally {
      applying = false;
    }
  })();
}

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch((err) => {
    post({ type: 'conflict', sessionId, lostTargets: 0, message: err instanceof Error ? err.message : String(err) });
  });
}

function invalidate(): void {
  revisionFloor = Math.max(revisionFloor, highestSeen);
  pending = null;
}

async function startSession(): Promise<void> {
  await current;
  sessionId = newSessionId();
  revisionFloor = 0;
  highestSeen = 0;
  pending = null;
  lastAppliedRevision = 0;
  reportedLost = 0;
  selectionDirty = false;
  canvasTouched = false;
  session = null;
  const result = await scanSelection(figma.currentPage.selection);
  snapshot = result.snapshot;
  colors = result.colors;
  buildIndex();
  const skipped: SkippedCounts = result.skipped;
  if (figma.currentPage.selection.length === 0) {
    post({ type: 'empty', reason: 'no-selection', skipped });
    return;
  }
  if (colors.length === 0) {
    post({ type: 'empty', reason: 'no-colors', skipped });
    return;
  }
  session = { sessionId, nodeCount: result.nodeCount, colors, skipped };
  post({ type: 'session', session });
}

async function handleReady(): Promise<void> {
  if (session) {
    post({ type: 'session', session });
    return;
  }
  await startSession();
}

figma.ui.onmessage = (msg: UIMessage) => {
  switch (msg.type) {
    case 'ready':
      enqueue(handleReady);
      break;
    case 'preview': {
      if (msg.sessionId !== sessionId || !session) return;
      highestSeen = Math.max(highestSeen, msg.revision);
      if (msg.revision <= floor()) return;
      pending = { revision: msg.revision, mapping: msg.mapping };
      drain();
      break;
    }
    case 'apply': {
      if (msg.sessionId !== sessionId || !session) return;
      highestSeen = Math.max(highestSeen, msg.revision);
      if (msg.revision <= floor()) return;
      revisionFloor = Number.POSITIVE_INFINITY;
      pending = null;
      enqueue(async () => {
        await current;
        const ok = await applyMapping(msg.mapping, msg.revision);
        if (ok) post({ type: 'applied', sessionId, revision: msg.revision });
        figma.closePlugin();
      });
      break;
    }
    case 'reset': {
      if (msg.sessionId !== sessionId || !session) return;
      invalidate();
      enqueue(async () => {
        await current;
        await restoreSnapshot();
        lastAppliedRevision = 0;
        if (selectionDirty && !canvasTouched) {
          session = null;
          await startSession();
        } else {
          post({ type: 'restored', sessionId });
        }
      });
      break;
    }
    case 'cancel': {
      if (!session) {
        figma.closePlugin();
        return;
      }
      if (msg.sessionId !== sessionId) return;
      invalidate();
      revisionFloor = Number.POSITIVE_INFINITY;
      enqueue(async () => {
        await current;
        await restoreSnapshot();
        figma.closePlugin();
      });
      break;
    }
  }
};

figma.on('selectionchange', () => {
  if (!session || (!canvasTouched && pending === null && !applying)) {
    revisionFloor = Number.POSITIVE_INFINITY;
    enqueue(startSession);
    return;
  }
  selectionDirty = true;
  post({ type: 'selection-changed' });
});

figma.on('close', () => {
  closed = true;
});
