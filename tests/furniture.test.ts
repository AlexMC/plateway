import { beforeAll, describe, expect, it } from 'vitest';
import { furnitureType, placedEntries, registerFurnitureType, type FurnitureType } from '../src/domain/furniture';
import { KALLAX_5X5, createProject, parseProject, serializeProject, setMeasurement, type WorkshopProject } from '../src/domain/project';
import { buildChecks } from '../src/editor/checks';
import { surfaceAhead } from '../src/editor/elevation-kits';
import { furnitureFootprint, moveFurniture, placeFurniture, removeFurniture, rotateFurniture } from '../src/editor/furniture';
import { furnitureTiles } from '../src/editor/furniture-tiles';
import { placePiece } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';
import { roomClashes } from '../src/fitting/room';
import { buildPlan } from '../src/plan/build';
import saved from './fixtures/kallax-characterization.json';
import { kallaxCharacterization } from './kallax-characterization';

describe('upright KALLAX furniture', () => {
  it('uses the catalogue footprint and keeps all four corners inside the room when placed, moved or turned', () => {
    const empty = createProject('Room');
    empty.measurements.roomWidth = { value: 2400, source: 'Entered estimate', status: 'estimate' };
    empty.measurements.roomDepth = { value: 2100, source: 'Entered estimate', status: 'estimate' };
    expect(KALLAX_5X5).toMatchObject({ width: 1820, depth: 390, height: 1820, opening: 335 });
    expect(furnitureFootprint('kallax_5x5', 1)).toEqual({ width: 390, depth: 1820 });
    const [placed, id] = placeFurniture(empty, { x: 0, y: 0 }, 0);
    expect(placed.furniture[0]).toMatchObject({ id, x: 910, y: 195, quarterTurns: 0 });
    expect(empty.furniture).toEqual([]);
    const turned = rotateFurniture(placed, id);
    expect(turned.furniture[0]).toMatchObject({ x: 910, y: 910, quarterTurns: 1 });
    const moved = moveFurniture(turned, id, { x: 5000, y: 5000 });
    expect(moved.furniture[0]).toMatchObject({ x: 2205, y: 1190, quarterTurns: 1 });
    expect(parseProject(serializeProject(moved)).furniture).toEqual(moved.furniture);
    expect(removeFurniture(moved, id).furniture).toEqual([]);
  });

  it('refuses placement and rotation when the entire footprint cannot fit', () => {
    const project = createProject('Narrow room');
    project.measurements.roomWidth = { value: 500, source: 'Entered estimate', status: 'estimate' };
    project.measurements.roomDepth = { value: 2000, source: 'Entered estimate', status: 'estimate' };
    expect(() => placeFurniture(project, { x: 200, y: 1000 }, 0)).toThrow('at least 1820 × 390 mm');
    const [rotated, id] = placeFurniture(project, { x: 200, y: 1000 }, 1);
    expect(rotated.furniture[0]).toMatchObject({ quarterTurns: 1, x: 200, y: 1000 });
    expect(() => rotateFurniture(rotated, id)).toThrow('at least 1820 × 390 mm');
    expect(rotated.furniture[0].quarterTurns).toBe(1);
  });
});

describe('KALLAX 5×5 as furniture data', () => {
  it('reproduces the surfaces, cubby openings, panels, placement, room check, Checks and plan builder captured before furniture became data', () => {
    const now = kallaxCharacterization();
    for (const key of Object.keys(saved) as (keyof typeof saved)[]) expect({ [key]: now[key] }).toEqual({ [key]: saved[key] });
  }, 30_000);
});

/** A second preset, as a contributed one would arrive: a 1200 × 600 table, its 20 mm top at 740 mm on four 50 mm legs. */
const TABLE: FurnitureType = {
  family: 'test_plain_table', label: 'Plain table', width: 1200, depth: 600, height: 740,
  surfaces: [{ id: 'top', name: 'top', height: 740,
    footprint: [{ x: -600, y: -300 }, { x: 600, y: -300 }, { x: 600, y: 300 }, { x: -600, y: 300 }],
    entries: [{ id: 'front', a: { x: -600, y: -300 }, b: { x: 600, y: -300 }, heading: Math.PI / 2 },
      { id: 'back', a: { x: -600, y: 300 }, b: { x: 600, y: 300 }, heading: -Math.PI / 2 }] }],
  panels: [{ x: 0, y: 0, z: 730, width: 1200, depth: 600, height: 20 },
    ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => ({ x: u * 575, y: v * 275, z: 360, width: 50, depth: 50, height: 720 }))],
  orientations: [0, 1], colour: 0x9c7b5b, plan: { lines: [], caption: 'Plain table' }, terms: 'table desk', description: 'plain table'
};
const brick = (): WorkshopProject => ({ ...createProject('Table'), trackSystem: 'brick-v1' });
const straight = (project: WorkshopProject, x: number, y: number, z: number) =>
  placePiece(project, 'track_straight', { x, y, z, heading: 0, params: { length: 256 } })[0];

describe('a registered furniture preset (a plain table)', () => {
  beforeAll(() => registerFurnitureType(TABLE));

  it('joins the Furniture palette, places inside the room and turns only among its orientations', () => {
    expect(furnitureTiles().map(tile => [tile.label, tile.meta, tile.ariaLabel])).toEqual([
      ['KALLAX 5×5', '1820 × 390 × 1820 mm', 'Add KALLAX 5 by 5 shelving unit'], ['Plain table', '1200 × 600 × 740 mm', 'Add plain table']]);
    const room = setMeasurement(setMeasurement(createProject('Room'), 'roomWidth', 2400), 'roomDepth', 2100);
    const [placed, id] = placeFurniture(room, { x: 0, y: 0 }, 0, TABLE.family);
    expect(placed.furniture).toEqual([{ id, family: TABLE.family, x: 600, y: 300, quarterTurns: 0 }]);
    const turned = rotateFurniture(placed, id);
    expect(turned.furniture[0]).toMatchObject({ quarterTurns: 1, x: 600, y: 600 });
    expect(rotateFurniture(turned, id).furniture[0].quarterTurns).toBe(0);
    expect(parseProject(serializeProject(turned)).furniture).toEqual(turned.furniture);
    const narrow = setMeasurement(createProject('Narrow'), 'roomWidth', 700);
    expect(() => placeFurniture(narrow, { x: 300, y: 1000 }, 0, TABLE.family)).toThrow('Plain table needs at least 1200 × 600 mm');
    expect(placeFurniture(narrow, { x: 300, y: 1000 }, 1, TABLE.family)[0].furniture[0]).toMatchObject({ x: 300, y: 1000 });
  });

  it('offers its top height to a climb heading for it', () => {
    const hall = setMeasurement(setMeasurement(brick(), 'roomWidth', 4000), 'roomDepth', 20000);
    const [project, id] = placeFurniture(hall, { x: 2000, y: 19000 }, 0, TABLE.family);
    expect(placedEntries(project.furniture).map(entry => [entry.surface.id, entry.entry.id, entry.surface.height])).toEqual([['top', 'front', 740], ['top', 'back', 740]]);
    expect(surfaceAhead(project, { x: 2000, y: 200, z: 0, heading: Math.PI / 2 }, 5)).toEqual(
      { height: 740, name: 'Plain table · top', distance: 18500, furnitureId: id, surfaceId: 'top' });
  });

  it('passes the room check for track on its top or under it, and flags track through a leg by its name', () => {
    const [project] = placeFurniture(brick(), { x: 1200, y: 1000 }, 0, TABLE.family);
    const clear = straight(straight(project, 1000, 1000, 740), 900, 1000, 0);
    expect(roomClashes(clear).shelves.size).toBe(0);
    expect(buildChecks(clear, fitProject(clear)).filter(check => check.id.startsWith('shelf'))).toEqual([]);
    // Floor level, across the back-right leg at (1775, 1275).
    const leg = straight(project, 1600, 1275, 0);
    expect([...roomClashes(leg).shelves.keys()]).toEqual(['Plain table 1']);
    expect(buildChecks(leg, fitProject(leg)).filter(check => check.id.startsWith('shelf')))
      .toEqual([expect.objectContaining({ id: 'shelf:Plain table 1', severity: 'error', title: 'Track runs into Plain table 1' })]);
    const { report } = buildPlan({ version: 1, name: 'Past the table', tracks: [{ id: 'run', start: { x: 1700, y: 1275, heading: 0 }, steps: [{ straight: 128 }] }] }, project);
    expect(report.errors).toEqual([expect.objectContaining({ path: 'tracks[0].steps[0]', space: 'shelf',
      message: expect.stringMatching(/runs into Plain table 1's panels/), hint: 'Keep track clear of the Plain table\'s panels, or rest it on a surface (top at 740 mm).' })]);
  });
});

describe('furniture of a family this browser does not know', () => {
  it('opens as a placeholder outline with no surfaces or panels, and saves unchanged', () => {
    const project = brick();
    project.furniture = [{ id: 'bookcase', family: 'library_bookcase_v9', x: 1000, y: 800, quarterTurns: 1 }];
    const opened = parseProject(serializeProject(project));
    expect(opened.furniture).toEqual(project.furniture);
    expect(furnitureType('library_bookcase_v9')).toMatchObject({ label: 'Unknown furniture', placeholder: true, surfaces: [], panels: [] });
    expect(placedEntries(opened.furniture)).toEqual([]);
    const across = straight(opened, 900, 800, 0);
    expect(roomClashes(across).shelves.size).toBe(0);
    const moved = moveFurniture(across, 'bookcase', { x: 1500, y: 900 });
    expect(JSON.parse(serializeProject(moved)).furniture).toEqual([{ id: 'bookcase', family: 'library_bookcase_v9', x: 1500, y: 900, quarterTurns: 1 }]);
  });
});
