import { BRICK_LAYOUT } from '../domain/track';
import { COMPOSITE_FAMILY, PIECE_DEFINITIONS } from '../domain/pieces';
import { FLEX_TPU_FAMILY } from '../domain/pieces/families/flex-tpu';

export interface Family {
  id: string;
  source: 'owned' | 'printed';
  kind: 'straight' | 'transition' | 'curve' | 'assembly' | 'composite';
  /** Horizontal run bounds in mm. Owned brick pieces have a fixed nominal run. */
  run: readonly [number, number];
  /** Absolute vertical grade, not a physical traction rating. */
  maxGrade: number;
  radius?: readonly [number, number];
  maxSweep?: number;
  /** Only sources with a current generator may claim CAD availability. */
  geometryAvailable: boolean;
  /** Composite parts printed straight and bent on site (flexible track): fit checks the bed against their straight length. */
  printsStraight?: boolean;
}

export const FAMILIES: readonly Family[] = [
  { id: 'brick_straight_nominal', source: 'owned', kind: 'straight', run: [BRICK_LAYOUT.straightLength, BRICK_LAYOUT.straightLength], maxGrade: 0, geometryAvailable: false },
  { id: 'brick_curve_r40', source: 'owned', kind: 'curve', run: [BRICK_LAYOUT.curveRadius*BRICK_LAYOUT.curveSweep, BRICK_LAYOUT.curveRadius*BRICK_LAYOUT.curveSweep], maxGrade: 0, radius: [BRICK_LAYOUT.curveRadius,BRICK_LAYOUT.curveRadius], maxSweep: BRICK_LAYOUT.curveSweep, geometryAvailable: false },
  { id: 'printed_straight', source: 'printed', kind: 'straight', run: [32, 220], maxGrade: 0, geometryAvailable: true },
  { id: 'vertical_transition', source: 'printed', kind: 'transition', run: [32, 220], maxGrade: 0.06, geometryAvailable: true },
  { id: 'bridge_deck', source: 'printed', kind: 'straight', run: [32, 220], maxGrade: 0, geometryAvailable: true },
  { id: 'printed_curve', source: 'printed', kind: 'curve', run: [32, 400], maxGrade: 0, radius: [240, 1200], maxSweep: Math.PI / 2, geometryAvailable: true },
  { id: 'buffer_stop', source: 'printed', kind: 'straight', run: [32, 64], maxGrade: 0, geometryAvailable: true },
  { id: 'rerailer', source: 'printed', kind: 'straight', run: [64, 128], maxGrade: 0, geometryAvailable: true }
  ,...PIECE_DEFINITIONS.filter(definition=>definition.body==='assembly').map(definition=>({
    id:definition.family, source:definition.source==='owned'?'owned' as const:'printed' as const,
    kind:'assembly' as const, run:[1,1024] as const,maxGrade:0,geometryAvailable:definition.source==='printed'
  })),
  /** Plain printed track of any shape; fit splits it into bed-sized parts at tie stations. */
  { id: COMPOSITE_FAMILY, source: 'printed', kind: 'composite', run: [24, 2000], maxGrade: 0.06, geometryAvailable: true },
  /** Flexible TPU-spine track: level composite strips printed straight. */
  { id: FLEX_TPU_FAMILY, source: 'printed', kind: 'composite', run: [32, 2000], maxGrade: 0, geometryAvailable: true, printsStraight: true }
];
