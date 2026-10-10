// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { libraryLoad, loadLibrary } from '../src/domain/library';
import { changeProject, type WorkshopProject } from '../src/domain/project';
import { libraryModel } from '../src/domain/trains';
import { ADA, button, click, draft, open, seedDraft, service, settle, signedIn, storeDraft, workspaceHooks, type Call } from './workspace-harness';

workspaceHooks();

/** The sample library (tests/fixtures/library), served by the app's service at /api/library/. A path: happy-dom has its own URL. */
const FIXTURES = join(import.meta.dirname, 'fixtures/library');
const TABLE = 'community_plain_table', LOCO = 'community_sample_loco';
const index = JSON.parse(readFileSync(join(FIXTURES, 'index.json'), 'utf8')) as { items: { id: string; digest: string }[] };
const LOCO_ASSET = `library:${LOCO}@${index.items.find(item => item.id === LOCO)!.digest}`;

/**
 * The fake service, plus the library at /api/library/: the index answers at once, but the train and furniture files
 * arrive only once `release` is called.
 */
function slowLibrary(routes: Parameters<typeof service>[0]) {
  const calls = service(routes), api = globalThis.fetch;
  let release = () => {};
  const arrived = new Promise<void>(resolve => { release = resolve; });
  const held: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.href).pathname;
    if (!path.startsWith('/api/library/')) return api(input, init);
    const file = path.slice('/api/library/'.length);
    if (file !== 'index.json') { held.push(file); await arrived; }
    return new Response(readFileSync(join(FIXTURES, file)));
  }) as typeof fetch;
  return { calls, held, release };
}

/** A member's saved layout, with unsaved edits since: the community table and a car of the community locomotive. */
function layoutWithLibraryItems(): WorkshopProject {
  const mine = seedDraft(false, ADA);
  const laid = changeProject(mine, draft => {
    draft.furniture.push({ id: 'table-1', family: TABLE, x: 900, y: 700, quarterTurns: 1 });
    draft.cars.push({ id: 'car-1', name: 'Sample locomotive', length: 166, width: 56, height: 92, wheelbase: 48, couplerGap: 0,
      model: { set: LOCO, car: `${LOCO}/car`, asset: LOCO_ASSET }, bogies: [-24, 24], couplers: { front: 72, rear: -72 },
      outline: [[-83, -28], [83, -28], [83, 28], [-83, 28]] });
  });
  storeDraft(laid, mine);
  return laid;
}

const furnitureShown = (host: HTMLElement) => Array.from(host.querySelectorAll('.builder-furniture'))
  .map(item => [item.querySelector('text')?.textContent, item.classList.contains('placeholder')]);

describe('the library at start-up', () => {
  it('lets the app render once the index is in, while a train and a furniture file are still held back; they then show in the open layout, which saves unchanged', async () => {
    const laid = layoutWithLibraryItems();
    const revisions = `/api/projects/${laid.id}/revisions`;
    const library = slowLibrary({ 'GET /api/auth/me': signedIn(ADA),
      [`POST ${revisions}`]: () => ({ status: 201, body: { id: laid.id, revision: crypto.randomUUID(), name: laid.name, savedAt: new Date().toISOString() } }) });

    const { indexed, settled } = loadLibrary();
    expect(await indexed).toEqual({ loaded: true, refused: [] });
    expect(libraryLoad()).toEqual({ loaded: true, refused: [] });
    expect(library.held.sort()).toEqual(['furniture/community_plain_table/1/table.json', 'trains/community_sample_loco/1/car.glb']);
    expect(libraryModel(LOCO_ASSET)).toBeUndefined();

    // The first render: the table is a placeholder for now.
    const host = await open();
    expect(furnitureShown(host)).toEqual([['Unknown furniture', true]]);

    await act(async () => { library.release(); expect(await settled).toEqual({ loaded: true, refused: [] }); });
    await settle();
    // The same open layout now draws the real table, and the locomotive's checked model is there for its car.
    expect(furnitureShown(host)).toEqual([['Plain table', false]]);
    expect(libraryModel(LOCO_ASSET)).toBeDefined();
    expect(draft()).toMatchObject({ furniture: laid.furniture, cars: laid.cars });

    await click(button(host, 'Save'));
    const [posted] = library.calls.filter((call: Call) => call.method === 'POST' && call.path === revisions);
    const body = posted.body as WorkshopProject;
    expect(body.furniture).toEqual(laid.furniture);
    expect(body.cars).toEqual(laid.cars);
  });
});
