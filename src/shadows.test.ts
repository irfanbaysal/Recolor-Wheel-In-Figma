import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { colorKey } from './colors';
import { scanSelection } from './scan';
import type { MainMessage, RGB, SessionInfo, UIMessage } from './types';

const orange = { r: 199 / 255, g: 90 / 255, b: 0 };
const cyan = { r: 0, g: 0.8, b: 0.7 };
const yellow = { r: 1, g: 1, b: 81 / 255 };
const shadow = (type: 'INNER_SHADOW' | 'DROP_SHADOW' = 'INNER_SHADOW'): InnerShadowEffect | DropShadowEffect => ({
  type, color: { ...orange, a: 0.7 }, visible: true, blendMode: 'MULTIPLY',
  offset: { x: 3.29, y: 5.49 }, radius: 0, spread: 2,
});
const blur: BlurEffect = { type: 'LAYER_BLUR', blurType: 'NORMAL', radius: 4, visible: true };
const node = (overrides: Record<string, unknown> = {}) => ({
  id: 'coin', name: 'coin', type: 'VECTOR', visible: true, locked: false,
  fills: [{ type: 'SOLID', color: orange }], strokes: [], effects: [shadow(), blur],
  fillStyleId: '', strokeStyleId: '', effectStyleId: '', ...overrides,
} as unknown as VectorNode);

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.stubGlobal('figma', { mixed: Symbol('mixed') }));

describe('shadow scan', () => {
  it('merges matching paint and shadow RGB, preserving alpha in an independent snapshot', async () => {
    const target = node({ effects: [shadow(), { ...shadow('DROP_SHADOW'), color: { ...orange, a: 0.2 } }, blur] });
    const result = await scanSelection([target, target]);
    expect(result.nodeCount).toBe(1);
    expect(result.colors).toHaveLength(1);
    expect(result.colors[0].targets).toEqual([
      { nodeId: 'coin', field: 'fills', paintIndex: 0 },
      { nodeId: 'coin', field: 'effects', effectIndex: 0 },
      { nodeId: 'coin', field: 'effects', effectIndex: 1 },
    ]);
    expect(result.snapshot.get('coin')?.effects).toEqual(target.effects);
    expect(result.snapshot.get('coin')?.effects).not.toBe(target.effects);
  });

  it('includes effects-only nodes and distinguishes exact RGB floats', async () => {
    const result = await scanSelection([node({ fills: [], effects: [shadow(), {
      ...shadow(), color: { ...orange, r: orange.r + 0.00001, a: 1 },
    }] })]);
    expect(result.nodeCount).toBe(1);
    expect(result.colors).toHaveLength(2);
  });

  it('lists each layer name once per colour, in scan order', async () => {
    const result = await scanSelection([
      node({ id: 'coin', name: 'Coin', fills: [{ type: 'SOLID', color: orange }], effects: [] }),
      node({ id: 'ring', name: 'Ring', fills: [{ type: 'SOLID', color: orange }, { type: 'SOLID', color: orange }], effects: [] }),
    ]);
    expect(result.colors).toHaveLength(1);
    expect(result.colors[0].names).toEqual(['Coin', 'Ring']);
    expect(result.colors[0].targets).toHaveLength(3);
  });

  it('records how each colour is used', async () => {
    const gray = { r: 0.5, g: 0.5, b: 0.5 };
    const result = await scanSelection([
      node({ id: 'badge', fills: [{ type: 'SOLID', color: orange }], effects: [shadow('DROP_SHADOW')] }),
      node({ id: 'glow', fills: [], effects: [{ ...shadow(), color: { ...yellow, a: 1 } }] }),
      node({ id: 'outline', fills: [], strokes: [{ type: 'SOLID', color: cyan }], effects: [] }),
      node({
        id: 'sheen', effects: [],
        fills: [{ type: 'GRADIENT_LINEAR', gradientStops: [{ position: 0, color: { ...gray, a: 1 } }, { position: 1, color: { ...gray, a: 0 } }], gradientTransform: [[1, 0, 0], [0, 1, 0]] }],
      }),
    ]);
    const usesOf = (rgb: RGB) => result.colors.find((c) => c.id === colorKey(rgb))?.uses;
    expect(usesOf(orange)).toEqual(['fill', 'drop-shadow']);
    expect(usesOf(yellow)).toEqual(['inner-shadow']);
    expect(usesOf(cyan)).toEqual(['stroke']);
    expect(usesOf(gray)).toEqual(['gradient']);
  });

  it('recognizes neutral shadows without excluding them', async () => {
    const result = await scanSelection([node({ fills: [], effects: [{ ...shadow(), color: { r: 0.2, g: 0.2, b: 0.2, a: 1 } }] })]);
    expect(result.colors[0].neutral).toBe(true);
  });

  it.each([
    { effectStyleId: 'style', expected: 'styleBound' },
    { effects: [shadow(), { ...shadow(), boundVariables: { radius: { type: 'VARIABLE_ALIAS', id: 'v' } } }], expected: 'variableBound' },
    { effects: [{ ...shadow(), boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'v' } } }], expected: 'variableBound' },
  ])('skips bound effect lists without skipping independent fills: $expected', async ({ expected, ...overrides }) => {
    const result = await scanSelection([node(overrides)]);
    expect(result.colors[0].targets).toEqual([{ nodeId: 'coin', field: 'fills', paintIndex: 0 }]);
    expect(result.snapshot.get('coin')?.effects).toBeUndefined();
    expect(result.skipped[expected as 'styleBound' | 'variableBound']).toBe(1);
  });

  it('ignores hidden shadows and non-color effects', async () => {
    const result = await scanSelection([node({ fills: [], effects: [{ ...shadow(), visible: false }, blur] })]);
    expect(result.colors).toEqual([]);
    expect(result.snapshot.size).toBe(0);
    expect(result.skipped.unsupportedPaints).toBe(0);
  });

  it.each([{ locked: true }, { visible: false }, { isMask: true }, { type: 'TEXT' }])('retains node exclusions: %j', async (overrides) => {
    expect((await scanSelection([node(overrides)])).colors).toEqual([]);
  });
});

async function bootPlugin(target: VectorNode, selection: SceneNode[]) {
  vi.resetModules();
  const messages: MainMessage[] = [];
  const api = {
    mixed: Symbol('mixed'), currentPage: { selection },
    showUI: vi.fn(), closePlugin: vi.fn(), on: vi.fn(),
    getNodeByIdAsync: vi.fn(async () => target as SceneNode | null),
    ui: { postMessage: (message: MainMessage) => messages.push(message), onmessage: (_: UIMessage) => {} },
  };
  vi.stubGlobal('figma', api);
  vi.stubGlobal('__html__', '');
  await import('./main');
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const send = async (message: UIMessage) => { api.ui.onmessage(message); await flush(); };
  await send({ type: 'ready' });
  const selectionChange = async () => {
    (api.on.mock.calls.find((call) => call[0] === 'selectionchange') as unknown as [string, () => void])[1]();
    await flush();
  };
  return { api, target, messages, send, flush, selectionChange };
}

async function openPlugin(target = node()) {
  const plugin = await bootPlugin(target, [target]);
  const session = (plugin.messages.find((m) => m.type === 'session') as { session: SessionInfo }).session;
  return { ...plugin, sessionId: session.sessionId };
}

describe('shadow lifecycle', () => {
  it('opens a neutral-only selection and recolors its black shadow', async () => {
    const black = { r: 0, g: 0, b: 0 };
    const { target, send, sessionId } = await openPlugin(node({ fills: [], effects: [{ ...shadow(), color: { ...black, a: 0.25 } }] }));
    await send({ type: 'preview', sessionId, revision: 1, mapping: { [colorKey(black)]: cyan } });
    expect((target.effects[0] as InnerShadowEffect).color).toEqual({ ...cyan, a: 0.25 });
  });

  it.each(['ALPHA', 'VECTOR'])('recolors %s mask RGB while preserving mask type and opacity', async (maskType) => {
    const fills = [{ type: 'SOLID', color: orange, opacity: 0.4 }];
    const { target, send, sessionId, messages } = await openPlugin(node({ isMask: true, maskType, fills, effects: [] }));
    const session = messages.find((m) => m.type === 'session');
    expect(session?.type === 'session' && session.session.skipped.other).toBe(0);
    await send({ type: 'preview', sessionId, revision: 1, mapping: { [colorKey(orange)]: cyan } });
    expect(target.fills).toEqual([{ ...fills[0], color: cyan }]);
    expect(target.isMask).toBe(true);
    expect(target.maskType).toBe(maskType);
    await send({ type: 'reset', sessionId });
    expect(target.fills).toEqual(fills);
  });

  it('recolors inner/drop shadows and fills while retaining all other effect properties', async () => {
    const effects = [shadow(), { ...shadow('DROP_SHADOW'), color: { ...yellow, a: 0.3 }, showShadowBehindNode: true }, blur, { ...shadow(), visible: false }];
    const { target, send, sessionId } = await openPlugin(node({ effects }));
    await send({ type: 'preview', sessionId, revision: 1, mapping: { [colorKey(orange)]: cyan, [colorKey(yellow)]: orange } });
    expect(target.effects).toEqual([
      { ...effects[0], color: { ...cyan, a: 0.7 } },
      { ...effects[1], color: { ...orange, a: 0.3 } }, effects[2], effects[3],
    ]);
    expect(target.fills).toEqual([{ type: 'SOLID', color: cyan }]);
    await send({ type: 'preview', sessionId, revision: 2, mapping: {} });
    expect(target.effects).toEqual(effects);
    expect(target.fills).toEqual([{ type: 'SOLID', color: orange }]);
  });

  it.each(['reset', 'cancel'] as const)('%s restores full effects even when a preview is in flight', async (type) => {
    const { api, target, send, sessionId } = await openPlugin();
    const original = structuredClone(target.effects);
    let release!: (value: SceneNode | null) => void;
    api.getNodeByIdAsync.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    api.ui.onmessage({ type: 'preview', sessionId, revision: 1, mapping: { [colorKey(orange)]: cyan } });
    api.ui.onmessage({ type, sessionId });
    release(target);
    await send({ type: 'preview', sessionId, revision: 1, mapping: { [colorKey(orange)]: yellow } });
    expect(target.effects).toEqual(original);
    expect(target.fills).toEqual([{ type: 'SOLID', color: orange }]);
    expect(api.closePlugin).toHaveBeenCalledTimes(type === 'cancel' ? 1 : 0);
    if (type === 'reset') {
      await send({ type: 'preview', sessionId, revision: 2, mapping: { [colorKey(orange)]: cyan } });
      expect((target.effects[0] as InnerShadowEffect).color).toEqual({ ...cyan, a: 0.7 });
    }
  });

  it('Apply writes the final shadow mapping and closes', async () => {
    const { api, target, send, sessionId, messages } = await openPlugin();
    await send({ type: 'preview', sessionId, revision: 1, mapping: { [colorKey(orange)]: cyan } });
    await send({ type: 'apply', sessionId, revision: 2, mapping: { [colorKey(orange)]: yellow } });
    expect((target.effects[0] as InnerShadowEffect).color).toEqual({ ...yellow, a: 0.7 });
    expect(messages).toContainEqual({ type: 'applied', sessionId, revision: 2 });
    expect(api.closePlugin).toHaveBeenCalledOnce();
  });

  it('reports deleted paint and effect targets', async () => {
    const { api, send, sessionId, messages } = await openPlugin();
    api.getNodeByIdAsync.mockResolvedValue(null);
    await send({ type: 'preview', sessionId, revision: 1, mapping: { [colorKey(orange)]: cyan } });
    expect(messages).toContainEqual(expect.objectContaining({ type: 'conflict', lostTargets: 2 }));
  });
});

describe('selection lifecycle', () => {
  const sessions = (messages: MainMessage[]) =>
    messages.flatMap((m) => (m.type === 'session' ? [m.session] : []));
  const lastSession = (messages: MainMessage[]) => sessions(messages)[sessions(messages).length - 1];

  it('starts a session when the selection is made after opening', async () => {
    const target = node();
    const { api, messages, selectionChange } = await bootPlugin(target, []);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'empty', reason: 'no-selection' }));
    api.currentPage.selection = [target];
    await selectionChange();
    expect(sessions(messages)).toHaveLength(1);
    expect(sessions(messages)[0].colors).toHaveLength(1);
  });

  it('pins an edited session and restarts on reset', async () => {
    const { api, target, messages, send, sessionId, selectionChange } = await openPlugin();
    await send({ type: 'preview', sessionId, revision: 1, mapping: { [colorKey(orange)]: cyan } });
    const other = node({ id: 'ring', name: 'ring', fills: [{ type: 'SOLID', color: yellow }], effects: [] });
    api.currentPage.selection = [other];
    await selectionChange();
    expect(messages[messages.length - 1]).toEqual({ type: 'selection-changed' });
    expect(sessions(messages)).toHaveLength(1);
    await send({ type: 'preview', sessionId, revision: 2, mapping: { [colorKey(orange)]: yellow } });
    expect(target.fills).toEqual([{ type: 'SOLID', color: yellow }]);
    await send({ type: 'reset', sessionId });
    expect(target.fills).toEqual([{ type: 'SOLID', color: orange }]);
    expect(messages).not.toContainEqual({ type: 'restored', sessionId });
    const next = lastSession(messages);
    expect(sessions(messages)).toHaveLength(2);
    expect(next.sessionId).not.toBe(sessionId);
    expect(next.colors.map((c) => c.id)).toEqual([colorKey(yellow)]);
  });

  it('restarts an unedited session on selection change', async () => {
    const { api, messages, sessionId, selectionChange } = await openPlugin();
    api.currentPage.selection = [node({ id: 'ring', fills: [{ type: 'SOLID', color: yellow }], effects: [] })];
    await selectionChange();
    expect(messages).not.toContainEqual({ type: 'selection-changed' });
    expect(lastSession(messages).sessionId).not.toBe(sessionId);
  });

  it('keeps a partially written session pinned until a clean reset', async () => {
    const target = node();
    let fills = target.fills;
    let failNext = false;
    Object.defineProperty(target, 'fills', {
      get: () => fills,
      set: (value) => {
        if (failNext) { failNext = false; throw new Error('locked'); }
        fills = value;
      },
    });
    const { api, messages, send, sessionId, selectionChange } = await openPlugin(target);
    failNext = true;
    await send({ type: 'preview', sessionId, revision: 1, mapping: { [colorKey(orange)]: cyan } });
    expect((target.effects[0] as InnerShadowEffect).color).toEqual({ ...cyan, a: 0.7 });
    api.currentPage.selection = [node({ id: 'ring', fills: [{ type: 'SOLID', color: yellow }], effects: [] })];
    await selectionChange();
    expect(messages[messages.length - 1]).toEqual({ type: 'selection-changed' });
    expect(sessions(messages)).toHaveLength(1);
    await send({ type: 'reset', sessionId });
    expect((target.effects[0] as InnerShadowEffect).color).toEqual({ ...orange, a: 0.7 });
    expect(sessions(messages)).toHaveLength(2);
    expect(lastSession(messages).sessionId).not.toBe(sessionId);
  });
});
