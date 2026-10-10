import { describe, expect, it } from 'vitest';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { piecePorts, primaryEnd } from '../src/domain/pieces';
import { fitProject } from '../src/fitting/fit';
import { routePath } from '../src/drive/traversal';
import { placePiece, unoccupiedPiecePorts } from '../src/editor/operations';
import { NO_SELECTION, activeVariant, choose, cleanLandings, findJoint, fitsCleanly, intentOf, jointVariants, nearestLanding, otherFacing, otherHand,
  pointerVariant, stepLock, stepSelection, type JointVariant, type LockJoint } from '../src/editor/joint-lock';

const STRAIGHT = 'brick_straight_nominal', CURVE = 'brick_curve_r40', TURNOUT = 'printed_switch_left';
const SNAP = 70, INSERT = 36, MM_PER_PX = 2;
const allPieces = (project: WorkshopProject) => project.routes.flatMap(route => route.pieces);

/** The City set oval, anticlockwise from (600, 400): 4 straights along +x, a half circle, 4 straights back, a half circle. */
function oval(): WorkshopProject {
  let project = createProject('Oval'), at = { x: 600, y: 400, heading: 0 };
  const side = [...Array(4).fill(STRAIGHT), ...Array(8).fill(CURVE)];
  for (const family of [...side, ...side]) {
    const [next, id] = placePiece(project, family, { ...at, ...(family === CURVE ? { sweep: Math.PI / 8 } : {}) });
    project = next;
    const end = primaryEnd(allPieces(project).find(piece => piece.id === id)!, project);
    at = { x: end.x, y: end.y, heading: end.heading };
  }
  return project;
}
/** The pointer `distance` mm from the joint towards a variant's aim. */
const towards = (lock: LockJoint, variant: JointVariant, distance: number) => {
  const dx = variant.aim.x - lock.point.x, dy = variant.aim.y - lock.point.y, length = Math.hypot(dx, dy);
  return { x: lock.point.x + dx / length * distance, y: lock.point.y + dy / length * distance };
};
/** The point off the oval's first straights (y = 400): inside the loop is +y, outside −y. */
const outside = (project: WorkshopProject, variant: JointVariant) => {
  const branch = piecePorts(variant.piece, project).find(port => port.id === 'branch')!;
  return branch.y < 400 - 1;
};

describe('locking the ghost to a joint', () => {
  it('holds the joint under small moves and lets go beyond the snap region plus 40 px', () => {
    const project = oval();
    // Over the second straight, nearer its start joint at x = 728.
    const lock = findJoint(project, TURNOUT, { x: 740, y: 404 }, SNAP, INSERT)!;
    expect(lock).toMatchObject({ kind: 'insert', point: { x: 728, y: 400 } });
    const found = (x: number, y: number) => () => findJoint(project, TURNOUT, { x, y }, SNAP, INSERT);
    // Wandering round the joint, even about midway to the next joint at x = 856, keeps it.
    for (const [x, y] of [[770, 380], [700, 430], [790, 400], [796, 396]])
      expect(stepLock(lock, found(x, y), { x, y }, MM_PER_PX)?.key).toBe(lock.key);
    // Beyond the region and 40 px (80 mm here), the pointer's own joint takes over.
    const away = 728 + SNAP + 40 * MM_PER_PX + 10;
    expect(stepLock(lock, found(away, 401), { x: away, y: 401 }, MM_PER_PX)?.key).not.toBe(lock.key);
    expect(stepLock(lock, found(728, 800), { x: 728, y: 800 }, MM_PER_PX)).toBeNull();
  });

  it('moves to the other end of a straight once the pointer is clearly nearer it, even with both ends inside 40 px', () => {
    const project = placePiece(createProject('Lone straight'), STRAIGHT, { x: 500, y: 500 })[0];
    // Zoomed out: 4 mm a pixel, so the 128 mm straight is 32 px long and the snap radius is the 130 mm cap.
    const scale = 4, snap = 130;
    const found = (x: number) => () => findJoint(project, STRAIGHT, { x, y: 500 }, snap, INSERT);
    const left = stepLock(null, found(503), { x: 503, y: 500 }, scale)!;
    expect(left.point).toMatchObject({ x: 500, y: 500 });
    // 20 mm past the right end: 148 mm from the locked end, well inside its region plus 40 px, but 128 mm nearer the right end.
    const right = stepLock(left, found(648), { x: 648, y: 500 }, scale)!;
    expect(right.point).toMatchObject({ x: 628, y: 500 });
    // Jitter about the middle (never 8 px = 32 mm nearer either end) keeps whichever end holds the lock.
    for (const held of [left, right]) {
      let lock = held;
      for (const x of [556, 572, 560, 568, 564, 571, 557]) lock = stepLock(lock, found(x), { x, y: 500 }, scale)!;
      expect(lock.key).toBe(held.key);
    }
  });
});

describe('variants at a locked joint', () => {
  it('offers a turnout four ways at a straight joint of a closed oval: both hands, facing along and against the loop', () => {
    const project = oval();
    // The middle joint of the four straights, at x = 856: two straights either way.
    const lock = findJoint(project, TURNOUT, { x: 868, y: 404 }, SNAP, INSERT)!;
    expect(lock.point).toMatchObject({ x: 856, y: 400 });
    const variants = jointVariants(project, TURNOUT, { x: 868, y: 404 }, lock);
    expect(variants).toHaveLength(4);
    expect(new Set(variants.map(variant => variant.family))).toEqual(new Set(['printed_switch_left', 'printed_switch_right']));
    expect(new Set(variants.map(variant => variant.facing))).toEqual(new Set(['with', 'against']));
    expect(variants.filter(variant => variant.loopSide === 'out')).toHaveLength(2);
    // Each keeps the loop closed, replacing two straights.
    for (const variant of variants) expect(variant.insert).toMatchObject({ mode: 'replace', gaps: [] });
  });

  it('is one variant for a straight at an open end, whichever end meets it, and two for a curve', () => {
    let project = placePiece(createProject('Line'), STRAIGHT, { x: 600, y: 400 })[0];
    const end = unoccupiedPiecePorts(project).find(({ port }) => port.x > 700)!.port;
    const lock = findJoint(project, STRAIGHT, { x: end.x + 5, y: end.y }, SNAP, INSERT)!;
    expect(lock.kind).toBe('end');
    expect(jointVariants(project, STRAIGHT, { x: end.x + 5, y: end.y }, lock)).toHaveLength(1);
    project = placePiece(project, STRAIGHT, { x: 2000, y: 2000 })[0];
    expect(jointVariants(project, CURVE, { x: end.x, y: end.y, sweep: Math.PI / 8 }, lock).map(variant => variant.side).sort()).toEqual([-1, 1]);
  });

  it('picks the variant whose branch points towards the pointer, and keeps it as the pointer jiggles near the joint', () => {
    const project = oval();
    const lock = findJoint(project, TURNOUT, { x: 740, y: 404 }, SNAP, INSERT)!;
    const variants = jointVariants(project, TURNOUT, { x: 740, y: 404 }, lock);
    for (const variant of variants) expect(pointerVariant(variants, lock, towards(lock, variant, 60), null, MM_PER_PX)).toBe(variant.key);
    const [first, second] = variants;
    // Inside the dead zone the pick stays, wherever the pointer is.
    expect(pointerVariant(variants, lock, towards(lock, second, 10), first.key, MM_PER_PX)).toBe(first.key);
  });

  it('F and Tab step through the variants and stay chosen as the pointer moves a little', () => {
    const project = oval(), pointer = { x: 740, y: 404 };
    const lock = findJoint(project, TURNOUT, pointer, SNAP, INSERT)!;
    const variants = jointVariants(project, TURNOUT, pointer, lock);
    let selection = stepSelection(NO_SELECTION, lock, variants, pointer, MM_PER_PX);
    const shown = activeVariant(selection, variants)!;
    const flipped = otherHand(variants, shown)!;
    expect(flipped).toMatchObject({ facing: shown.facing });
    expect(flipped.family).not.toBe(shown.family);
    selection = choose(selection, flipped);
    selection = stepSelection(selection, lock, variants, { x: pointer.x + 3, y: pointer.y - 2 }, MM_PER_PX);
    expect(activeVariant(selection, variants)!.key).toBe(flipped.key);
    const turned = otherFacing(variants, flipped, 1)!;
    expect(turned).toMatchObject({ hand: flipped.hand });
    expect(turned.facing).not.toBe(flipped.facing);
  });

  it('carries the choice to the next joint as a direction relative to the track: branch outside the loop stays outside', () => {
    const project = oval();
    const lockA = findJoint(project, TURNOUT, { x: 740, y: 404 }, SNAP, INSERT)!;
    const atA = jointVariants(project, TURNOUT, { x: 740, y: 404 }, lockA);
    const wanted = atA.find(variant => variant.loopSide === 'out' && variant.facing === 'with')!;
    expect(outside(project, wanted)).toBe(true);
    let selection = stepSelection(NO_SELECTION, lockA, atA, { x: 760, y: 380 }, MM_PER_PX);
    selection = choose(selection, wanted);
    // The pointer leaves for the next joint along, at x = 856, pointing inside the loop on its way out of the first joint's region.
    for (const x of [760, 800, 840]) selection = stepSelection(selection, lockA, atA, { x, y: 430 }, MM_PER_PX);
    expect(activeVariant(selection, atA)!.loopSide).toBe('in');
    const lockB = findJoint(project, TURNOUT, { x: 868, y: 404 }, SNAP, INSERT)!;
    expect(lockB.key).not.toBe(lockA.key);
    const atB = jointVariants(project, TURNOUT, { x: 868, y: 404 }, lockB);
    selection = stepSelection(selection, lockB, atB, { x: 868, y: 404 }, MM_PER_PX);
    const shown = activeVariant(selection, atB)!;
    expect(shown).toMatchObject({ loopSide: 'out', facing: 'with', family: wanted.family });
    expect(outside(project, shown)).toBe(true);
  });

  it('still offers all four ways once the loop has a turnout, and one laid against the route keeps the loop closed and drivable', () => {
    let project = oval();
    const first = findJoint(project, TURNOUT, { x: 868, y: 404 }, SNAP, INSERT)!;
    const along = jointVariants(project, TURNOUT, { x: 868, y: 404 }, first).find(variant => variant.facing === 'with' && variant.loopSide === 'out')!;
    project = along.insert!.next;
    // The far straights run back along y = 1040; their middle joint is at x = 856 again.
    const lock = findJoint(project, TURNOUT, { x: 868, y: 1036 }, SNAP, INSERT)!;
    const variants = jointVariants(project, TURNOUT, { x: 868, y: 1036 }, lock);
    expect(variants).toHaveLength(4);
    const against = variants.find(variant => variant.facing === 'against' && variant.loopSide === 'out')!;
    expect(against.insert).toMatchObject({ mode: 'replace', gaps: [] });
    const next = against.insert!.next;
    expect(allPieces(next).filter(piece => piece.family.includes('switch'))).toHaveLength(2);
    expect(allPieces(next).filter(piece => piece.family === STRAIGHT)).toHaveLength(4);
    // Only the two branches are open, and a train runs the whole lap.
    expect(unoccupiedPiecePorts(next).map(({ port }) => port.id).sort()).toEqual(['branch', 'branch']);
    const fit = fitProject(next);
    for (const route of next.routes) expect(routePath(fit.sections, route.id).gap).toBeNull();
    expect(routePath(fit.sections, next.routes[0].id).sections.length).toBeGreaterThanOrEqual(22);
  });

  it('moves a piece that would push track along to the nearest joint where it fits cleanly, keeping its way', () => {
    const project = oval();
    // At x = 728, facing back along the loop, only one straight lies behind: it would push half the loop along.
    const lock = findJoint(project, TURNOUT, { x: 740, y: 396 }, SNAP, INSERT)!;
    const wanted = jointVariants(project, TURNOUT, { x: 0, y: 0 }, lock).find(variant => variant.facing === 'against' && variant.loopSide === 'out')!;
    expect(wanted.insert).toMatchObject({ mode: 'insert' });
    expect(fitsCleanly(wanted)).toBe(false);
    const landing = nearestLanding(cleanLandings(project, TURNOUT, { x: 0, y: 0 }, lock, intentOf(wanted)), { x: 740, y: 396 })!;
    expect(landing.steps).toBe(1);
    expect(landing.lock.point).toMatchObject({ x: 856, y: 400 });
    expect(landing.variant).toMatchObject({ family: wanted.family, facing: 'against', loopSide: 'out' });
    const plan = landing.variant.insert!;
    expect(plan).toMatchObject({ mode: 'replace', gaps: [], shifted: [] });
    expect(plan.removed.map(piece => piece.family)).toEqual([STRAIGHT, STRAIGHT]);
    expect(unoccupiedPiecePorts(plan.next).map(({ port }) => port.id)).toEqual(['branch']);
    expect(allPieces(plan.next).filter(piece => piece.family === STRAIGHT)).toHaveLength(6);
  });

  it('keeps the gap preview where no joint within reach fits cleanly (a circle of curves)', () => {
    let project = createProject('Circle'), at = { x: 1000, y: 400, heading: 0 };
    for (let index = 0; index < 16; index++) {
      const [next, id] = placePiece(project, CURVE, { ...at, sweep: Math.PI / 8 });
      project = next;
      const end = primaryEnd(allPieces(project).find(piece => piece.id === id)!, project);
      at = { x: end.x, y: end.y, heading: end.heading };
    }
    expect(unoccupiedPiecePorts(project)).toEqual([]);
    const lock = findJoint(project, TURNOUT, { x: 1010, y: 402 }, SNAP, INSERT)!;
    const variants = jointVariants(project, TURNOUT, { x: 0, y: 0 }, lock);
    expect(variants.length).toBeGreaterThan(1);
    for (const variant of variants) {
      expect(variant.insert!.gaps).toHaveLength(1);
      expect(cleanLandings(project, TURNOUT, { x: 0, y: 0 }, lock, intentOf(variant))).toEqual([]);
    }
  });

  it('puts a turntable into an oval straight over three straights with a printed spacer, nothing moving; moving the track on stays a way', () => {
    const project = oval();
    const lock = findJoint(project, 'turntable', { x: 612, y: 404 }, SNAP, INSERT)!;
    expect(lock.point).toMatchObject({ x: 600, y: 400 });
    const variants = jointVariants(project, 'turntable', { x: 0, y: 0 }, lock);
    const spaced = variants.find(variant => variant.facing === 'with' && variant.fill === 'spacer')!;
    const plan = spaced.insert!;
    expect(plan).toMatchObject({ mode: 'replace', gaps: [], shifted: [] });
    expect(plan.removed.map(piece => piece.family)).toEqual([STRAIGHT, STRAIGHT, STRAIGHT]);
    expect(plan.spacer!.params!.length).toBeCloseTo(48);
    expect(plan.next.routes).toHaveLength(1);
    expect(allPieces(plan.next).filter(piece => piece.family === STRAIGHT)).toHaveLength(5);
    // The loop stays closed: only the turntable's stall tracks are open.
    expect(unoccupiedPiecePorts(plan.next).every(({ part }) => part.id === plan.pieceId)).toBe(true);
    expect(unoccupiedPiecePorts(plan.next).map(({ port }) => port.id)).not.toContain('out');
    // Tab still offers moving the track on instead, with its 336 mm gap.
    const shifted = otherFacing(variants, spaced, 1)!;
    expect(shifted).toMatchObject({ facing: 'with', fill: 'shift' });
    expect(shifted.insert).toMatchObject({ mode: 'insert' });
    expect(shifted.insert!.gaps[0].distance).toBeCloseTo(336);
    const kept = activeVariant(choose(stepSelection(NO_SELECTION, lock, variants, { x: 612, y: 404 }, MM_PER_PX), shifted), variants);
    expect(kept!.key).toBe(shifted.key);
  });

  it('adds no spacer to plain track: a shorter straight still moves the loop on', () => {
    const project = oval();
    const lock = findJoint(project, 'track_straight', { x: 612, y: 404 }, SNAP, INSERT)!;
    const [variant] = jointVariants(project, 'track_straight', { x: 0, y: 0, params: { length: 64 } }, lock);
    expect(variant.insert).toMatchObject({ mode: 'insert' });
    expect(variant.insert!.spacer).toBeUndefined();
  });
});
