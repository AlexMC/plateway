import { branchPoints, straightPoints, turnoutDefinition } from './turnout-geometry';

/** The right-hand toe sits just past the left frog (turnout.THREE_WAY_STAGGER): two sets of points in tandem. */
export const THREE_WAY_STAGGER = 184;
const MAIN = THREE_WAY_STAGGER + 256;

/** Three-way (tandem): a left official-shape turnout, then a right one on the main line. */
export const TURNOUT_THREE_WAY = turnoutDefinition({
  family: 'turnout_three_way', label: 'Three-way turnout', params: [],
  states: [{ id: 'straight', label: 'Straight' }, { id: 'left', label: 'Left' }, { id: 'right', label: 'Right' }],
  switches: [{ a: 'main', b: 'left', port: 'in' }, { a: 'main', b: 'right', port: 'in' }], servoSide: () => -1,
  paths: () => {
    const right = branchPoints(40, -1).points.map(point => ({ ...point, x: point.x + THREE_WAY_STAGGER }));
    return [{ id: 'main', from: 'in', to: 'out', points: straightPoints(MAIN), states: ['straight'] },
      { id: 'left', from: 'in', to: 'left', points: branchPoints(40, 1).points, states: ['left'] },
      { id: 'right', from: 'in', to: 'right', points: [{ x: 0, y: 0, z: 0, heading: 0 }, ...right], states: ['right'] }];
  },
  description: () => `R40 branches · ${MAIN / 8}-stud main`,
  run: () => MAIN,
  cad: () => ({})
});
