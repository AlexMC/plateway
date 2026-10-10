import { describe, expect, it } from 'vitest';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { piecePorts, pieceDefinition } from '../src/domain/pieces';
import { fitProject } from '../src/fitting/fit';
import { POWER_GAP, REVERSING_LOOP } from '../src/fitting/electrical';
import { closeGap, openEnds, planGap } from '../src/editor/gap-closer';
import { placePiece, unoccupiedPiecePorts, type TileFamily } from '../src/editor/operations';

const NICKEL_SILVER = { metal: 1 };

/** Snaps each piece onto the open `out` end of the previous one. */
function chain(project: WorkshopProject, pieces: readonly [TileFamily, Record<string, number>?][]): WorkshopProject {
  for (const [family, params] of pieces) {
    const end = unoccupiedPiecePorts(project).find(candidate => candidate.port.id === 'out')?.port ?? { x: 0, y: 0 };
    [project] = placePiece(project, family, { x: end.x, y: end.y, ...(params ? { params } : {}) });
  }
  return project;
}

/** A balloon loop: a left turnout whose straight leg bulbs right, runs round left and is closed back into its branch. */
function balloon(params: Record<string, number> | undefined): WorkshopProject {
  let project = chain(createProject('Balloon'), [['printed_switch_left'], ...[-22.5, -22.5, ...Array(8).fill(22.5)]
    .map((sweep): [TileFamily, Record<string, number>] => ['track_curve', { radius: 448, sweep, ...params }])]);
  const ends = openEnds(project);
  const plan = planGap(project, ends.find(end => end.port.id === 'branch')!, ends.find(end => end.port.id === 'out')!);
  if (!plan.solution.ok) throw new Error(plan.solution.reason);
  [project] = closeGap(project, plan);
  return project;
}

describe('9V metal rails', () => {
  it('makes a track piece electrical end to end only with metal rails', () => {
    const [plain] = placePiece(createProject('Plain'), 'track_straight', { x: 0, y: 0 });
    const [metal] = placePiece(createProject('Metal'), 'track_straight', { x: 0, y: 0, params: NICKEL_SILVER });
    const ports = (project: WorkshopProject) => piecePorts(project.routes[0].pieces[0], project);
    expect(ports(plain).some(port => port.electrical)).toBe(false);
    expect(ports(metal).map(port => port.electrical)).toEqual([true, true]);
    expect(pieceDefinition('track_straight').cad(metal.routes[0].pieces[0], metal)[0].parameters).toMatchObject({ metal: 1, metal_base: 5 });
  });

  it('warns about a reversing loop on powered track, and not on the same loop with printed rails', () => {
    const powered = fitProject(balloon(NICKEL_SILVER));
    expect(powered.issues.filter(issue => issue.code === REVERSING_LOOP)).toHaveLength(1);
    expect(fitProject(balloon(undefined)).issues.some(issue => issue.code === REVERSING_LOOP)).toBe(false);
  });

  it('keeps an oval of metal track free of reversing warnings', () => {
    const oval = chain(createProject('Oval'), Array.from({ length: 16 }, (): [TileFamily, Record<string, number>] =>
      ['track_curve', { radius: 448, sweep: 22.5, ...NICKEL_SILVER }]));
    const fit = fitProject(oval);
    expect(openEnds(oval)).toHaveLength(0);
    expect(fit.issues.some(issue => issue.code === REVERSING_LOOP || issue.code === POWER_GAP)).toBe(false);
  });

  it('counts joints where power stops at printed rails', () => {
    const project = chain(createProject('Mixed'), [['track_straight', NICKEL_SILVER], ['track_straight'], ['track_straight', NICKEL_SILVER]]);
    expect(fitProject(project).issues.find(issue => issue.code === POWER_GAP)?.message).toMatch(/2 joints/);
  });
});
