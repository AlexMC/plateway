import type { RoutePiece, WorkshopProject } from '../domain/project';
import { PIECE_DEFINITIONS, pieceDefinition, piecePorts, type ParamSpec } from '../domain/pieces';
import { placePiece, previewPiece, type Placement } from './operations';

/**
 * Siding ladder kit: an editor macro that lays a yard throat from ordinary pieces. The first turnout sits on the
 * incoming track (its straight route is track 1); its branch starts the ladder, a diagonal of opposite-hand
 * turnouts whose branches turn back parallel as the middle tracks; the ladder ends in a curve that becomes the last
 * track. Shortened straights space the ladder so the tracks lie `spacing` apart, and every track is cut to end
 * flush, optionally on a buffer stop. Each piece prints, splits and switches on its own.
 */

export interface LadderOptions {
  /** Left-hand turnout family (its `branch` turns left); its mirror serves the other hand. */
  turnout: string;
  /** Tracks leaving the throat, the straight-through track included. */
  sidings: number;
  /** Centre-to-centre distance between neighbouring tracks, mm. */
  spacing: number;
  /** Straight length of the shortest track before its end, mm. */
  length: number;
  /** +1: tracks fan out to the left of the incoming track; -1: to the right. */
  hand: 1 | -1;
  buffers: boolean;
  style?: 'fast';
}
/** The kit's settings as the palette edits them (`hand` and `buffers` are choices). */
export const LADDER_PARAMS: readonly ParamSpec[] = [
  { key: 'sidings', label: 'Tracks', unit: 'count', min: 2, max: 8, step: 1, default: 4 },
  { key: 'spacing', label: 'Spacing', unit: 'mm', min: 104, max: 256, step: 8, default: 128 },
  { key: 'length', label: 'Shortest track', unit: 'mm', min: 64, max: 2000, step: 8, default: 384 },
  { key: 'hand', label: 'Tracks fan', unit: '', min: -1, max: 1, step: 2, default: 1, options: [{ value: 1, label: 'Left' }, { value: -1, label: 'Right' }] },
  { key: 'buffers', label: 'Buffer stops', unit: '', min: 0, max: 1, step: 1, default: 1, options: [{ value: 1, label: 'Yes' }, { value: 0, label: 'No' }] }
];
/** The closing curve: R40, like the official turnout's own parallel exit. */
const CURVE_RADIUS = 320;
/** `track_straight` length limits; gaps up to JOIN are float noise and dropped. */
const MIN_STRAIGHT = 24, MAX_STRAIGHT = 2000, JOIN = 0.5;

/** Turnout families a ladder can use: printed, left-handed (branch turns left) and mirrored by a right-hand family. */
export function ladderTurnouts(project: WorkshopProject): string[] {
  return PIECE_DEFINITIONS.filter(definition => definition.source === 'printed' && !definition.hidden && definition.mirror !== undefined &&
    piecePorts({ id: 'ladder-probe', family: definition.family, x: 0, y: 0, z: 0, heading: 0 }, project)
      .some(port => port.id === 'branch' && port.y > 0 && port.heading > 0)).map(definition => definition.family);
}

/** One piece of the kit in placement order, starting on a port of an earlier step (null: the drop point). */
export interface LadderStep { family: string; params?: Record<string, number>; at: { step: number; port: string } | null }

/**
 * The ladder's pieces in order. Throws when the spacing does not suit the turnout: neighbouring ladder turnouts
 * would overlap, or a filler would be shorter than the shortest printable straight.
 */
export function planLadder(project: WorkshopProject, options: LadderOptions): LadderStep[] {
  const { sidings, spacing, length, hand, buffers } = options;
  if (!Number.isInteger(sidings) || sidings < 2 || sidings > 8) throw new Error('A ladder has 2 to 8 tracks.');
  const left = options.turnout, right = pieceDefinition(left).mirror;
  if (!right) throw new Error('A ladder needs a turnout with a mirror-image hand.');
  const ports = piecePorts({ id: 'ladder-probe', family: left, x: 0, y: 0, z: 0, heading: 0 }, project);
  const out = ports.find(port => port.id === 'out'), branch = ports.find(port => port.id === 'branch');
  if (!out || !branch || Math.abs(out.y) > 1e-6 || !(branch.y > 0) || !(branch.heading > 0)) throw new Error('A ladder needs a left-hand turnout with a branch.');
  const angle = branch.heading, sin = Math.sin(angle), cos = Math.cos(angle);
  // A ladder turnout's branch turns back by `angle` and starts its track this far across from the turnout's `in`.
  const across = branch.x * sin - branch.y * cos;
  const filler = (gap: number, where: string): number => {
    if (gap < -JOIN) throw new Error(`Spacing too tight for this turnout (${where}).`);
    if (gap > JOIN && gap < MIN_STRAIGHT) throw new Error(`This spacing leaves a ${gap.toFixed(1)} mm gap ${where}; pick another spacing.`);
    return gap > JOIN ? gap : 0;
  };
  const steps: LadderStep[] = [];
  const add = (step: Omit<LadderStep, 'at'>, at: LadderStep['at']) => steps.push({ ...step, at }) - 1;
  // A straight of `len` (as equal pieces within the straight family's 2000 mm limit); returns its last step.
  const straight = (len: number, at: LadderStep['at']): number | null => {
    if (!(len > 0)) return null;
    const count = Math.ceil(len / MAX_STRAIGHT);
    let last = at;
    for (let index = 0; index < count; index++) last = { step: add({ family: 'track_straight', params: { length: len / count } }, last), port: 'out' };
    return last!.step;
  };
  // Each track's start (step and port) and its x in the kit frame (incoming track along +x from the drop point).
  const tracks: { at: NonNullable<LadderStep['at']>; x: number }[] = [];
  const first = add({ family: hand > 0 ? left : right }, null);
  tracks.push({ at: { step: first, port: 'out' }, x: out.x });
  // The ladder runs from the first branch at heading `angle`; `travelled` is the distance to its current tail.
  let tail: NonNullable<LadderStep['at']> = { step: first, port: 'branch' }, travelled = 0;
  for (let track = 1; track < sidings - 1; track++) {
    const gap = filler((track * spacing - across - branch.y) / sin - travelled, `on the ladder before track ${track + 1}`);
    const fill = straight(gap, tail);
    if (fill !== null) tail = { step: fill, port: 'out' };
    const turnout = add({ family: hand > 0 ? right : left }, tail);
    travelled += gap;
    tracks.push({ at: { step: turnout, port: 'branch' }, x: branch.x + travelled * cos + branch.x * cos + branch.y * sin });
    travelled += out.x;
    tail = { step: turnout, port: 'out' };
  }
  const rise = CURVE_RADIUS * (1 - cos), height = branch.y + travelled * sin;
  const gap = filler(((sidings - 1) * spacing - height - rise) / sin, 'before the closing curve');
  const fill = straight(gap, tail);
  if (fill !== null) tail = { step: fill, port: 'out' };
  const curve = add({ family: 'track_curve', params: { radius: CURVE_RADIUS, sweep: -hand * angle * 180 / Math.PI } }, tail);
  tracks.push({ at: { step: curve, port: 'out' }, x: branch.x + (travelled + gap) * cos + CURVE_RADIUS * sin });
  const end = Math.max(...tracks.map(track => track.x)) + length;
  for (const track of tracks) {
    const siding = straight(end - track.x, track.at);
    if (buffers) add({ family: 'buffer_stop' }, siding === null ? track.at : { step: siding, port: 'out' });
  }
  return steps;
}

/** The kit's pieces laid from `start` (the first turnout's `in`), without changing the project. */
export function layLadder(project: WorkshopProject, start: { x: number; y: number; z: number; heading: number }, options: LadderOptions): RoutePiece[] {
  const pieces: RoutePiece[] = [];
  for (const [index, step] of planLadder(project, options).entries()) {
    const pose = step.at === null ? start : piecePorts(pieces[step.at.step], project).find(port => port.id === step.at!.port)!;
    pieces.push({ id: `ladder-${index}`, family: step.family, x: pose.x, y: pose.y, z: pose.z, heading: pose.heading,
      ...(step.params ? { params: step.params } : {}), ...(options.style ? { style: options.style } : {}) });
  }
  return pieces;
}
/** Where the kit lands for a drop: the first turnout snaps like any piece; the rest follow exactly. */
export function previewLadder(project: WorkshopProject, placement: Placement, options: LadderOptions, snapRadius = 30): RoutePiece[] {
  const family = options.hand > 0 ? options.turnout : pieceDefinition(options.turnout).mirror!;
  return layLadder(project, previewPiece(project, family, placement, snapRadius).piece, options);
}
/** Lay the kit; routes merge where their ends meet. Returns the new piece ids in kit order. */
export function placeLadder(project: WorkshopProject, placement: Placement, options: LadderOptions, snapRadius = 30): [WorkshopProject, string[]] {
  const ids: string[] = [];
  let next = project;
  for (const [index, piece] of previewLadder(project, placement, options, snapRadius).entries()) {
    const [after, id] = placePiece(next, piece.family, { x: piece.x, y: piece.y, z: piece.z, heading: piece.heading,
      ...(piece.params ? { params: piece.params } : {}), ...(piece.style ? { style: piece.style } : {}) }, index ? -1 : snapRadius);
    next = after; ids.push(id);
  }
  return [next, ids];
}
