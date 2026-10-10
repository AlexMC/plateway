import { describe, expect, it } from 'vitest';
import type { WorkshopProject } from '../src/domain/project';
import { placeFurniture } from '../src/editor/furniture';
import { placePiece, removePiece, unoccupiedPiecePorts } from '../src/editor/operations';
import { createStandardProject, setSetupInventory, setSetupMeasurement } from '../src/editor/setup-defaults';
import { START_EXAMPLES, exampleBase, exampleFacts, pickExample, startScreenShown } from '../src/editor/start-examples';

const example = (id: string) => START_EXAMPLES.find(item => item.id === id)!;
const pieces = (project: WorkshopProject) => project.routes.flatMap(route => route.pieces);

describe('Build start screen', () => {
  it('shows only while the project has no track and Build by hand was not chosen', () => {
    const empty = createStandardProject('Empty');
    expect(startScreenShown(empty, false)).toBe(true);
    expect(startScreenShown(empty, true)).toBe(false);
    const [placed, id] = placePiece(empty, 'printed_straight', { x: 500, y: 500 });
    expect(startScreenShown(placed, false)).toBe(false);
    // Deleting the last piece leaves an empty route: still no track, so the screen comes back unless dismissed.
    const cleared = removePiece(placed, id);
    expect(startScreenShown(cleared, false)).toBe(true);
    expect(startScreenShown(cleared, true)).toBe(false);
  });

  it('offers every documented example, simplest first, each with a name and a one-line description', () => {
    expect(START_EXAMPLES.map(item => item.id).slice(0, 2)).toEqual(['oval', 'passing-loop']);
    expect(START_EXAMPLES.length).toBeGreaterThanOrEqual(5);
    for (const item of START_EXAMPLES) {
      expect(item.description.length).toBeGreaterThan(10);
    }
  });

  it('measures an example against the current room and owned track, ignoring the furniture already placed', () => {
    const standard = createStandardProject('Standard');
    const oval = exampleFacts(example('oval'), exampleBase(standard));
    expect(oval).toMatchObject({ owned: 24, printed: 0, needsRoom: false, problems: 0 });
    expect(oval.metres).toBeCloseTo(3.03, 1);
    expect(oval.thumbnail.tracks.length).toBe(24);

    // Fewer owned curves: the rest print, so the counts follow the user's inventory.
    const fewCurves = exampleFacts(example('oval'), exampleBase(setSetupInventory(standard, 'brick_curve_r40', 4)));
    expect(fewCurves).toMatchObject({ owned: 12, printed: 12, needsRoom: false });

    // A small room: still pickable, but flagged.
    const small = setSetupMeasurement(setSetupMeasurement(standard, 'roomWidth', 900), 'roomDepth', 900);
    expect(exampleFacts(example('oval'), exampleBase(small)).needsRoom).toBe('walls');
    expect(exampleFacts(example('kallax-station'), exampleBase(small)).needsRoom).toBe('walls');

    // A shelf the user placed right where the oval goes does not count against the example.
    const [shelved] = placeFurniture(standard, { x: 1050, y: 500 }, 0);
    expect(exampleFacts(example('oval'), exampleBase(shelved))).toMatchObject({ needsRoom: false, problems: 0 });
  });

  it('draws the example shelf into its thumbnail', () => {
    const facts = exampleFacts(example('kallax-station'), exampleBase(createStandardProject('Standard')));
    expect(facts.thumbnail.shelves).toEqual([expect.objectContaining({ width: 1820, height: 390 })]);
  });

  it('lays a picked example as one change onto the project, which stays as it was for Undo', () => {
    const standard = setSetupInventory(createStandardProject('Mine'), 'brick_curve_r40', 8);
    const next = pickExample(example('oval'), standard);
    expect(pieces(standard)).toEqual([]);
    expect(startScreenShown(standard, false)).toBe(true);
    expect(startScreenShown(next, false)).toBe(false);
    expect(pieces(next)).toHaveLength(24);
    expect(unoccupiedPiecePorts(next)).toEqual([]);
    expect(next).toMatchObject({ id: standard.id, name: 'Mine', inventory: standard.inventory, measurements: standard.measurements });
    expect(pieces(next).filter(piece => piece.family === 'brick_curve_r40')).toHaveLength(8);
  });
});
