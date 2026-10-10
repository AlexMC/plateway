import { describe, expect, it } from 'vitest';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { TRACK_KINDS, piecePorts, primaryEnd } from '../src/domain/pieces';
import { chainTurn, closesWithOneMore, turnWords } from '../src/editor/chain-turn';
import { placePiece, previewPiece } from '../src/editor/operations';
import { choiceStock, ownedMark } from '../src/editor/palette';
import { firstPlacementView, widenView } from '../src/editor/view-motion';

const kind = (id: string) => TRACK_KINDS.find(item => item.id === id)!;
const DEG = Math.PI / 180;

describe('owned markers on preset chips', () => {
  const stock = (family: string) => ({ brick_curve_r40: { left: 13, total: 16 }, brick_straight_nominal: { left: 0, total: 8 } })[family];
  const chip = (id: string, values: Record<string, number>, label: string) => {
    const choice = kind(id).rows.flatMap(row => row.choices).find(item => item.label === label)!;
    return choiceStock(kind(id), values, choice, stock);
  };

  it('marks only the chips that build an owned brick shape, with the count left', () => {
    const r40 = { radius: 320, sweep: 22.5 };
    expect(chip('curve', r40, 'R40')).toEqual({ left: 13, total: 16 });
    expect(chip('curve', r40, '22.5°')).toEqual({ left: 13, total: 16 });
    expect(chip('curve', r40, 'R56')).toBeNull();
    expect(chip('curve', r40, '11.25°')).toBeNull();
    // A radius chip also sets that radius's sector angle: from R40 · 11.25° the R40 chip is the owned 22.5° curve again.
    expect(chip('curve', { radius: 320, sweep: 11.25 }, 'R40')).toEqual({ left: 13, total: 16 });
    expect(chip('curve', { radius: 320, sweep: 11.25 }, 'R24')).toBeNull();
    expect(chip('curve', { radius: 320, sweep: -11.25 }, '22.5°')).toEqual({ left: 13, total: 16 });
    expect(chip('straight', { length: 64 }, '128')).toEqual({ left: 0, total: 8 });
    expect(chip('straight', { length: 64 }, '64')).toBeNull();
    expect(choiceStock(kind('curve'), r40, kind('curve').rows[0].choices[2], () => ({ left: 0, total: 0 }))).toBeNull();
  });

  it('says how many are left, and when none are', () => {
    expect([ownedMark({ left: 16, total: 16 }), ownedMark({ left: 3, total: 16 }), ownedMark({ left: 0, total: 8 })])
      .toEqual(['16 owned', '3 of 16 owned', 'none left']);
  });
});

/** Lay `families` in one chain from (1000, 600) heading +x; curves turn left. */
function lay(families: readonly ('brick_curve_r40' | 'brick_straight_nominal' | 'brick_switch_left')[]): { project: WorkshopProject; last: string; ids: string[] } {
  let project = createProject('Oval');
  project.inventory.brick_curve_r40 = 16;
  project.inventory.brick_straight_nominal = 8;
  let at = { x: 1000, y: 600, heading: 0 }, last = '';
  const ids: string[] = [];
  for (const family of families) {
    [project, last] = placePiece(project, family, { ...at, ...(family === 'brick_curve_r40' ? { sweep: 22.5 * DEG } : {}) });
    const piece = project.routes.flatMap(route => route.pieces).find(item => item.id === last)!;
    const end = primaryEnd(piece, project);
    at = { x: end.x, y: end.y, heading: end.heading };
    ids.push(last);
  }
  return { project, last, ids };
}
const curves = (count: number) => Array.from({ length: count }, () => 'brick_curve_r40' as const);

describe('turn indicator', () => {
  it('adds up a half oval to 180°, parallel to the start heading back', () => {
    const { project, last } = lay(['brick_straight_nominal', ...curves(8)]);
    const half = chainTurn(project, last, 'out')!;
    expect(half.turn / DEG).toBeCloseTo(180, 6);
    expect(half).toMatchObject({ curved: true, parallel: 'opposite', closed: false });
    expect(half.start).toMatchObject({ x: 1000, y: 600 });
    expect(turnWords(half, false)).toEqual(['180° left of a loop', 'parallel to start · heading back']);

    const quarter = lay(['brick_straight_nominal', ...curves(4)]);
    const turned = chainTurn(quarter.project, quarter.last, 'out')!;
    expect(turned.turn / DEG).toBeCloseTo(90, 6);
    expect(turned.parallel).toBeNull();
  });

  it('counts the snapped ghost as laid', () => {
    const { project } = lay(['brick_straight_nominal', ...curves(7)]);
    const route = project.routes[0], end = primaryEnd(route.pieces.at(-1)!, project);
    const ghost = previewPiece(project, 'brick_curve_r40', { x: end.x + 5, y: end.y, sweep: 22.5 * DEG }, 30);
    expect(ghost.routeId).toBe(route.id);
    const withGhost = chainTurn(project, ghost.piece.id, 'out', [ghost.piece])!;
    expect(withGhost.turn / DEG).toBeCloseTo(180, 6);
    expect(withGhost.parallel).toBe('opposite');
  });

  it('says when one more piece closes the loop, then that it is closed', () => {
    const almost = lay(['brick_straight_nominal', ...curves(8), 'brick_straight_nominal', ...curves(7)]);
    const open = chainTurn(almost.project, almost.last, 'out')!;
    expect(open.turn / DEG).toBeCloseTo(337.5, 6);
    const lastPiece = almost.project.routes[0].pieces.at(-1)!;
    expect(closesWithOneMore(almost.project, open, lastPiece)).toBe(true);
    expect(turnWords(open, true)).toContain('one more piece closes the loop');
    const short = lay(['brick_straight_nominal', ...curves(8), 'brick_straight_nominal', ...curves(6)]);
    const shortEnd = chainTurn(short.project, short.last, 'out')!;
    expect(closesWithOneMore(short.project, shortEnd, short.project.routes[0].pieces.at(-1)!)).toBe(false);

    const loop = lay(['brick_straight_nominal', ...curves(8), 'brick_straight_nominal', ...curves(8)]);
    const closed = chainTurn(loop.project, loop.last, 'out')!;
    expect(closed.closed).toBe(true);
    expect(Math.abs(closed.turn) / DEG).toBeCloseTo(360, 6);
  });
});

describe('turn indicator on a branch', () => {
  /** A left curve laid on the turnout's branch end. */
  const onBranch = ({ project, ids }: ReturnType<typeof lay>, turnoutAt: number) => {
    const turnout = project.routes.flatMap(route => route.pieces).find(piece => piece.id === ids[turnoutAt])!;
    const branch = piecePorts(turnout, project).find(port => port.id === 'branch')!;
    const [next, id] = placePiece(project, 'brick_curve_r40', { x: branch.x, y: branch.y, heading: branch.heading, sweep: 22.5 * DEG });
    return { project: next, id, start: piecePorts(turnout, project).find(port => port.id === 'in')! };
  };

  it('measures a siding off a closed loop from its turnout, not round the loop', () => {
    const loop = lay(['brick_switch_left', ...curves(8), 'brick_straight_nominal', 'brick_straight_nominal', ...curves(8)]);
    expect(chainTurn(loop.project, loop.last, 'out')!.closed).toBe(true);
    const { project, id, start } = onBranch(loop, 0);
    const siding = chainTurn(project, id, 'out')!;
    expect(siding.turn / DEG).toBeCloseTo(45, 6);
    expect(siding).toMatchObject({ closed: false, parallel: null });
    expect(siding.start).toMatchObject({ x: start.x, y: start.y });
    expect(siding.start.heading).toBeCloseTo(0, 6);
    expect(turnWords(siding, false)).toEqual(['45° left of a loop']);
  });

  it('measures a branch off an open chain from its turnout, but the main line through it from the chain start', () => {
    const line = lay(['brick_curve_r40', 'brick_switch_left', 'brick_curve_r40']);
    const { project, id, start } = onBranch(line, 1);
    const branch = chainTurn(project, id, 'out')!;
    expect(branch.turn / DEG).toBeCloseTo(45, 6);
    expect(branch.start).toMatchObject({ x: start.x, y: start.y });
    const main = chainTurn(project, line.last, 'out')!;
    expect(main.turn / DEG).toBeCloseTo(45, 6);
    expect(main.start).toMatchObject({ x: 1000, y: 600 });
  });

  it('stops where a walk rejoins a loop it did not start in', () => {
    // A straight lying over the loop's first straight: walking from it runs round the loop and must stop when it gets back.
    const loop = lay(['brick_straight_nominal', ...curves(8), 'brick_straight_nominal', ...curves(8)]);
    const over = { id: 'over', family: 'brick_straight_nominal', x: 1000, y: 600, z: 0, heading: 0 };
    const walked = chainTurn(loop.project, 'over', 'in', [over])!;
    expect(walked.closed).toBe(false);
    expect(walked.start).toMatchObject({ x: 1128, y: 600 });
  });
});

describe('view motion', () => {
  const view = { x: 0, y: 0, width: 1000, height: 800 }, max = { width: 2800, height: 2500 };

  it('leaves the view alone while the growing end is clear of the edges', () => {
    expect(widenView(view, [{ x: 500, y: 400 }], { aspect: 1.25, manual: false, max })).toBeNull();
    // A wider canvas shows more than the viewBox: a point just outside it but well inside the canvas is fine.
    expect(widenView(view, [{ x: 1050, y: 400 }], { aspect: 2, manual: false, max })).toBeNull();
  });

  it('near the edge pans while the layout still fits, else zooms out keeping the layout in view', () => {
    const panned = widenView(view, [{ x: 960, y: 400 }], { aspect: 1.25, manual: false, max, keep: [{ x: 500, y: 300 }, { x: 960, y: 500 }] })!;
    expect(panned.width).toBeCloseTo(1000, 6);
    expect(panned.x).toBeCloseTo(960 - 800, 6);
    const layout = [{ x: 20, y: 300 }, { x: 960, y: 500 }];
    const next = widenView(view, [{ x: 960, y: 400 }], { aspect: 1.25, manual: false, max, keep: layout })!;
    expect(next.width).toBeGreaterThan(view.width);
    expect(next.width / next.height).toBeCloseTo(1.25, 6);
    expect(960).toBeLessThanOrEqual(next.x + next.width * 0.8 + 1e-6);
    expect(next.x).toBeLessThanOrEqual(20);
  });

  it('after a manual zoom only pans, unless the end has already left the view', () => {
    const layout = [{ x: 20, y: 300 }, { x: 960, y: 500 }];
    const panned = widenView(view, [{ x: 960, y: 400 }], { aspect: 1.25, manual: true, max, keep: layout })!;
    expect(panned.width).toBeCloseTo(1000, 6);
    expect(panned.x).toBeCloseTo(960 - 800, 6);
    const left = widenView(view, [{ x: 1100, y: 400 }], { aspect: 1.25, manual: true, max, keep: layout })!;
    expect(left.width).toBeGreaterThan(1000);
    expect(1100).toBeLessThanOrEqual(left.x + left.width * 0.8 + 1e-6);
  });

  it('never zooms past the furthest-out size', () => {
    const next = widenView(view, [{ x: 0, y: 0 }, { x: 9000, y: 400 }], { aspect: 1.25, manual: false, max })!;
    expect(next.width).toBeLessThanOrEqual(max.width + 1e-6);
  });

  it('frames the first piece no closer than an owned oval, keeping the furniture in view', () => {
    const room = { x: -100, y: -100, width: 2600, height: 2300 }, size = { width: 2400, height: 2100 };
    const piece = [{ x: 1150, y: 1000 }, { x: 1250, y: 1000 }];
    const first = firstPlacementView(room, piece, size);
    expect(first.width).toBe(1600);
    expect(first.x + first.width / 2).toBeCloseTo(1200, 6);
    // A KALLAX against the far wall stays in the frame.
    const shelf = [{ x: 290, y: 1685 }, { x: 2110, y: 2075 }];
    const withShelf = firstPlacementView(room, [...piece, ...shelf], size);
    expect(withShelf.width).toBeGreaterThan(1600);
    expect([withShelf.x <= 290, withShelf.x + withShelf.width >= 2110, withShelf.y + withShelf.height >= 2075, withShelf.y <= 1000]).toEqual([true, true, true, true]);
    // Near a wall it stays inside the room; already zoomed in, it does not zoom out.
    expect(firstPlacementView(room, [{ x: 100, y: 100 }], size)).toMatchObject({ x: -100, y: -100 });
    expect(firstPlacementView({ x: 0, y: 0, width: 900, height: 720 }, [{ x: 600, y: 600 }], size).width).toBe(900);
  });
});
