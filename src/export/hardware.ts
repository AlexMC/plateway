import { useEffect, useState } from 'react';
import type { RoutePiece } from '../domain/project';
import { kindOfFamily, pieceDefinition } from '../domain/pieces';
import type { PiecePart } from '../fitting/fit';
import { apiJson } from '../net/api';

/** Shopping-list categories in display order (POST /api/hardware sorts its lines the same way). */
export const HARDWARE_CATEGORIES = [
  { id: 'fasteners', label: 'Fasteners' }, { id: 'magnets', label: 'Magnets' }, { id: 'bearings', label: 'Bearings & weights' },
  { id: 'brick', label: 'Brick parts' }, { id: 'electronics', label: 'Electronics' }, { id: 'materials', label: 'Materials' }
] as const;
export type HardwareCategory = typeof HARDWARE_CATEGORIES[number]['id'];
export const HARDWARE_ERROR = "Couldn't load hardware";

/** One printed part as the service reads it: `piece` is the layout piece (or support) it belongs to, `label` that piece's name. */
export interface HardwarePiece { id: string; piece: string; label: string; family: string; parameters: Record<string, number> }
export interface HardwareRequest { pieces: HardwarePiece[] }
export interface HardwareLine { category: HardwareCategory; name: string; quantity: number; pieces: string[] }
/** Layout control gear (servo driver, leads, hub, receiver…), counted for the whole layout; `scope` says how it is shared ("per servo", "shared, up to 16 servos per board", "once per layout"…). */
export interface HardwareControl { category: HardwareCategory; name: string; quantity: number; scope: string; note: string }
export interface HardwareResult { lines: HardwareLine[]; control: HardwareControl[]; notes: string[]; warnings: string[] }

const SUPPORT_LABELS: Record<string, string> = { anchored_bracket: 'Anchored bracket', reversible_column: 'Column', layout_riser: 'Riser' };

/** A layout piece's display name: its track kind (Curve, Straight…) or its piece definition. */
export function pieceLabel(piece: RoutePiece): string {
  return kindOfFamily(piece.family)?.label ?? pieceDefinition(piece.family).label;
}

/**
 * The service request for these parts: printed ones only, each tied to the layout piece among `tiles` it belongs to
 * (a part's `sectionId` is the piece id or `<piece>:<n>`). Supports and track brackets count as pieces of their own.
 */
export function hardwareRequest(parts: readonly PiecePart[], tiles: readonly RoutePiece[]): HardwareRequest {
  const pieces = parts.filter(part => part.source === 'printed').map(part => {
    const { id, family, parameters } = part;
    if (family === 'track_bracket') return { id, piece: id, label: parameters.mount === 2 ? 'Shelf bracket' : 'Wall bracket', family, parameters };
    if (SUPPORT_LABELS[family]) return { id, piece: id, label: SUPPORT_LABELS[family], family, parameters };
    const tile = tiles.find(item => part.sectionId === item.id || part.sectionId.startsWith(`${item.id}:`));
    return { id, piece: tile?.id ?? part.sectionId, label: tile ? pieceLabel(tile) : family.replaceAll('_', ' '), family, parameters };
  });
  return { pieces };
}

const EMPTY: HardwareResult = { lines: [], control: [], notes: [], warnings: [] };
const CACHE_LIMIT = 200;
/** Answers by request body, shared by every view (the same layout or tile options never ask twice). */
const answers = new Map<string, HardwareResult>();

export interface HardwareState {
  /** The latest answer; while `pending` it may belong to an earlier request. */
  data: HardwareResult | null;
  error: string;
  pending: boolean;
}

/**
 * The shopping list for `body` from the service (no account needed; `online` while it answers): debounced, cached by body, stale requests aborted. It never
 * blocks rendering: until the answer arrives the previous one stays (marked `pending`). A body without printed parts
 * needs nothing and asks nothing.
 */
export function useHardware(body: HardwareRequest | null, online: boolean): HardwareState {
  const key = body?.pieces.length ? JSON.stringify(body) : null;
  const [shown, setShown] = useState<{ key: string; data: HardwareResult | null; error: string } | null>(null);
  useEffect(() => {
    if (!key || !online || answers.has(key)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      apiJson<HardwareResult>('hardware', { body: key, signal: controller.signal }).then(data => {
        if (answers.size >= CACHE_LIMIT) answers.delete(answers.keys().next().value!);
        answers.set(key, data);
        setShown({ key, data, error: '' });
      }).catch(() => { if (!controller.signal.aborted) setShown({ key, data: null, error: HARDWARE_ERROR }); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, online]);
  if (!body) return { data: null, error: '', pending: false };
  if (!key) return { data: EMPTY, error: '', pending: false };
  const cached = answers.get(key);
  if (cached) return { data: cached, error: '', pending: false };
  if (!online) return { data: null, error: HARDWARE_ERROR, pending: false };
  if (shown?.key === key) return { data: shown.data, error: shown.error, pending: false };
  return { data: shown?.data ?? null, error: '', pending: true };
}

/** Lines per category, in category order, with each category's total count. */
export function hardwareGroups(result: HardwareResult) {
  return HARDWARE_CATEGORIES.map(category => {
    const lines = result.lines.filter(line => line.category === category.id);
    return { ...category, lines, total: lines.reduce((sum, line) => sum + line.quantity, 0) };
  }).filter(group => group.lines.length);
}

export const hardwareEmpty = (result: HardwareResult) => !result.lines.length && !result.control.length;

/** The shopping list as plain text (Copy list). */
export function hardwareText(result: HardwareResult, title: string): string {
  if (hardwareEmpty(result)) return `${title}\n\nThis layout needs no extra hardware\n`;
  const blocks = [title];
  if (result.warnings.length) blocks.push(result.warnings.map(warning => `! ${warning}`).join('\n'));
  for (const group of hardwareGroups(result)) blocks.push([`${group.label} (${group.total})`,
    ...group.lines.map(line => `  ${line.quantity} × ${line.name} — ${line.pieces.join(', ')}`)].join('\n'));
  if (result.control.length) blocks.push(['Control gear',
    ...result.control.map(item => `  ${item.quantity} × ${item.name} — ${[item.scope, item.note].filter(Boolean).join('; ')}`)].join('\n'));
  if (result.notes.length) blocks.push(['Notes', ...result.notes.map(note => `- ${note}`)].join('\n'));
  return `${blocks.join('\n\n')}\n`;
}

/** The shopping list as CSV: category,name,quantity,pieces; control gear lists how it is shared in place of pieces. */
export function hardwareCsv(result: HardwareResult): string {
  const label = (id: HardwareCategory) => HARDWARE_CATEGORIES.find(category => category.id === id)?.label ?? id;
  const cell = (value: string | number) => /[",\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);
  const rows = [...result.lines.map(line => [label(line.category), line.name, line.quantity, line.pieces.join('; ')]),
    ...result.control.map(item => [label(item.category), item.name, item.quantity, [item.scope, item.note].filter(Boolean).join('; ')])];
  return [['category', 'name', 'quantity', 'pieces'], ...rows].map(row => row.map(cell).join(',')).join('\n') + '\n';
}
