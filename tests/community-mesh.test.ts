// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadLibrary } from '../src/domain/library';
import { piecePorts } from '../src/domain/pieces';
import { createProject, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { DriveScene } from '../src/drive/scene';
import { BuilderScene } from '../src/editor/builder-scene';
import { placePiece } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';

/** WebGL is not in happy-dom: a renderer that keeps the scenes it is asked to draw, so the test can look at them. */
const drawn = vi.hoisted(() => new Set<unknown>());
vi.mock('three', async importOriginal => {
  const three = await importOriginal<typeof THREE>();
  class SceneRecorder {
    domElement = document.createElement('canvas');
    shadowMap = { enabled: false, type: 0 };
    setPixelRatio() {}
    setClearColor() {}
    setSize() {}
    render(scene: unknown) { drawn.add(scene); }
    dispose() {}
  }
  return { ...three, WebGLRenderer: SceneRecorder };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** The sample curve from tests/fixtures/library, listed twice: as published, and with a digest its file doesn't have. */
const FIXTURES = join(import.meta.dirname, 'fixtures/library');
const fixture = (JSON.parse(readFileSync(join(FIXTURES, 'index.json'), 'utf8')) as { items: Record<string, unknown>[] }).items
  .find(item => item.id === 'community_sample_curve_90')!;
const GOOD = 'community_sample_curve_90', BAD = 'community_sample_curve_tampered';
type MeshEnd = { x: number; y: number; z: number; heading: number };
const ends = (fixture.piece as { ends: MeshEnd[] }).ends;
const stl = readFileSync(join(FIXTURES, fixture.file as string));
const triangles = new STLLoader().parse(stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength)).getAttribute('position').count;

const meshFetches: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.href).pathname;
    if (path === '/api/library/index.json') return Response.json({ format: 1, items: [fixture,
      { ...fixture, id: BAD, name: 'Tampered curve', digest: 'a'.repeat(64) }] });
    meshFetches.push(path);
    return new Response(stl);
  }) as typeof fetch;
  await loadLibrary().settled;
});
afterAll(() => { globalThis.fetch = realFetch; });

const mounted: (() => void)[] = [];
function closeAll() { for (const unmount of mounted.splice(0)) unmount(); drawn.clear(); }
afterEach(closeAll);

async function show(element: ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  mounted.push(() => { act(() => root.unmount()); host.remove(); });
  return host;
}
/** Waits for a downloaded mesh (or its refusal) to reach the views. */
const until = (check: () => void) => act(() => vi.waitFor(check));
const nothing = () => {};
const builder = (project: WorkshopProject) => show(createElement(BuilderScene, { project, fit: fitProject(project), selectedId: null,
  selectedFurnitureId: null, highlight: null, armedFurniture: false, previewFurniture: null, preview: [], snapTarget: null, armed: false,
  onHover: nothing, onDrag: nothing, onDeselect: nothing, onPlace: nothing, onSelect: nothing, onMove: nothing, onFurniturePlace: nothing,
  onFurnitureSelect: nothing, onFurnitureMove: nothing }));
const drive = (project: WorkshopProject) => show(createElement(DriveScene, { fit: fitProject(project), project,
  frame: { routeId: project.routes[0].id, leadDistance: 0, cars: [], stopped: true, warning: null } }));

/** Each placed piece of `family`, laid as given; `reversed` lays it from its far end. */
function layout(family: string, laid: { x: number; y: number; heading: number; reversed?: 1 }[]): { project: WorkshopProject; pieces: RoutePiece[] } {
  let project = createProject('Community meshes');
  for (const { reversed, ...pose } of laid) [project] = placePiece(project, family, { ...pose, ...(reversed ? { params: { reversed } } : {}) });
  return { project, pieces: project.routes.flatMap(route => route.pieces) };
}

/** Every mesh drawn for a piece in the last scene drawn, with its world transform. */
function meshesOf(pieceId: string): THREE.Mesh[] {
  const scene = [...drawn].at(-1) as THREE.Scene;
  scene.updateMatrixWorld(true);
  const found: THREE.Mesh[] = [];
  scene.traverseVisible(object => { if (object instanceof THREE.Mesh && object.userData.pieceId === pieceId) found.push(object); });
  return found;
}
const uploaded = (mesh: THREE.Mesh) => mesh.geometry.getAttribute('position').count === triangles;

/** Where the piece's marked ends land in the world, through the drawn mesh, beside the piece's own route ends. */
function landedEnds(mesh: THREE.Mesh, piece: RoutePiece, project: WorkshopProject) {
  const ports = piecePorts(piece, project);
  const [atIn, atOut] = piece.params?.reversed === 1 ? [ends[1], ends[0]] : [ends[0], ends[1]];
  return ([[atIn, 'in'], [atOut, 'out']] as const).map(([end, id]) => {
    const point = new THREE.Vector3(end.x, end.y, end.z).applyMatrix4(mesh.matrixWorld);
    const port = ports.find(item => item.id === id)!;
    return { landed: [point.x, point.y, point.z], route: [port.x, port.y, piece.z + end.z] };
  });
}

describe('a community piece in Build and Test drive', () => {
  it('downloads its mesh once, when it is first placed, and draws it with its marked ends on the route ends, laid either way', async () => {
    expect(meshFetches).toEqual([]);
    await builder(createProject('Empty'));
    expect(meshFetches).toEqual([]);
    closeAll();

    const { project, pieces } = layout(GOOD, [{ x: 600, y: 500, heading: 0.4 }, { x: 1300, y: 900, heading: 2.1, reversed: 1 }]);
    await builder(project);
    await until(() => expect(pieces.every(piece => meshesOf(piece.id).some(uploaded))).toBe(true));
    expect(meshFetches).toEqual([`/api/library/${fixture.file}`]);
    for (const piece of pieces) {
      const meshes = meshesOf(piece.id);
      // The uploaded mesh replaces the generic track.
      expect(meshes.every(uploaded)).toBe(true);
      for (const { landed, route } of landedEnds(meshes[0], piece, project))
        landed.forEach((value, axis) => expect(value).toBeCloseTo(route[axis], 6));
    }

    closeAll();
    await drive(project);
    await until(() => expect(pieces.every(piece => meshesOf(piece.id).some(uploaded))).toBe(true));
    for (const piece of pieces) for (const { landed, route } of landedEnds(meshesOf(piece.id).find(uploaded)!, piece, project))
      landed.forEach((value, axis) => expect(value).toBeCloseTo(route[axis], 6));
    expect(meshFetches).toHaveLength(1);
  });

  it('keeps generic track, with a quiet hint, when the file does not match its index digest', async () => {
    const { project, pieces: [piece] } = layout(BAD, [{ x: 600, y: 500, heading: 0 }]);
    const host = await builder(project);
    await until(() => expect(host.textContent).toContain('Tampered curve shows as plain track'));
    expect(meshesOf(piece.id).length).toBeGreaterThan(0);
    expect(meshesOf(piece.id).some(uploaded)).toBe(false);
  });
});
