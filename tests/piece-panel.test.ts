// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { kindOfFamily } from '../src/domain/pieces';
import { createProject, routeBase, type WorkshopProject } from '../src/domain/project';
import { fitProject } from '../src/fitting/fit';
import { RouteEditor } from '../src/editor/app';
import { placePiece } from '../src/editor/operations';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** The Build view on `start`, keeping every change it makes (as the app does); `latest()` is the project now. */
async function build(start: WorkshopProject) {
  let latest = start;
  function Harness() {
    const [project, setProject] = useState(start);
    return createElement(RouteEditor, { project, fit: fitProject(project), account: { status: 'offline' }, onChange: next => { latest = next; setProject(next); },
      onOpenSetup: () => {}, inventoryCue: false, startDismissed: true, onDismissStart: () => {} });
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  mounted.push({ root, host });
  return { host, latest: () => latest };
}
const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove(); } });

const curveProject = () => placePiece(createProject('Panel'), 'printed_curve_r40', { x: 600, y: 600, heading: 0, sweep: Math.PI / 8 }, -1);
const panelOf = (host: HTMLElement) => host.querySelector<HTMLElement>('.builder-piece-panel');
const pieceOf = (project: WorkshopProject, id: string) => project.routes.flatMap(route => route.pieces).find(piece => piece.id === id);
async function fire(target: Element, event: Event) { await act(async () => { target.dispatchEvent(event); }); }
async function click(target: Element) { await fire(target, new MouseEvent('click', { bubbles: true })); }
async function select(host: HTMLElement) { await fire(host.querySelector('.builder-hit')!, new PointerEvent('pointerdown', { bubbles: true, button: 0 })); }
const button = (root: ParentNode, text: string) => Array.from(root.querySelectorAll('button')).find(item => item.textContent?.trim().startsWith(text))!;
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await fire(input, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

// Each test renders the whole editor in happy-dom: ~1.5 s alone, several times that when the full suite runs in parallel.
describe('the piece panel', { timeout: 30_000 }, () => {
  it('opens a selected piece beside the Pieces sidebar, titled Selected; the build sidebar keeps only the summary and Checks', async () => {
    const [project] = curveProject();
    const { host } = await build(project);
    expect(panelOf(host)).toBeNull();
    await select(host);
    const panel = panelOf(host)!;
    expect(panel.getAttribute('aria-label')).toBe('Selected: Curve · R40 · 22.5°');
    expect(host.querySelector('[aria-label="Pieces sidebar"]')!.nextElementSibling).toBe(panel);
    expect(Array.from(panel.querySelectorAll('.builder-panel-section')).map(section => section.getAttribute('aria-label'))).toEqual(['Shape', 'Print']);
    expect(panel.querySelector('[aria-label="Curve radius"]')).not.toBeNull();
    const summary = host.querySelector('[aria-label="Build summary sidebar"]')!;
    expect(summary.contains(panel)).toBe(false);
    expect(summary.querySelector('.builder-kind-editor,.builder-route-ground,.builder-source')).toBeNull();
    expect(summary.textContent).toContain('CHECKS');
  });

  it('changes the selected piece when a size is picked', async () => {
    const [project, id] = curveProject();
    const { host, latest } = await build(project);
    await select(host);
    await click(button(panelOf(host)!.querySelector('[aria-label="Curve radius"]')!, 'R56'));
    const piece = pieceOf(latest(), id)!;
    expect(kindOfFamily(piece.family)!.values(piece).radius).toBe(448);
    expect(panelOf(host)!.getAttribute('aria-label')).toBe('Selected: Curve · R56 · 22.5°');
  });

  it('folds Route height until opened; its lifts raise the route and its ground sets the route’s base', async () => {
    const [project, id] = curveProject();
    const { host, latest } = await build(project);
    await select(host);
    const fold = panelOf(host)!.querySelector('details')!;
    expect(fold.querySelector('summary')!.textContent).toBe('Route height');
    expect(fold.open).toBe(false);
    expect(fold.textContent).toContain('The floor this whole route sits on.');
    await click(button(fold, '+1 brick'));
    expect(pieceOf(latest(), id)!.z).toBeCloseTo(9.6);
    await type(panelOf(host)!.querySelector<HTMLInputElement>('#route-ground')!, '32');
    expect(routeBase(latest().routes[0])).toBe(32);
  });

  it('offers the placement bar’s Flip, Rotate route and Delete; Delete removes the piece and closes the panel', async () => {
    const [project, id] = curveProject();
    const { host, latest } = await build(project);
    await select(host);
    const actions = panelOf(host)!.querySelector('[role="group"][aria-label="Curve actions"]')!;
    expect(Array.from(actions.querySelectorAll('button')).map(item => item.getAttribute('aria-label'))).toEqual(['Flip', 'Rotate route', 'Delete']);
    await click(button(actions, 'Delete'));
    expect(pieceOf(latest(), id)).toBeUndefined();
    expect(panelOf(host)).toBeNull();
  });

  it('closes on × and on Esc', async () => {
    const [project] = curveProject();
    const { host } = await build(project);
    await select(host);
    await click(panelOf(host)!.querySelector('.builder-flyout-close')!);
    expect(panelOf(host)).toBeNull();
    await select(host);
    await fire(panelOf(host)!.querySelector('input')!, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panelOf(host)).toBeNull();
  });

  it('switches to Placing when a tile is armed while a piece is selected', async () => {
    const [project] = curveProject();
    const { host } = await build(project);
    await select(host);
    const tile = Array.from(host.querySelectorAll<HTMLButtonElement>('.builder-tile')).find(item => item.querySelector('strong')?.textContent === 'Straight')!;
    await fire(tile, new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    const panel = panelOf(host)!;
    expect(panel.getAttribute('aria-label')).toMatch(/^Placing: Straight/);
    expect(host.querySelectorAll('.builder-piece-panel')).toHaveLength(1);
  });
});
