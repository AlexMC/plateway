import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { piecePorts, primaryEnd } from '../src/domain/pieces';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { RouteEditor } from '../src/editor/app';
import { climbFit, climbWords, layClimb, placeKitPieces, surfaceAhead } from '../src/editor/elevation-kits';
import { ClimbSettings, FLYOVER_INITIAL, FlyoverSettings, readTyped } from '../src/editor/elevation-ui';
import { placeFurniture } from '../src/editor/furniture';
import { heightMarks, heightText, heightTint, routeHeightWords } from '../src/editor/heights';
import { HELIX_INITIAL, HelixSettings, WALL_RUN_INITIAL, WallRunSettings } from '../src/editor/helix-ui';
import { LADDER_INITIAL, LadderSettings } from '../src/editor/ladder-ui';
import { placePiece } from '../src/editor/operations';
import { setSetupMeasurement } from '../src/editor/setup-defaults';
import { fitProject } from '../src/fitting/fit';

const brick = (): WorkshopProject => ({ ...createProject('Climb'), trackSystem: 'brick-v1' });
/** A KALLAX against the right wall of the default 2400 × 2100 room, its cubbies opening towards −x. */
const withShelf = (project: WorkshopProject) => placeFurniture(project, { x: 2205, y: 1178 }, 3)[0];
/** A 256 mm straight at (x, y) heading +x, and its far open end. */
function straightAt(x: number, y: number, project = brick()) {
  const next = placePiece(project, 'track_straight', { x, y, params: { length: 256 } })[0];
  return { project: next, end: piecePorts(next.routes[0].pieces[0], next).find(port => port.id === 'out')! };
}
/** Every typed number field a kit's settings render: id, range and shown value. */
function numberFields(settings: ReactElement) {
  return [...renderToStaticMarkup(settings).matchAll(/<input id="([^"]+)"[^>]*type="number"[^>]*>/g)].map(([tag, id]) => {
    const attribute = (name: string) => Number(tag.match(new RegExp(` ${name}="([^"]*)"`))![1]);
    return { id, min: attribute('min'), max: attribute('max'), value: attribute('value') };
  });
}

describe('typed kit values', () => {
  const kits: [string, ReactElement, Record<string, string>][] = [
    ['Go up or down', createElement(ClimbSettings, { values: { target: 128, grade: 4 }, hover: null, onChange: () => {} }), { 'climb-target': '38' }],
    ['Flyover', createElement(FlyoverSettings, { values: FLYOVER_INITIAL, onChange: () => {} }), { 'flyover-clearance': '150', 'flyover-under': '64' }],
    ['Helix', createElement(HelixSettings, { values: HELIX_INITIAL, onChange: () => {} }), { 'helix-radius': '640', 'helix-turns': '2.5', 'helix-rise': '96', 'helix-offset': '60' }],
    ['Wall run', createElement(WallRunSettings, { values: { ...WALL_RUN_INITIAL, mount: 2 }, onChange: () => {} }),
      { 'wall-length': '1500', 'wall-height': '400', 'wall-reach': '80', 'wall-spacing': '320', 'wall-shelf': '20' }],
    ['Siding ladder', createElement(LadderSettings, { project: brick(), values: LADDER_INITIAL, problem: '', onChange: () => {} }),
      { 'ladder-sidings': '3', 'ladder-spacing': '136', 'ladder-length': '512' }]
  ];
  for (const [kit, settings, typed] of kits) it(`${kit}: every field takes a typed value, and says why it keeps the old one when typed onto it`, () => {
    const fields = numberFields(settings);
    expect(fields.map(field => field.id).sort()).toEqual(Object.keys(typed).sort());
    for (const { id, min, max, value } of fields) {
      expect(readTyped(typed[id], { min, max, unit: 'mm', kept: value })).toEqual({ value: Number(typed[id]) });
      // Clicking after the shown value and typing appends to it: out of range, kept, and said so.
      const appended = `${value}${typed[id]}99999`;
      expect(readTyped(appended, { min, max, unit: 'mm', kept: value })).toEqual({ problem: `${appended} is outside ${String(min).replace('-', '−')} to ${max} mm; kept ${value}.` });
    }
  });

  it('rejects an empty or non-numeric entry and keeps the value', () => {
    expect(readTyped('  ', { min: -400, max: 1000, unit: 'mm', kept: 128 })).toEqual({ problem: 'Type a number from −400 to 1000 mm; kept 128.' });
    expect(readTyped('1e3', { min: -400, max: 1000, unit: 'mm', kept: 128 })).toEqual({ value: 1000 });
    expect(readTyped('-400', { min: -400, max: 1000, unit: 'mm', kept: 128 })).toEqual({ value: -400 });
  });
});

describe('the surface ahead of a climb', () => {
  /** The climb's start: (x, y) at height z, heading along +x unless `heading`. */
  const from = (x: number, y: number, z = 0, heading = 0) => ({ x, y, z, heading });
  // withShelf's middle column of cubbies is centred on y = 1178; their front edges are at x = 2205 − 195 = 2010.

  it('offers the cubby floor whose opening the track points at, when the climb ends before it', () => {
    expect(surfaceAhead(withShelf(brick()), from(556, 1178), 4)).toMatchObject({ height: 38, name: 'KALLAX 5×5 · cubby floor', surfaceId: 'cubby-1-3' });
    expect(surfaceAhead(withShelf(brick()), from(556, 1178), 4)!.distance).toBeCloseTo(2010 - 556, 6);
  });

  it('offers nothing pointing away, at a divider, too close for the climb, or already at the reachable floor', () => {
    const project = withShelf(brick());
    expect(surfaceAhead(project, from(556, 1178, 0, Math.PI), 4)).toBeNull();
    expect(surfaceAhead(project, from(556, 1178, 0, Math.PI / 2), 4)).toBeNull();
    // Between columns 3 and 4 the track straddles the divider.
    expect(surfaceAhead(project, from(556, 1178 - 176, 0), 4)).toBeNull();
    // 38 mm at 4 % takes 1.16 m; the opening is 0.51 m away.
    expect(surfaceAhead(project, from(1500, 1178), 4)).toBeNull();
    // At 38 mm the next floor (390 mm) needs about 9 m.
    expect(surfaceAhead(project, from(556, 1178, 38), 4)).toBeNull();
    expect(surfaceAhead(brick(), from(556, 1178), 4)).toBeNull();
  });

  it('turns with the shelf: a back opening is entered heading the other way', () => {
    // Turned half round, the shelf's back faces −x: the same ray meets the back openings.
    const turned = placeFurniture(brick(), { x: 2205, y: 1178 }, 1)[0];
    expect(surfaceAhead(turned, from(556, 1178), 4)).toMatchObject({ height: 38, surfaceId: 'cubby-1-3' });
  });
});

describe('whether a climb fits the room', () => {
  it('fits from an open end with room ahead, and says how far the room goes when it does not', () => {
    const near = straightAt(400, 600), far = straightAt(1600, 600);
    const fits = layClimb(near.end, { target: 38, grade: 4 });
    expect(fits.pieces).toHaveLength(1);
    const nearFit = climbFit(near.project, near.end, fits.pieces, fits.plan!.run);
    expect(nearFit).toEqual({ fits: true, run: 1160, room: 2400 - near.end.x });
    expect(climbWords(nearFit)).toBe('fits · 1.2 m climb');
    const short = layClimb(far.end, { target: 128, grade: 4 }), shortFit = climbFit(far.project, far.end, short.pieces, short.plan!.run);
    expect(shortFit.fits).toBe(false);
    expect(shortFit.room).toBeCloseTo(2400 - far.end.x, 6);
    expect(climbWords(shortFit)).toBe(`needs 3.4 m, room has ~${((2400 - far.end.x) / 1000).toFixed(1)} m this way`);
  });

  it('measures the room along the heading, to whichever wall comes first', () => {
    const project = brick(), start = { x: 1000, y: 2000, z: 0, heading: Math.PI / 4 };
    expect(climbFit(project, start, [], 500).room).toBeCloseTo(100 * Math.SQRT2, 6);
    expect(climbFit(project, { ...start, heading: Math.PI }, [], 500).room).toBeCloseTo(1000, 6);
  });
});

describe('track heights on the plan', () => {
  /** Level straight, a climb to 38 mm, and a level straight at the top. */
  function climb(): WorkshopProject {
    let { project, end } = straightAt(300, 600);
    [project] = placeKitPieces(project, layClimb(end, { target: 38, grade: 4 }).pieces);
    const top = primaryEnd(project.routes[0].pieces.at(-1)!, project);
    return placePiece(project, 'track_straight', { x: top.x, y: top.y, z: top.z, heading: top.heading, params: { length: 128 } }, 1)[0];
  }

  it('words heights as the plan shows them', () => {
    expect([38, 390.25, 0, 0.01, -20].map(heightText)).toEqual(['+38 mm', '+390.3 mm', '0 mm', '0 mm', '−20 mm']);
  });

  it('labels a route ground, its level height, or the range it climbs through', () => {
    const flat = straightAt(300, 600).project;
    expect(routeHeightWords(flat, flat.routes[0])).toBe('ground');
    const raised = placePiece(brick(), 'track_straight', { x: 300, y: 600, z: 64, params: { length: 256 } })[0];
    expect(routeHeightWords(raised, raised.routes[0])).toBe('64 mm');
    const climbing = climb();
    expect(climbing.routes).toHaveLength(1);
    expect(routeHeightWords(climbing, climbing.routes[0])).toBe('0–38 mm');
  });

  it('marks heights at route ends, open ends and where a slope meets level track, once any track is raised', () => {
    expect(heightMarks(straightAt(300, 600).project)).toEqual([]);
    const project = climb(), marks = heightMarks(project);
    const route = project.routes[0], foot = primaryEnd(route.pieces[0], project), last = primaryEnd(route.pieces.at(-1)!, project);
    const at = (point: { x: number; y: number }) => marks.filter(mark => Math.hypot(mark.x - point.x, mark.y - point.y) < 1).map(mark => mark.text);
    expect(at(route.points[0])).toEqual(['0 mm']);
    expect(at(foot)).toEqual(['0 mm']);
    expect(at(route.pieces.at(-1)!)).toEqual(['+38 mm']);
    expect(at(last)).toEqual(['+38 mm']);
    expect(marks).toHaveLength(4);
    expect(fitProject(project).issues.filter(issue => issue.severity === 'error')).toEqual([]);
  });

  it('tints only raised track, warmer the higher it is', () => {
    expect(heightTint(0, 38)).toBeNull();
    expect(heightTint(10, 0)).toBeNull();
    const low = heightTint(10, 40)!, high = heightTint(40, 40)!;
    expect(low.amount).toBeCloseTo(0.25, 6);
    expect(high.amount).toBe(1);
    expect(high.opacity).toBeGreaterThan(low.opacity);
  });
});

describe('the Elevation group', () => {
  it('leads with Go up or down, then the height kits, then single pieces with the 8 mm ramp named for what it does', () => {
    const html = renderToStaticMarkup(createElement(RouteEditor, { project: brick(), fit: fitProject(brick()), account: { status: 'offline' },
      onChange: () => {}, onOpenSetup: () => {}, inventoryCue: false, startDismissed: true, onDismissStart: () => {} }));
    const group = html.split('aria-label="Elevation"')[1].split('</section>')[0];
    expect([...group.matchAll(/<strong>([^<]*)<\/strong><small>/g)].map(match => match[1]))
      .toEqual(['Go up or down', 'Helix', 'Flyover', 'Wall run', 'Bridge', 'Ramp set', 'Ramp piece · 8 mm', 'Helix section', 'Banked curve']);
    expect(group).toContain('8 mm rise per piece — use Go up or down for a height');
  });
});
