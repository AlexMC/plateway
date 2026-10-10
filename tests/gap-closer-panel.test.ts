// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { openEnds } from '../src/editor/gap-closer';
import { GapPanel, useGapCloser } from '../src/editor/gap-closer-ui';
import { placePiece } from '../src/editor/operations';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** A printed straight ending at (328, 200) heading +x, and another starting at `start`; owned stock from `inventory`. */
function gapTo(start: { x: number; y: number; heading: number }, inventory: Record<string, number>): WorkshopProject {
  let project: WorkshopProject = { ...createProject('Gap'), trackSystem: 'brick-v1', inventory };
  [project] = placePiece(project, 'printed_brick_straight', { x: 200, y: 200, heading: 0 }, -1);
  [project] = placePiece(project, 'printed_brick_straight', { ...start }, -1);
  return project;
}
/** The Close gap card showing the ways to join the two ends that face each other; `placed` is what Place committed. */
async function panel(project: WorkshopProject) {
  const placed: WorkshopProject[] = [];
  const [a, b] = openEnds(project).filter(end => Math.hypot(end.port.x - 328, end.port.y - 200) < 1 || end.portId === 'in' && end.port.x > 400);
  function Harness() {
    const gap = useGapCloser(project);
    useEffect(() => gap.show([a, b]), []);
    return createElement(GapPanel, { gap, onPlace: next => placed.push(next) });
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  mounted.push({ root, host });
  return { host, placed };
}
const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove(); } });
const choices = (host: HTMLElement) => Array.from(host.querySelectorAll('.gap-option')).map(option => ({
  label: option.querySelector('b')!.textContent, checked: option.querySelector('input')!.checked }));

describe('the Close gap card', () => {
  it('lists owned straights with a printed rest first and preselected, hides the bend limit, and Place lays the choice', async () => {
    const { host, placed } = await panel(gapTo({ x: 664, y: 200, heading: 0 }, { brick_straight_nominal: 2 }));
    expect(choices(host)).toEqual([{ label: '2 owned straights (256 mm) + 80 mm printed', checked: true },
      { label: '1 printed straight 336 mm', checked: false }]);
    expect(host.querySelector('.gap-option small')!.textContent).toBe('2 owned · 1 printed (80 mm)');
    // Every way is straight: the tightest bend allowed changes nothing, so it isn't shown.
    expect(host.querySelector('select')).toBeNull();
    expect(host.textContent).not.toMatch(/radius|bend allowed/i);
    const place = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Place')!;
    await act(async () => place.click());
    expect(placed).toHaveLength(1);
    expect(placed[0].routes).toHaveLength(1);
    expect(openEnds(placed[0])).toHaveLength(2);
    expect(placed[0].routes[0].pieces.filter(piece => piece.family === 'brick_straight_nominal')).toHaveLength(2);
  });

  it('shows the tightest bend allowed, and what it means, when the made-to-measure piece bends', async () => {
    // Offset 64 mm sideways: only an S-bend joins them.
    const { host } = await panel(gapTo({ x: 664, y: 264, heading: 0 }, {}));
    expect(choices(host)).toEqual([{ label: expect.stringMatching(/^1 printed bend \d+ mm · R\d+ min$/), checked: true }]);
    expect(host.querySelector('label:not(.gap-option)')!.textContent).toMatch(/^Tightest bend allowed/);
    expect(host.querySelector('select')).not.toBeNull();
    expect(host.querySelector('.gap-help')!.textContent).toBe('Only matters when the ends aren’t lined up: the made-to-measure piece won’t curve tighter than this.');
  });
});
