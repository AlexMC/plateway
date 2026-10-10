// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { furnitureType, validFurnitureType } from '../src/domain/furniture';
import type { MeshEnd } from '../src/domain/pieces/families/community';
import { PUBLIC_NOTICE, sizeHint, stlProblem, type Submission } from '../src/contribute/contribute';
import { clearEnd, flipEnd, meshFromStl, placeEnd, snapEnd, type MarkedEnds, type StlMesh } from '../src/contribute/ends';
import { designProblem, furnitureFromDesign, type FurnitureDesign } from '../src/contribute/furniture-design';
import { FurnitureForm } from '../src/contribute/furniture-form';
import { PREVIEW_FAMILY } from '../src/contribute/furniture-preview';
import { ContributePage } from '../src/contribute/views';
import { setCsrf } from '../src/net/api';
import { ADA, button, click, field, service, settle, type } from './workspace-harness';

const LIBRARY = join(fileURLToPath(import.meta.url), '../fixtures/library');
const INDEX = JSON.parse(readFileSync(join(LIBRARY, 'index.json'), 'utf8')) as { items: { id: string; file: string; piece?: { ends: MeshEnd[] } }[] };
const CURVE = INDEX.items.find(item => item.id === 'community_sample_curve_90')!;
const CURVE_STL = new Uint8Array(readFileSync(join(LIBRARY, CURVE.file))).buffer;
const FORM = JSON.parse(readFileSync(join(LIBRARY, 'furniture-form.json'), 'utf8')) as {
  design: FurnitureDesign; name: string; family: string; type: unknown };

const mounted: { root: Root; host: HTMLElement }[] = [];
async function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  await settle();
  mounted.push({ root, host });
  return host;
}
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove(); }
  vi.unstubAllGlobals();
  setCsrf('');
});

/** The first triangle whose normal is `normal` and whose corners all lie on the plane `axis` = `at`. */
function faceOn(mesh: StlMesh, normal: [number, number, number], axis: 0 | 1 | 2, at: number): number {
  for (let t = 0; t < mesh.faces.length / 3; t++) {
    const facing = normal.every((value, i) => Math.abs(mesh.normals[t * 3 + i] - value) < 1e-6);
    if (facing && [0, 1, 2].every(c => Math.abs(mesh.positions[mesh.faces[t * 3 + c] * 3 + axis] - at) < 1e-4)) return t;
  }
  throw new Error('no such face');
}
const sameHeading = (a: number, b: number) => Math.abs(Math.sin(a - b)) < 1e-6 && Math.cos(a - b) > 0;

describe('the mark-the-ends editor', () => {
  const mesh = meshFromStl(CURVE_STL);

  it('snaps a click on each end face to the connector grid the library index records', () => {
    const [first, second] = CURVE.piece!.ends;
    const start = snapEnd(mesh, faceOn(mesh, [-1, 0, 0], 0, 0)) as MeshEnd;
    const end = snapEnd(mesh, faceOn(mesh, [0, 1, 0], 1, 120)) as MeshEnd;
    expect({ ...start, heading: 0 }).toEqual({ ...first, heading: 0 });
    expect(sameHeading(start.heading, first.heading)).toBe(true);
    expect({ ...end, heading: 0 }).toEqual({ ...second, heading: 0 });
    expect(sameHeading(end.heading, second.heading)).toBe(true);
  });

  it('refuses a click on the top of the piece or on one facet of its curved side', () => {
    expect(snapEnd(mesh, faceOn(mesh, [0, 0, 1], 2, 4))).toMatch(/isn’t an end face/);
    const side = Array.from({ length: mesh.faces.length / 3 }, (_, t) => t).find(t => Math.abs(mesh.normals[t * 3 + 2]) < 1e-6 &&
      Math.abs(mesh.normals[t * 3]) > 0.3 && Math.abs(mesh.normals[t * 3 + 1]) > 0.3)!;
    expect(snapEnd(mesh, side)).toMatch(/wide: click the end face where track leaves the piece, not a side/);
  });

  it('flips an end’s arrow to the opposite heading and clears only that end', () => {
    const a: MeshEnd = { x: 0, y: 0, z: 7, heading: Math.PI }, b: MeshEnd = { x: 120, y: 120, z: 7, heading: Math.PI / 2 };
    const both = placeEnd(placeEnd([null, null], a), b);
    expect(both).toEqual([a, b]);
    expect(placeEnd(both, { ...a, x: 5 })).toBe(both);
    const flipped = flipEnd(both, 1);
    expect(flipped[0]).toBe(a);
    expect(sameHeading(flipped[1]!.heading, -Math.PI / 2)).toBe(true);
    expect(sameHeading(flipEnd(flipped, 1)[1]!.heading, b.heading)).toBe(true);
    const cleared: MarkedEnds = clearEnd(both, 0);
    expect(cleared).toEqual([null, b]);
    expect(placeEnd(cleared, a)).toEqual([a, b]);
  });

  it('snaps to the middle of an end face a connector’s tongue and socket cut into pieces, as check.py does', () => {
    type Point = [number, number, number];
    // Wound to face -x: a strip of the end plane x = 0 from y0 to y1, 7 mm high.
    const strip = (y0: number, y1: number): Point[][] => [[[0, y0, 0], [0, y0, 7], [0, y1, 7]], [[0, y0, 0], [0, y1, 7], [0, y1, 0]]];
    const stl = (triangles: Point[][]) => {
      const view = new DataView(new ArrayBuffer(84 + triangles.length * 50));
      view.setUint32(80, triangles.length, true);
      triangles.forEach((corners, t) => corners.forEach((point, c) => point.forEach((value, axis) =>
        view.setFloat32(84 + t * 50 + 12 + c * 12 + axis * 4, value, true))));
      return meshFromStl(view.buffer);
    };
    const top: Point[][] = [[[0, -24, 7], [100, -24, 7], [100, 24, 7]], [[0, -24, 7], [100, 24, 7], [0, 24, 7]]];
    const split = stl([...strip(-24, -11.6), ...strip(-4.4, 3.9), ...strip(12.1, 24), ...top]);
    const end = snapEnd(split, faceOn(split, [-1, 0, 0], 0, 0)) as MeshEnd;
    expect({ ...end, heading: 0 }).toEqual({ x: 0, y: 0, z: 7, heading: 0 });
    expect(sameHeading(end.heading, Math.PI)).toBe(true);
    const tab = stl([...strip(-4.4, 3.9), ...top]);
    expect(snapEnd(tab, faceOn(tab, [-1, 0, 0], 0, 0))).toMatch(/only 8.3 mm wide/);
  });
});

describe('what the piece form checks before sending', () => {
  it('refuses ASCII, mismatched and oversized STL from the byte length alone', () => {
    const ascii = new TextEncoder().encode(`solid piece\n facet normal 0 0 1\n${' '.repeat(200)}`).buffer;
    expect(stlProblem(ascii)).toMatch(/ASCII STL/);
    expect(stlProblem(CURVE_STL.slice(0, -50))).toMatch(/doesn’t match its triangle count/);
    expect(stlProblem(new ArrayBuffer(25_000_000))).toMatch(/limit is 20 MB/);
    expect(stlProblem(CURVE_STL)).toBeNull();
  });

  it('asks about the unit when the mesh is only 2 mm wide', () => {
    expect(sizeHint([2, 1.5, 0.4])).toMatch(/exported in inches or metres\?/);
    expect(sizeHint(meshFromStl(CURVE_STL).size)).toBeNull();
  });

  it('refuses a piece wider in plan than the A1 mini arrange takes, as check.py does', () => {
    expect(sizeHint([170, 48, 7])).toBe('The piece is 170 mm × 48 mm × 7 mm: the A1 mini fits at most 166 mm × 166 mm in plan (its 180 mm bed less a 7 mm margin each side).');
    expect(sizeHint([166, 166, 180])).toBeNull();
  });
});

describe('the furniture form', () => {
  it('writes the FurnitureType the library check accepts (tests/test_library_check.py checks this fixture)', () => {
    const preset = furnitureFromDesign(FORM.design, FORM.name, FORM.family);
    expect(JSON.parse(JSON.stringify(preset))).toEqual(FORM.type);
    expect(validFurnitureType(preset)).toBe(true);
  });

  it('refuses a cubby grid wider than the outline', () => {
    expect(designProblem({ ...FORM.design, width: 600 })).toBe('The cubby grid is 724 mm wide, wider than the 600 mm outline.');
    expect(designProblem(FORM.design)).toBeNull();
  });

  it('redraws the live preview in the Build 3D scene when a surface height changes', async () => {
    const host = await mount(createElement(FurnitureForm, { onSubmitted: () => {} }));
    expect(furnitureType(PREVIEW_FAMILY).surfaces.find(surface => surface.id === 'surface-1')?.height).toBe(740);
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Surface 1 height (mm)"]')!, '900');
    const preview = furnitureType(PREVIEW_FAMILY);
    expect(preview.surfaces.find(surface => surface.id === 'surface-1')?.height).toBe(900);
    expect(preview.height).toBe(900);
    expect(host.querySelector('.contribute-furniture-preview .builder-3d')).not.toBeNull();
  });

  it('shows the permanent-publication notice before the rights attestation', async () => {
    const host = await mount(createElement(FurnitureForm, { onSubmitted: () => {} }));
    const notice = Array.from(host.querySelectorAll('p')).find(item => item.textContent === PUBLIC_NOTICE)!;
    const attest = host.querySelector('input[type="checkbox"]')!;
    expect(notice.compareDocumentPosition(attest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the contributor’s uploads', () => {
  const rejected = (kind: Submission['kind'], metadata: Record<string, unknown>): Submission => ({ id: crypto.randomUUID(), kind, state: 'rejected',
    name: String(metadata.name), author: 'Ada', licence: 'CC-BY-4.0', metadata, reason: 'The legs are too thin.', uploadedAt: '2026-10-08T10:00:00.000Z',
    reviewedAt: '2026-10-08T11:00:00.000Z' });

  async function page(submissions: Submission[]) {
    service({ 'GET /api/submissions': () => ({ body: { submissions, left: 4, resetsAt: null, canReview: false } }) });
    const host = await mount(createElement(ContributePage, { member: ADA, onNeedAccount: () => {}, onClose: () => {}, onNotice: () => {} }));
    await click(button(host, 'Your uploads'));
    return host;
  }

  it('shows Rejected with the reason, and Submit a corrected version fills the furniture form in again', async () => {
    const host = await page([rejected('furniture', { id: 'community_shelf_table', name: 'Shelf table', design: FORM.design })]);
    const item = host.querySelector('.contribute-upload')!;
    expect(item.querySelector('.contribute-badge')?.textContent).toBe('Rejected');
    expect(item.querySelector('.contribute-reason')?.textContent).toBe('Reason: The legs are too thin.');
    await click(button(item, 'Submit a corrected version'));
    expect(field(host, 'Label').value).toBe('Shelf table');
    expect(field(host, 'Width (mm)').value).toBe('800');
    expect(field(host, 'Rows').value).toBe('2');
  });

  it('fills a corrected piece in with its name and marked ends once its file is chosen again', async () => {
    const ends = CURVE.piece!.ends;
    const host = await page([rejected('piece', { id: 'community_curve', name: 'Sample curve', ends })]);
    await click(button(host.querySelector('.contribute-upload')!, 'Submit a corrected version'));
    expect(field(host, 'Name').value).toBe('Sample curve');
    const input = field(host, 'STL file');
    Object.defineProperty(input, 'files', { value: [new File([CURVE_STL], 'piece.stl')] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    const rows = Array.from(host.querySelectorAll('.contribute-end')).map(row => row.querySelector('.contribute-end-text')?.textContent);
    expect(rows).toEqual(['End 1 x 0, y 0, rail height 7 mm, facing 180°', 'End 2 x 120, y 120, rail height 7 mm, facing 90°']);
    expect(host.querySelector('.contribute-status')?.textContent).toMatch(/^Track: 90° curve/);
  });
});

describe('the uploads left', () => {
  it('closes Send for review once a refused try spends the hour’s last attempt, and says why and when it reopens', async () => {
    const resetsAt = new Date(Date.now() + 40 * 60_000);
    let tries = 0;
    service({
      'GET /api/submissions': () => ({ body: { submissions: [], canReview: false, left: tries ? 0 : 1, limit: 'attempts_hour',
        resetsAt: resetsAt.toISOString() } }),
      'POST /api/submissions': () => { tries++; return { status: 422, body: { detail: 'The table has no legs.' } }; }
    });
    const host = await mount(createElement(ContributePage, { member: ADA, onNeedAccount: () => {}, onClose: () => {}, onNotice: () => {} }));
    await click(button(host, 'Furniture'));
    expect(host.querySelector('.contribute-intro')?.textContent).toMatch(/You can send 1 more upload this hour\.$/);
    await type(field(host, 'Label'), 'Shelf table');
    await click(host.querySelector<HTMLInputElement>('.contribute-attest input[type="checkbox"]')!);
    const send = button(host, 'Send for review')!;
    expect(send.disabled).toBe(false);
    await click(send);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The table has no legs.');
    expect(button(host, 'Send for review')!.disabled).toBe(true);
    const time = resetsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect(host.querySelector('.contribute-closed')?.textContent)
      .toMatch(new RegExp(`^Too many upload tries this hour — try again (tomorrow )?at ${time}\\.$`));
  });

  it('keeps Send for review open for an admin, whom no upload cap binds', async () => {
    service({ 'GET /api/submissions': () => ({ body: { submissions: [], canReview: true, left: null, limit: null, resetsAt: null } }) });
    const host = await mount(createElement(ContributePage, { member: ADA, onNeedAccount: () => {}, onClose: () => {}, onNotice: () => {} }));
    await click(button(host, 'Furniture'));
    expect(host.querySelector('.contribute-intro')?.textContent).toMatch(/As an admin, you have no upload limit\.$/);
    await type(field(host, 'Label'), 'Shelf table');
    await click(host.querySelector<HTMLInputElement>('.contribute-attest input[type="checkbox"]')!);
    expect(button(host, 'Send for review')!.disabled).toBe(false);
    expect(host.querySelector('.contribute-closed')).toBeNull();
  });
});
