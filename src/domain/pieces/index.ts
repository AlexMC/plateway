import type { RoutePiece, WorkshopProject } from '../project';
import { portGauge } from '../gauges';
import { CATALOGUE } from './catalogue';
import { PRINTED_TRACK } from './composite';
import { BUFFER_STOP } from './families/buffer';
import { TRACK_CLIMB } from './families/climb';
import { CROSSOVER_FAMILIES } from './families/crossover';
import { FLEX_TPU_TRACK } from './families/flex-tpu';
import { TRACK_CURVE_CROSSING, TRACK_DIAMOND } from './families/diamond';
import { FUNICULAR_PIECE } from './families/funicular';
import { GAP_CLOSER } from './families/gap-closer';
import { TRACK_GAUNTLET } from './families/gauntlet';
import { HELIX_CURVE } from './families/helix';
import { GAUGE_TRACK_FAMILIES } from './families/gauges';
import { KIND_FAMILIES } from './families/kinds';
import { LEVEL_CROSSING } from './families/level-crossing';
import { BRIDGE_FAMILIES } from './families/moving-bridges';
import { MONORAIL_FAMILIES } from './families/monorail';
import { TRACK_RACK } from './families/rack';
import { RERAILER } from './families/rerailer';
import { ROTARY_DUMPER } from './families/rotary-dumper';
import { SLIP_FAMILIES } from './families/slip';
import { STREET_TRACK } from './families/street';
import { TABLE_FAMILIES } from './families/tables';
import { TURNOUT_CURVED } from './families/turnout-curved';
import { TURNOUT_RADIUS } from './families/turnout-radius';
import { TURNOUT_THREE_WAY } from './families/turnout-three-way';
import { TURNOUT_WYE } from './families/turnout-wye';
import { UNCOUPLER } from './families/uncoupler';
import { unavailablePiece } from './families/unavailable';
import { gaugesMate, placePoint } from './geometry';
import type { PieceDefinition, PieceGroup, ShapePath, ShapePoint, ShapePort, StateSpec } from './types';

export type * from './types';
export { FLEX_MAX_BEND, rampRun } from './catalogue';
export { BOTH_ENDS, COMPOSITE_FAMILY, compositeCentreline, compositeLength, compositeParameters, compositeSlice, compositeUnderside, cantAt, paramValue, partUnderside, sliceEnds, splitComposite, tieStations } from './composite';
export { gaugesMate, placePoint } from './geometry';
export { CLIMB_FAMILY, CLIMB_LEVEL_MAX, CLIMB_RISE, climbLevel } from './families/climb';
export { BALLAST_SHOULDER, BRACKET_KEYS, BRACKET_PARAMS, MARKER_COLOURS, MARKER_INSERT_FAMILY, MARKER_SEAT, TRACK_OPTION_KEYS, sliceTrackOptions, trackOptionParams, trackOptions, withTrackOptions } from './families/track-options';
export { TRACK_KINDS, applyChoice, choiceChosen, kindOfFamily, type KindField, type KindRow, type KindShape, type TrackKind } from './families/kinds';

/** Every built-in piece family, in palette order; `pieceDefinitions` adds the community pieces registered at start-up. */
export const PIECE_DEFINITIONS: readonly PieceDefinition[] = [...CATALOGUE, PRINTED_TRACK, ...KIND_FAMILIES, TRACK_CLIMB, GAP_CLOSER,
  BUFFER_STOP, RERAILER, STREET_TRACK, LEVEL_CROSSING, TURNOUT_RADIUS, TURNOUT_CURVED, TURNOUT_WYE, TURNOUT_THREE_WAY,
  ...CROSSOVER_FAMILIES, ...SLIP_FAMILIES, TRACK_DIAMOND, TRACK_CURVE_CROSSING, TRACK_GAUNTLET, HELIX_CURVE, ...TABLE_FAMILIES,
  ...BRIDGE_FAMILIES, UNCOUPLER, ...GAUGE_TRACK_FAMILIES, TRACK_RACK, FLEX_TPU_TRACK, FUNICULAR_PIECE, ...MONORAIL_FAMILIES, ROTARY_DUMPER];
const BY_FAMILY = new Map(PIECE_DEFINITIONS.map(definition => [definition.family, definition]));
export const PIECE_GROUPS: readonly { id: PieceGroup; label: string }[] = [
  { id: 'track', label: 'Track' }, { id: 'junction', label: 'Junctions' }, { id: 'elevation', label: 'Elevation' },
  { id: 'mechanism', label: 'Mechanisms' }, { id: 'scenic', label: 'Scenic' }, { id: 'experimental', label: 'Experimental' },
  { id: 'community', label: 'Community' }
];
/** Community pieces from the library index, in index order (src/domain/library.ts). */
const COMMUNITY: PieceDefinition[] = [];

/** Adds a community piece before any project is parsed (KTD9); a family already registered, built-in or not, is refused. */
export function registerLibraryPiece(definition: PieceDefinition): void {
  if (BY_FAMILY.has(definition.family)) throw new Error(`Piece family ${definition.family} is already registered.`);
  BY_FAMILY.set(definition.family, definition);
  COMMUNITY.push(definition);
}
/** Every registered family, in palette order: the built-in ones, then the community pieces. */
export function pieceDefinitions(): readonly PieceDefinition[] {
  return [...PIECE_DEFINITIONS, ...COMMUNITY];
}

/** Families a parsed project uses that this app does not have (KTD9), each drawn as an "unavailable piece". */
const UNAVAILABLE = new Map<string, PieceDefinition>();

/** A registered family; undefined for unknown ones and for unavailable placeholders. */
export function findPieceDefinition(family: string): PieceDefinition | undefined {
  return BY_FAMILY.get(family);
}
/** A registered family, or the placeholder of an unavailable one a parsed project uses; any other family is a bug. */
export function pieceDefinition(family: string): PieceDefinition {
  const definition = BY_FAMILY.get(family) ?? UNAVAILABLE.get(family);
  if (!definition) throw new Error(`Unknown piece family: ${family}`);
  return definition;
}
/** Lets a project that uses `family`, which this app does not have, open with a placeholder (`parseProject`). */
export function registerUnavailableFamily(family: string): void {
  if (!BY_FAMILY.has(family) && !UNAVAILABLE.has(family)) UNAVAILABLE.set(family, unavailablePiece(family));
}
/** Owned brick definitions, one per official shape, in palette order. */
export const OWNED_DEFINITIONS: readonly PieceDefinition[] = PIECE_DEFINITIONS.filter(definition => definition.source === 'owned');
/** The printed family for an owned official shape, and the owned family for a printed one. */
export function counterpartFamily(family: string, source: 'owned' | 'printed'): string | undefined {
  const definition = pieceDefinition(family);
  if (definition.source === source) return family;
  return source === 'owned' ? definition.owned?.family :
    PIECE_DEFINITIONS.find(other => other.source === 'printed' && other.owned?.family === family)?.family;
}
/** The states a piece offers for its parameters (C4: a turntable's stalls, an elevator's levels); undefined without states. */
export function pieceStates(piece: RoutePiece): readonly StateSpec[] | undefined {
  const definition = pieceDefinition(piece.family);
  return definition.pieceStates?.(piece) ?? definition.states;
}
/** A piece's current state; absent, or no longer offered after a parameter change, means its first state. */
export function pieceState(piece: RoutePiece): string | undefined {
  const states = pieceStates(piece);
  return states?.some(state => state.id === piece.state) ? piece.state : states?.[0]?.id;
}
export function pieceIsAssembly(piece: Pick<RoutePiece, 'family'>): boolean {
  return pieceDefinition(piece.family).body === 'assembly';
}
export function pieceRun(piece: RoutePiece, project: WorkshopProject): number {
  return pieceDefinition(piece.family).run(piece, project);
}
/** World-frame paths for the piece's pose and state. */
export function piecePaths(piece: RoutePiece, project: WorkshopProject): ShapePath[] {
  const definition = pieceDefinition(piece.family), state = pieceState(piece);
  return definition.paths(piece, project).map(path => ({ ...path, gauge: path.gauge ?? definition.gauge,
    enabled: !path.states || state !== undefined && path.states.includes(state),
    points: path.points.map(point => placePoint(piece, point)) }));
}
/** The paths that physically exist in the current state: all but a moving deck's other positions (C4). */
export function physicalPaths<T extends Pick<ShapePath, 'moving' | 'enabled'>>(paths: readonly T[]): T[] {
  return paths.filter(path => !path.moving || path.enabled);
}
/** The state `step` places from the current one, wrapping round (Test drive ◀ ▶ on moving pieces). */
export function stepState(piece: RoutePiece, step: number): string {
  const states = pieceStates(piece);
  if (!states?.length) throw new Error('This piece has no settings.');
  const index = Math.max(0, states.findIndex(state => state.id === pieceState(piece)));
  return states[((index + step) % states.length + states.length) % states.length].id;
}
/**
 * A path's start faces backwards out of the piece; its end faces forwards. A funicular (`cable`) path's ends both mate nothing.
 * A port shared by paths of standard and narrow gauge (a dual-gauge divergence's common end) is dual.
 */
export function portsFromPaths(paths: readonly ShapePath[]): ShapePort[] {
  const ports = new Map<string, ShapePort>();
  for (const path of paths) {
    const start = path.points[0], end = path.points.at(-1)!, electrical = path.electrical ? { electrical: true } : {};
    const gaugeAt = (id: string) => { const seen = ports.get(id); return seen ? portGauge(seen.gauge, path.gauge) : path.gauge; };
    ports.set(path.from, { ...start, id: path.from, heading: start.heading + Math.PI, gauge: gaugeAt(path.from), ...electrical,
      ...(start.pitch === undefined ? {} : { pitch: -start.pitch }), ...(start.roll === undefined ? {} : { roll: -start.roll }),
      ...(path.cable ? { stop: true } : {}) });
    ports.set(path.to, { ...end, id: path.to, gauge: gaugeAt(path.to), ...electrical, ...(path.stop || path.cable ? { stop: true } : {}) });
  }
  return [...ports.values()];
}
export function piecePorts(piece: RoutePiece, project: WorkshopProject): ShapePort[] {
  return portsFromPaths(piecePaths(piece, project));
}
/** Where the next piece of the authored chain starts. */
export function primaryEnd(piece: RoutePiece, project: WorkshopProject): ShapePoint {
  const definition = pieceDefinition(piece.family);
  const local = definition.end?.(piece, project) ?? definition.paths(piece, project).find(path => path.to === 'out')!.points.at(-1)!;
  return placePoint(piece, local);
}
/** Two open ports join when they meet face to face on compatible gauges; a buffer stop's far end joins nothing. */
export function portsMate(a: ShapePort, b: ShapePort, distance: number, angle: number): boolean {
  return !a.stop && !b.stop && Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z) < distance &&
    Math.abs(Math.atan2(Math.sin(a.heading-b.heading-Math.PI), Math.cos(a.heading-b.heading-Math.PI))) < angle && gaugesMate(a.gauge, b.gauge);
}
