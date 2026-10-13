export interface RGB { r: number; g: number; b: number }
export interface HSV { h: number; s: number; v: number }
export type PaintField = 'fills' | 'strokes';
export interface PaintTarget { nodeId: string; field: PaintField; paintIndex: number; stopIndex?: number }
export interface EffectTarget { nodeId: string; field: 'effects'; effectIndex: number }
export type ColorTarget = PaintTarget | EffectTarget;
export type ColorField = ColorTarget['field'];
export type ColorUse = 'fill' | 'stroke' | 'gradient' | 'drop-shadow' | 'inner-shadow';
export interface ColorEntry { id: string; source: RGB; hsv: HSV; neutral: boolean; names: string[]; uses: ColorUse[]; targets: ColorTarget[] }
export interface SkippedCounts { styleBound: number; variableBound: number; unsupportedPaints: number; hiddenOrLocked: number; text: number; other: number }
export interface SessionInfo { sessionId: string; nodeCount: number; colors: ColorEntry[]; skipped: SkippedCounts }
export type ColorMapping = Record<string, RGB>;
export type UIMessage =
  | { type: 'ready' }
  | { type: 'preview'; sessionId: string; revision: number; mapping: ColorMapping }
  | { type: 'apply'; sessionId: string; revision: number; mapping: ColorMapping }
  | { type: 'reset'; sessionId: string }
  | { type: 'cancel'; sessionId: string };
export type EmptyReason = 'no-selection' | 'no-colors';
export type MainMessage =
  | { type: 'session'; session: SessionInfo }
  | { type: 'empty'; reason: EmptyReason; skipped: SkippedCounts }
  | { type: 'previewed'; sessionId: string; revision: number }
  | { type: 'applied'; sessionId: string; revision: number }
  | { type: 'restored'; sessionId: string }
  | { type: 'selection-changed' }
  | { type: 'conflict'; sessionId: string; lostTargets: number; message: string };
