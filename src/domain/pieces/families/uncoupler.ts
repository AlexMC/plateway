import type { RoutePiece } from '../../project';
import { paramValue } from '../composite';
import type { ParamSpec, PieceDefinition, StateSpec } from '../types';
import { PRINTED_COLOR } from './composite-piece';
import { straightPoints } from './turnout-geometry';

/**
 * Uncoupler track (cad/models/uncoupler.py): a 128 mm straight whose flap lies flush between the rails or stands
 * about 10 mm above them. Raised, it catches the first wagon's leading bogie while the loco pulls the magnetic
 * coupling apart, and no train passes. The flap turns on the rocker's shaft, which runs under the near rail to a drive
 * beside the track: magnet detents worked by hand, or an SG90 servo with a link.
 */
type XY = { x: number; y: number };
export const UNCOUPLER_FAMILY = 'uncoupler_track';
const LENGTH = 128;
const DRIVE_PARAM: ParamSpec = { key: 'drive', label: 'Drive', unit: '', min: 0, max: 1, step: 1, default: 0,
  options: [{ value: 0, label: 'Magnet/manual' }, { value: 1, label: 'Servo' }] };
const STATES: readonly StateSpec[] = [{ id: 'lowered', label: 'Lowered — trains pass' }, { id: 'raised', label: 'Raised — uncouples' }];
const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
/** Mirrors uncoupler.ENVELOPES: the flap well with the shaft under the near rail, and each drive beside the track. */
export const UNCOUPLER_ENVELOPES = {
  flap: rect(62.4, -23.9, 82.6, 17.7),
  magnet: rect(64, -45, 96, -23.9),
  servo: rect(70, -74, 124, -23.9)
} as const;
const drive = (piece: RoutePiece) => paramValue({ params: [DRIVE_PARAM] }, piece, 'drive') === 1 ? 1 : 0;

export const UNCOUPLER: PieceDefinition = {
  family: UNCOUPLER_FAMILY, label: 'Uncoupler track', group: 'mechanism', source: 'printed', styles: ['detailed', 'fast'],
  params: [DRIVE_PARAM], states: STATES, gauge: 'standard', body: 'assembly', customJoiner: false, color: PRINTED_COLOR,
  description: piece => `16 studs · flap ${drive(piece) ? 'on an SG90 servo' : 'with magnet detents'}`,
  paths: () => [{ id: 'main', from: 'in', to: 'out', points: straightPoints(LENGTH), states: ['lowered'] }],
  run: () => LENGTH,
  halt: () => 'Uncoupler raised — lower it to pass',
  envelopes: piece => [UNCOUPLER_ENVELOPES.flap, drive(piece) ? UNCOUPLER_ENVELOPES.servo : UNCOUPLER_ENVELOPES.magnet].map(polygon => [...polygon]),
  notes: ['Stop with the coupling just past the flap, raise it and drive the loco on: the first wagon\'s leading bogie meets the flap and stays behind. Whether your couplers part cleanly is a physical trial.',
    'The drive stands on the right of in → out, inside the 64 mm gap to a parallel track 16 studs away. Seat the piece on a flat surface.'],
  cad: piece => [{ family: UNCOUPLER_FAMILY, parameters: { drive: drive(piece), switch_state: piece.state === 'raised' ? 1 : 0 } }]
};
