import kallaxPortal from '../docs/plans/examples/kallax-portal.json';
import kallaxStation from '../docs/plans/examples/kallax-station.json';
import { furnitureType, placedEntries } from '../src/domain/furniture';
import { primaryEnd } from '../src/domain/pieces';
import { createProject, parseProject, setMeasurement, type Furniture, type WorkshopProject } from '../src/domain/project';
import { furnitureFootprints } from '../src/domain/track-footprints';
import { buildChecks } from '../src/editor/checks';
import { surfaceAhead } from '../src/editor/elevation-kits';
import { furnitureFootprint, furniturePosition, placeFurniture, rotateFurniture } from '../src/editor/furniture';
import { furnitureTiles } from '../src/editor/furniture-tiles';
import { placePiece } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';
import { roomClashes } from '../src/fitting/room';
import { baseReferences, buildPlan, cubbyPose } from '../src/plan/build';
import { measurePlan } from '../src/plan/eval';
import task2 from './fixtures/task2-junction.json';

const TURNS = [0, 1, 2, 3] as const;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const shelfAt = (quarterTurns: Furniture['quarterTurns']): Furniture => ({ id: `shelf-${quarterTurns}`, family: 'kallax_5x5', x: 1200, y: 1000, quarterTurns });
const brick = (): WorkshopProject => ({ ...createProject('Characterization'), trackSystem: 'brick-v1' });
type Uuid = `${string}-${string}-${string}-${string}-${string}`;

/** Runs `capture` with `crypto.randomUUID` and `Date.now` made deterministic, so ids and stamps repeat run to run. */
function deterministic<T>(capture: () => T): T {
  const uuid = crypto.randomUUID, now = Date.now;
  let next = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}` as Uuid;
  Date.now = () => 1_790_000_000_000;
  try { return capture(); } finally { crypto.randomUUID = uuid; Date.now = now; }
}

/**
 * Everything the KALLAX 5×5 drives today, as plain JSON: its surfaces and cubby openings, its panels as room-check
 * footprints, the editor's placement rules, the room check and Checks (on a crafted layout and the Task2 fixture), the
 * plan builder's examples and errors, the climb's surface ahead and the palette tile. Captured before furniture became
 * data (tests/fixtures/kallax-characterization.json); the furniture registry must reproduce it exactly.
 */
export function kallaxCharacterization() {
  return deterministic(() => {
    const type = furnitureType('kallax_5x5');
    const surfaces = json({ family: type.family, label: type.label, width: type.width, depth: type.depth, height: type.height, surfaces: type.surfaces });
    const placed = TURNS.map(turns => placedEntries([shelfAt(turns)]).map(entry =>
      ({ furniture: entry.furniture.id, surface: entry.surface.id, height: entry.surface.height, entry: entry.entry.id, a: entry.a, b: entry.b, heading: entry.heading })));
    const cubbies = TURNS.map(turns => Array.from({ length: 25 }, (_, index) => (['front', 'back'] as const)
      .map(side => cubbyPose(shelfAt(turns), Math.floor(index / 5) + 1, index % 5 + 1, side))));
    const footprints = json(TURNS.map(turns => furnitureFootprints(shelfAt(turns))));

    const room = setMeasurement(setMeasurement(createProject('Room'), 'roomWidth', 2400), 'roomDepth', 2100);
    const narrow = setMeasurement(setMeasurement(createProject('Narrow'), 'roomWidth', 500), 'roomDepth', 2000);
    const [one, oneId] = placeFurniture(room, { x: 0, y: 0 }, 0), turned = [one];
    for (let turn = 0; turn < 4; turn++) turned.push(rotateFurniture(turned.at(-1)!, oneId));
    const editor = json({
      footprints: TURNS.map(turns => furnitureFootprint('kallax_5x5', turns)),
      positions: TURNS.map(turns => [{ x: 0, y: 0 }, { x: 1200, y: 1000 }, { x: 5000, y: 5000 }].map(point => furniturePosition(room, point, turns))),
      placed: one.furniture,
      turns: turned.map(project => project.furniture),
      refusals: TURNS.map(turns => { try { placeFurniture(narrow, { x: 200, y: 1000 }, turns); return null; } catch (error) { return (error as Error).message; } })
    });

    // Floor-level track running into the middle cubby's bottom panel, and track entering that cubby on its floor.
    const [shelved, shelfId] = placeFurniture(brick(), { x: 1200, y: 1800 }, 0);
    const shelf = shelved.furniture.find(item => item.id === shelfId)!;
    const straight = placePiece(shelved, 'track_straight', { x: 1200, y: 1300, heading: Math.PI / 2, params: { length: 256 } })[0];
    const end = primaryEnd(straight.routes[0].pieces.at(-1)!, straight);
    const through = placePiece(straight, 'track_straight', { x: end.x, y: end.y, z: end.z, heading: end.heading, params: { length: 256 } })[0];
    const cubby = placePiece(shelved, 'track_straight', { ...cubbyPose(shelf, 1, 3, 'front'), params: { length: 256 } })[0];
    // Track resting on the top, across its middle.
    const top = placePiece(shelved, 'track_straight', { x: shelf.x - 128, y: shelf.y, z: 1820, heading: 0, params: { length: 256 } })[0];
    const clash = (project: WorkshopProject) => { const { room, outside, reach, shelves } = roomClashes(project); return { room, outside, reach, shelves: [...shelves] }; };
    const checks = (project: WorkshopProject) => buildChecks(project, fitProject(project));
    const roomCheck = json({ through: clash(through), cubby: clash(cubby), top: clash(top),
      checks: { through: checks(through), cubby: checks(cubby), top: checks(top) } });

    const task2Project = parseProject(JSON.stringify(task2));
    const task2Checks = json(checks(task2Project));

    const plan = (input: unknown) => { const built = buildPlan(input); return json({ routes: built.project.routes, furniture: built.project.furniture,
      report: built.report, metrics: built.report.errors.length ? null : measurePlan(built) }); };
    const panelHit = { version: 1, name: 'Through a panel', furniture: [{ id: 'K1', kallax: { x: 1200, y: 1800, quarterTurns: 0 } }],
      tracks: [{ id: 'in', start: { x: 1200, y: 1300, heading: 90 }, steps: [{ straight: 128, count: 4 }] }] };
    const unknownShelf = { version: 1, name: 'No shelf', tracks: [{ id: 'in', start: { kallax: 'K9', cubby: [1, 1] }, steps: [{ straight: 128 }] }] };
    const plans = { portal: plan(kallaxPortal), station: plan(kallaxStation), panelHit: plan(panelHit), unknownShelf: plan(unknownShelf),
      references: json(baseReferences(task2Project).shelves) };

    const ahead = TURNS.map(turns => {
      const [project, id] = placeFurniture(brick(), { x: 1200, y: 1200 }, turns);
      const pose = cubbyPose(project.furniture.find(item => item.id === id)!, 2, 2, 'front');
      const back = 1600;
      return json(surfaceAhead(project, { x: pose.x - Math.cos(pose.heading) * back, y: pose.y - Math.sin(pose.heading) * back, z: 0, heading: pose.heading }, 4));
    });

    const tiles = furnitureTiles().map(({ family, label, meta, terms, ariaLabel }) => ({ family, label, meta, terms, ariaLabel }));
    return { surfaces, placed: json(placed), cubbies: json(cubbies), footprints, editor, roomCheck, task2Checks, plans, ahead, tiles };
  });
}
