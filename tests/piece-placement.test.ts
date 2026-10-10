import { describe, expect, it } from 'vitest';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { piecePorts, primaryEnd } from '../src/domain/pieces';
import { fitProject } from '../src/fitting/fit';
import { routePath } from '../src/drive/traversal';
import { flipPiece, insertPiece, pieceRotation, placePiece, previewInsert, previewPiece, rotatePiece, unoccupiedPiecePorts } from '../src/editor/operations';

const STRAIGHT = 'brick_straight_nominal', CURVE = 'brick_curve_r40';
const allPieces = (project: WorkshopProject) => project.routes.flatMap(route => route.pieces);
const count = (project: WorkshopProject, family: string) => allPieces(project).filter(piece => piece.family === family).length;

/** Lay `families` end to end from (x, y), each on the previous piece's end; curves turn left. */
function lay(project: WorkshopProject, families: readonly string[], x = 600, y = 400): WorkshopProject {
  let at = { x, y, heading: 0 };
  for (const family of families) {
    const [next, id] = placePiece(project, family, { ...at, ...(family === CURVE ? { sweep: Math.PI / 8 } : {}) });
    project = next;
    const end = primaryEnd(allPieces(project).find(piece => piece.id === id)!, project);
    at = { x: end.x, y: end.y, heading: end.heading };
  }
  return project;
}
/** The City set oval: 4 straights, a half circle of 8 R40 curves, 4 straights, another half circle. */
function oval(): WorkshopProject {
  const project = createProject('Oval');
  project.inventory[STRAIGHT] = 8; project.inventory[CURVE] = 16;
  const side = [...Array(4).fill(STRAIGHT), ...Array(8).fill(CURVE)];
  return lay(project, [...side, ...side]);
}
/** A point `t` of the way along a placed piece's chord. */
function along(project: WorkshopProject, index: number, t: number) {
  const piece = project.routes[0].pieces[index], end = primaryEnd(piece, project);
  return { x: piece.x + (end.x - piece.x) * t, y: piece.y + (end.y - piece.y) * t };
}

describe('inserting into placed track', () => {
  it('drops a turnout over two straights of a closed oval: the loop stays closed and both straights go back to stock', () => {
    const project = oval();
    expect(unoccupiedPiecePorts(project)).toEqual([]);
    const plan = previewInsert(project, 'printed_switch_left', along(project, 1, 0.2), 40)!;
    expect(plan.mode).toBe('replace');
    expect(plan.removed.map(piece => piece.family)).toEqual([STRAIGHT, STRAIGHT]);
    expect(plan.gaps).toEqual([]);
    const [next, id] = insertPiece(project, 'printed_switch_left', along(project, 1, 0.2), 40);
    expect(next.routes).toHaveLength(1);
    expect(next.routes[0].pieces).toHaveLength(23);
    expect(count(next, STRAIGHT)).toBe(6);
    expect(project.inventory[STRAIGHT] - count(next, STRAIGHT)).toBe(2);
    // Only the turnout's branch is open: the main line runs round the loop.
    expect(unoccupiedPiecePorts(next).map(({ part, port }) => [part.id, port.id])).toEqual([[id, 'branch']]);
    // Test drive runs the whole lap through the turnout set straight, back onto its own points.
    const lap = routePath(fitProject(next).sections, next.routes[0].id);
    expect(lap.gap).toBeNull();
    expect(lap.sections).toHaveLength(23);
  });
  it('inserting a shorter piece moves half the loop along and reports the gap it opens on the far side', () => {
    const project = oval();
    const plan = previewInsert(project, 'track_straight', { ...along(project, 1, 0.2), params: { length: 64 } }, 40)!;
    expect(plan.mode).toBe('insert');
    expect(plan.removed).toEqual([]);
    expect(plan.shifted).toHaveLength(12);
    expect(plan.gaps).toHaveLength(1);
    expect(plan.gaps[0].distance).toBeCloseTo(64);
    expect(unoccupiedPiecePorts(plan.next)).toHaveLength(2);
    expect(plan.next.routes).toHaveLength(1);
    expect(plan.next.routes[0].pieces).toHaveLength(25);
  });

  it('inserting into an open chain shifts the following pieces and leaves no gap', () => {
    const project = lay(createProject('Line'), [STRAIGHT, STRAIGHT, STRAIGHT]);
    const third = project.routes[0].pieces[2];
    const plan = previewInsert(project, CURVE, { ...along(project, 1, 0.9), sweep: Math.PI / 8 }, 40)!;
    expect(plan.mode).toBe('insert');
    expect(plan.gaps).toEqual([]);
    expect(plan.next.routes[0].pieces.map(piece => piece.family)).toEqual([STRAIGHT, STRAIGHT, CURVE, STRAIGHT]);
    const moved = plan.next.routes[0].pieces[3];
    expect(moved.id).toBe(third.id);
    expect(moved.heading).toBeCloseTo(Math.PI / 8);
    expect(unoccupiedPiecePorts(plan.next)).toHaveLength(2);
  });
});

describe('turning a placed piece', () => {
  it('flips a curve inside a chain in place: it starts where it did and the chain follows its new end', () => {
    const project = lay(createProject('Chain'), [STRAIGHT, CURVE, STRAIGHT]);
    const [first, curve] = project.routes[0].pieces;
    const flipped = flipPiece(project, curve.id);
    const [after, mirrored, last] = flipped.routes[0].pieces;
    expect(after).toEqual(first);
    expect(mirrored).toMatchObject({ x: curve.x, y: curve.y, heading: curve.heading });
    expect(mirrored.sweep).toBeCloseTo(-Math.PI / 8);
    expect(last.heading).toBeCloseTo(-Math.PI / 8);
    expect(unoccupiedPiecePorts(flipped)).toHaveLength(2);
  });

  it('flips a chain\'s first piece about the joint holding it, leaving the rest of the chain where it is', () => {
    const project = lay(createProject('Lead curve'), [CURVE, STRAIGHT, STRAIGHT]);
    const [curve, ...rest] = project.routes[0].pieces;
    const flipped = flipPiece(project, curve.id);
    expect(flipped.routes[0].pieces.slice(1)).toEqual(rest);
    const end = primaryEnd(flipped.routes[0].pieces[0], flipped);
    expect(end.x).toBeCloseTo(rest[0].x);
    expect(end.y).toBeCloseTo(rest[0].y);
    expect(unoccupiedPiecePorts(flipped)).toHaveLength(2);
  });

  it('rotates only a chain\'s end piece, about its joint, and refuses a piece joined at both ends', () => {
    const project = lay(createProject('Turn end'), [STRAIGHT, STRAIGHT, STRAIGHT]);
    const [first, middle, last] = project.routes[0].pieces;
    expect(pieceRotation(project, middle.id)).toHaveProperty('reason');
    expect(() => rotatePiece(project, middle.id, Math.PI / 8)).toThrow(/both ends/);
    const turned = rotatePiece(project, last.id, Math.PI / 8);
    const pieces = allPieces(turned), moved = pieces.find(piece => piece.id === last.id)!;
    expect(pieces.find(piece => piece.id === first.id)).toEqual(first);
    expect(pieces.find(piece => piece.id === middle.id)).toEqual(middle);
    expect(moved.x).toBeCloseTo(last.x);
    expect(moved.y).toBeCloseTo(last.y);
    expect(moved.heading).toBeCloseTo(Math.PI / 8);
    // Turned back (Shift+R) it meets the chain again and rejoins its route.
    const back = rotatePiece(turned, last.id, -Math.PI / 8);
    expect(back.routes).toHaveLength(1);
    expect(back.routes[0].pieces.map(piece => piece.id)).toEqual([first.id, middle.id, last.id]);
  });
});

describe('choosing how a piece attaches', () => {
  it('cycles which end of a turnout meets the open end, and places the chosen one', () => {
    const project = lay(createProject('Siding'), [STRAIGHT]);
    const end = primaryEnd(project.routes[0].pieces[0], project);
    const near = { x: end.x + 4, y: end.y + 2 };
    const first = previewPiece(project, 'printed_switch_left', near);
    expect(first).toMatchObject({ ownPortId: 'in', edge: 'end', attachment: 0 });
    expect(first.attachments).toBeGreaterThanOrEqual(3);
    const second = previewPiece(project, 'printed_switch_left', near, 30, undefined, 1);
    expect(second.ownPortId).not.toBe('in');
    const [placed, id] = placePiece(project, 'printed_switch_left', near, 30, 1);
    const turnout = allPieces(placed).find(piece => piece.id === id)!;
    const mated = piecePorts(turnout, placed).find(port => port.id === second.ownPortId)!;
    expect(mated.x).toBeCloseTo(end.x);
    expect(mated.y).toBeCloseTo(end.y);
    expect(unoccupiedPiecePorts(placed).some(({ part, port }) => part.id === id && port.id === second.ownPortId)).toBe(false);
    // Tab wraps round to the first way again.
    expect(previewPiece(project, 'printed_switch_left', near, 30, undefined, first.attachments).ownPortId).toBe('in');
  });
});
