import type { RoutePiece } from '../../project';
import { BRICK_TRACK } from '../../track';
import { tieStations } from '../composite';
import { RACK_OPTION_KEYS, sliceRackOptions } from '../rack-teeth';
import type { CadPart, CompositeTrack, Gauge, ParamSpec } from '../types';

export const MARKER_INSERT_FAMILY = 'marker_insert';
/**
 * Colours the Bluetooth colour & distance sensor (88007) reports reliably in COLOR mode, by its colour id.
 * Black (0) is the grey sleeper's own reading, so it is never a marker.
 */
export const MARKER_COLOURS: readonly { value: number; label: string; hex: string }[] = [
  { value: 10, label: 'White', hex: '#f4f4f4' }, { value: 9, label: 'Red', hex: '#c91a09' },
  { value: 7, label: 'Yellow', hex: '#f2cd37' }, { value: 5, label: 'Green', hex: '#237841' },
  { value: 3, label: 'Blue', hex: '#0055bf' }
];
/** Ballast shoulders stand this far outside each body edge (composite.BALLAST toe), mm. */
export const BALLAST_SHOULDER = 8;
/** Default marker station: the middle full tie of a 128 mm straight. */
const MARKER_AT = 64;
/**
 * The `composite_track` option keys (C2); the `socket` keys are a helix piece's column lug, `gauge` a narrow/dual piece's,
 * `metal`/`metal_base` 9V rails and `led` the light channel (cad/models/track_power.py), `rack*` a rack railway's teeth.
 */
export const TRACK_OPTION_KEYS: readonly string[] = ['ballast', 'guard_rail', 'street', 'marker', 'marker_s', 'socket', 'socket_s', 'socket_side', 'socket_offset', 'gauge', 'metal', 'metal_base', 'led', ...RACK_OPTION_KEYS];
/** 9V rails (`metal`): 1 nickel-silver code 250 rail inserts, 2 copper tape on the printed rails. */
export const METAL_RAIL = 1, COPPER_TAPE = 2;
/** LED strip widths (mm) by `led` value (track_power.LED_STRIPS). */
export const LED_STRIPS: Readonly<Record<number, number>> = { 1: 8, 2: 10 };
/** Wall/shelf bracket settings of plain printed track (not CAD options of the track itself: fit places bracket parts). */
export const BRACKET_KEYS: readonly string[] = ['bracket', 'bracket_side', 'bracket_reach', 'bracket_spacing', 'bracket_height'];
const BRACKETED = { key: 'bracket', values: [1, 2] } as const;
/** Bracket choice and its settings; the settings show once a bracket is chosen. */
export const BRACKET_PARAMS: readonly ParamSpec[] = [
  { key: 'bracket', label: 'Brackets', unit: '', min: 0, max: 2, step: 1, default: 0,
    options: [{ value: 0, label: 'None' }, { value: 1, label: 'Wall brackets' }, { value: 2, label: 'Shelf brackets' }] },
  { key: 'bracket_side', label: 'Wall side', unit: '', min: -1, max: 1, step: 2, default: 1, when: BRACKETED,
    options: [{ value: 1, label: 'Left' }, { value: -1, label: 'Right' }] },
  { key: 'bracket_reach', label: 'Wall to track centre', unit: 'mm', min: 48, max: 150, step: 4, default: 72, when: BRACKETED },
  { key: 'bracket_spacing', label: 'Bracket every', unit: 'mm', min: 64, max: 512, step: 32, default: 256, when: BRACKETED },
  { key: 'bracket_height', label: 'Track above shelf', unit: 'mm', min: 10, max: 120, step: 1, default: 16, when: { key: 'bracket', values: [2] } }
];
const ON_OFF = [{ value: 0, label: 'Off' }, { value: 1, label: 'On' }];
const toggle = (key: string, label: string): ParamSpec => ({ key, label, unit: '', min: 0, max: 1, step: 1, default: 0, options: ON_OFF });

/**
 * Track options for plain printed track; guard rails are offered on curved pieces only, neither they nor street on narrow/dual gauge.
 * 9V rails and the LED channel are standard gauge only (experimental); street buries the rails, so 9V rails show without it.
 */
export function trackOptionParams(curved: boolean, gauge: Gauge = 'standard'): ParamSpec[] {
  const standard = gauge === 'standard';
  return [
    toggle('ballast', 'Ballast'),
    ...(curved && standard ? [toggle('guard_rail', 'Guard rail')] : []),
    ...(standard ? [toggle('street', 'Street')] : []),
    { key: 'marker', label: 'Colour marker', unit: '', min: 0, max: 10, step: 1, default: 0,
      options: [{ value: 0, label: 'None' }, ...MARKER_COLOURS.map(({ value, label }) => ({ value, label }))] },
    { key: 'marker_s', label: 'Marker at', unit: 'mm', min: 0, max: 2000, step: 8, default: MARKER_AT },
    ...(standard ? [
      { key: 'metal', label: '9 V metal rails (experimental)', unit: '', min: 0, max: 2, step: 1, default: 0, when: { key: 'street', values: [0] },
        options: [{ value: 0, label: 'Printed' }, { value: METAL_RAIL, label: 'Nickel-silver code 250' }, { value: COPPER_TAPE, label: 'Copper tape' }] },
      { key: 'metal_base', label: 'Rail foot width', unit: 'mm', min: 4, max: 6.5, step: 0.05, default: 5, when: { key: 'metal', values: [METAL_RAIL] } },
      { key: 'led', label: 'LED light channel (experimental)', unit: '', min: 0, max: 2, step: 1, default: 0,
        options: [{ value: 0, label: 'None' }, { value: 1, label: '8 mm strip' }, { value: 2, label: '10 mm strip' }] }
    ] satisfies ParamSpec[] : [])
  ];
}

/** The `composite_track` option parameters a piece asks for (C2); street already has flangeways, so it wins over a guard rail. */
export function trackOptions(piece: Pick<RoutePiece, 'params'>): Record<string, number> {
  const given = piece.params ?? {}, options: Record<string, number> = {};
  if (given.ballast) options.ballast = 1;
  if (given.street) options.street = 1;
  else if (given.guard_rail) options.guard_rail = 1;
  if (given.marker) { options.marker = given.marker; options.marker_s = given.marker_s ?? MARKER_AT; }
  if (given.metal && !given.street) { options.metal = given.metal; if (given.metal === METAL_RAIL) options.metal_base = given.metal_base ?? 5; }
  if (given.led) options.led = given.led;
  return options;
}

/** The piece's rails are 9V metal (its paths and ports are `electrical`). */
export function hasMetalRails(piece: Pick<RoutePiece, 'params'>): boolean {
  return Boolean(trackOptions(piece).metal);
}

/** Adds the piece's options to its track part (the first) and a coloured insert part for a marker. */
export function withTrackOptions(piece: Pick<RoutePiece, 'params'>, [track, ...rest]: readonly CadPart[]): CadPart[] {
  const options = trackOptions(piece);
  return [{ ...track, parameters: { ...track.parameters, ...options } }, ...rest,
    ...(options.marker ? [{ family: MARKER_INSERT_FAMILY, parameters: { marker: options.marker } }] : [])];
}

export function markerColour(id: number): string {
  return MARKER_COLOURS.find(colour => colour.value === id)?.label ?? `Colour ${id}`;
}

/**
 * Options for each bed-sized slice of a split composite (`cuts` from splitComposite): every slice keeps the
 * shape options; the marker goes to the one slice holding the chosen full tie, with `marker_s` local to it.
 * `station` is the marker tie's centre on the parent; null `station` means no full tie survives the cuts.
 * A column socket goes to the slice holding its station, on that slice's own full tie nearest to it (as the CAD
 * picks it); `socket.station` is where the lug really is on the parent. Rack teeth keep the parent's spacing and phase
 * (`track`, the parent's profile, measures where each slice starts along the slope).
 */
export function sliceTrackOptions(options: Record<string, number>, length: number, cuts: readonly number[], track?: CompositeTrack):
  { slices: Record<string, number>[]; marker: { slice: number; station: number } | null; socket: { slice: number; station: number } | null } {
  const { marker, marker_s: at = MARKER_AT, socket, socket_s: socketAt = 0, socket_side: side = 1, socket_offset: offset = 0, ...shape } = options;
  const racks = shape.rack && track ? sliceRackOptions(shape, track, cuts) : null;
  const slices = cuts.slice(1).map((_, index) => ({ ...shape, ...racks?.[index] }));
  let lug: { slice: number; station: number } | null = null;
  if (socket) {
    const slice = Math.max(0, cuts.findIndex((cut, index) => index > 0 && socketAt < cut) - 1);
    const local = tieStations(cuts[slice + 1] - cuts[slice]);
    if (local.length) {
      const tie = local.reduce((best, station) => Math.abs(station - (socketAt - cuts[slice])) < Math.abs(best - (socketAt - cuts[slice])) ? station : best);
      slices[slice] = { ...slices[slice], socket, socket_s: tie, socket_side: side, socket_offset: offset };
      lug = { slice, station: cuts[slice] + tie };
    }
  }
  if (!marker) return { slices, marker: null, socket: lug };
  // A cut turns the tie at that station into two half ties, so only uncut full ties can carry a marker.
  const ties = tieStations(length).filter(station => !cuts.some(cut => Math.abs(cut - station) < 1e-6));
  if (!ties.length) return { slices, marker: null, socket: lug };
  const station = ties.reduce((best, tie) => Math.abs(tie - at) < Math.abs(best - at) ? tie : best);
  const slice = cuts.findIndex((cut, index) => index > 0 && station < cut) - 1;
  slices[slice] = { ...slices[slice], marker, marker_s: station - cuts[slice] };
  return { slices, marker: { slice, station }, socket: lug };
}

/** Height of a marker insert's underside above the track datum: it sits in the tie-top recess. */
export const MARKER_SEAT = BRICK_TRACK.baseThickness;
