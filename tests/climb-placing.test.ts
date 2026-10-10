// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIMB_FAMILY, piecePorts } from '../src/domain/pieces';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { RouteEditor } from '../src/editor/app';
import { placePiece } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** The canvas is 1000 × 800 px at the page origin; its viewBox fits it as the browser draws it (meet, centred). */
const CANVAS = { width: 1000, height: 800 };
function screenMatrix(svg: SVGSVGElement): DOMMatrix {
  const [x, y, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number), k = Math.min(CANVAS.width / width, CANVAS.height / height);
  return new DOMMatrix([k, 0, 0, k, (CANVAS.width - width * k) / 2 - x * k, (CANVAS.height - height * k) / 2 - y * k]);
}

const mounted: { root: Root; host: HTMLElement }[] = [];
let matchMedia: typeof window.matchMedia;
// Views change at once (reduced motion), so a widen lands before the next event.
beforeEach(() => { matchMedia = window.matchMedia; window.matchMedia = (query: string) => ({ matches: query.includes('reduce'), media: query } as MediaQueryList); });
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove(); }
  window.matchMedia = matchMedia;
});

/** The Build view on `start` with a measured canvas; `latest()` is the project now, `at(x, y)` where a world point is on screen. */
async function build(start: WorkshopProject) {
  let latest = start;
  function Harness() {
    const [project, setProject] = useState(start);
    return createElement(RouteEditor, { project, fit: fitProject(project), account: { status: 'offline' }, onChange: next => { latest = next; setProject(next); },
      onOpenSetup: () => {}, inventoryCue: false, startDismissed: true, onDismissStart: () => {} });
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  mounted.push({ root, host });
  const svg = host.querySelector<SVGSVGElement>('.builder-plan')!;
  Object.defineProperty(svg, 'clientWidth', { value: CANVAS.width });
  Object.defineProperty(svg, 'clientHeight', { value: CANVAS.height });
  svg.getScreenCTM = () => screenMatrix(svg);
  const at = (x: number, y: number) => new DOMPoint(x, y).matrixTransform(screenMatrix(svg));
  const fire = async (type: 'pointermove' | 'click', point: { x: number; y: number }) => act(async () => {
    svg.dispatchEvent(type === 'click' ? new MouseEvent('click', { bubbles: true, clientX: point.x, clientY: point.y }) :
      new PointerEvent('pointermove', { bubbles: true, clientX: point.x, clientY: point.y, isPrimary: true }));
  });
  return { host, svg, at, fire, latest: () => latest };
}
async function armClimb(host: HTMLElement) {
  const tile = Array.from(host.querySelectorAll<HTMLButtonElement>('.builder-tile')).find(item => item.querySelector('strong')?.textContent === 'Go up or down')!;
  // A click on the tile (off the canvas, so not a drag onto it) arms it.
  const off = { bubbles: true, button: 0, clientX: -50, clientY: -50 };
  for (const event of [new PointerEvent('pointerdown', off), new PointerEvent('pointerup', off), new MouseEvent('click', off)])
    await act(async () => { tile.dispatchEvent(event); });
}
const hint = (host: HTMLElement) => host.querySelector('.builder-placement-hint')?.textContent ?? '';

describe('placing Go up or down with the pointer', { timeout: 30_000 }, () => {
  const line = () => placePiece({ ...createProject('Climb placing'), trackSystem: 'brick-v1' }, 'track_straight', { x: 600, y: 700, params: { length: 128 } })[0];

  for (const side of ['out', 'in'] as const) it(`snaps to the ${side} end the pointer rests 20 mm past, and a still click lays it there, joined`, async () => {
    const start = line(), end = piecePorts(start.routes[0].pieces[0], start).find(port => port.id === side)!;
    const { host, svg, at, fire, latest } = await build(start);
    await armClimb(host);
    const pointer = at(end.x + 20 * Math.cos(end.heading), end.y + 20 * Math.sin(end.heading));
    const before = svg.getAttribute('viewBox');
    await fire('pointermove', pointer);
    expect(hint(host)).toMatch(/SNAPS TO OPEN END/);
    // The 1.8 m ghost does not fit the view: it zooms out round the pointer, so the end stays under it.
    expect(svg.getAttribute('viewBox')).not.toBe(before);
    const under = new DOMPoint(pointer.x, pointer.y).matrixTransform(screenMatrix(svg).inverse());
    expect(Math.hypot(under.x - end.x, under.y - end.y)).toBeCloseTo(20, 6);
    // The browser repeats a move at the same spot after the view changes; it is still snapped, and the click lays that.
    await fire('pointermove', pointer);
    expect(hint(host)).toMatch(/SNAPS TO OPEN END/);
    await fire('click', pointer);
    const placed = latest();
    expect(placed.routes).toHaveLength(1);
    const climb = placed.routes[0].pieces.find(piece => piece.family === CLIMB_FAMILY)!;
    expect(climb).toMatchObject({ x: expect.closeTo(end.x, 6), y: expect.closeTo(end.y, 6), z: 0, params: { rise: 64, grade: 4 } });
  });

  it('lays a free ghost exactly where it is shown when the pointer has not moved', async () => {
    const { host, at, fire, latest } = await build(line());
    await armClimb(host);
    const pointer = at(1200, 300);
    await fire('pointermove', pointer);
    expect(hint(host)).toMatch(/CLICK TO START A ROUTE/);
    await fire('click', pointer);
    const climb = latest().routes.flatMap(route => route.pieces).find(piece => piece.family === CLIMB_FAMILY)!;
    expect(climb).toMatchObject({ x: expect.closeTo(1200, 6), y: expect.closeTo(300, 6), z: 0, params: { rise: 64 } });
    expect(latest().routes).toHaveLength(2);
  });
});
