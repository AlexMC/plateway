import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkshopProject } from '../src/domain/project';

/** The sample library (tests/fixtures/library): a 90° curve, a locomotive and a plain table, credited 'Plateway sample'. */
const FIXTURES = new URL('./fixtures/library/', import.meta.url);
const INDEX_URL = 'https://library.test/plateway-library/index.json';
const CURVE = 'community_sample_curve_90', TABLE = 'community_plain_table';
const CREDIT = 'by Plateway sample';
const MARK = 'class="community-badge"';

/** The sample bucket: the index at INDEX_URL and its files beside it. */
async function bucket(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  const path = url === INDEX_URL ? 'index.json' : url.replace('https://library.test/plateway-library/', '');
  try { return new Response(readFileSync(new URL(path, FIXTURES))); } catch { return new Response('', { status: 404 }); }
}

/** A fresh page load with the sample library registered (the registries are module state). */
async function app() {
  vi.resetModules();
  const [library, editor, fit, operations, furniture, piecePanel, pieces, defaults] = await Promise.all([
    import('../src/domain/library'), import('../src/editor/app'), import('../src/fitting/fit'), import('../src/editor/operations'),
    import('../src/editor/furniture'), import('../src/editor/piece-panel'), import('../src/domain/pieces'), import('../src/editor/setup-defaults')]);
  await library.loadLibrary({ url: INDEX_URL, fetcher: bucket as typeof fetch }).settled;
  const build = (layout: WorkshopProject) => renderToStaticMarkup(createElement(editor.RouteEditor, { project: layout, fit: fit.fitProject(layout),
    account: { status: 'offline' }, onChange: () => {}, onOpenSetup: () => {}, inventoryCue: false, startDismissed: true, onDismissStart: () => {} }));
  /** One palette tile's markup, by its label. */
  const tile = (html: string, label: string) => html.split('aria-label="Pieces sidebar"')[1].split('<button').find(part => part.includes(`<strong>${label}</strong>`)) ?? '';
  /** The This build sidebar's markup. */
  const summary = (html: string) => html.split('aria-label="Build summary sidebar"')[1].split('CHECKS')[0];
  /** `family` laid after a straight, as the palette drops it at the open end. */
  const after = (layout: WorkshopProject, family: string) => {
    const end = pieces.primaryEnd(layout.routes[0].pieces.at(-1)!, layout);
    return operations.placePiece(layout, family, { x: end.x, y: end.y, heading: end.heading })[0];
  };
  const straight = () => operations.placePiece(defaults.createStandardProject('Marks'), 'printed_straight', { x: 600, y: 600 })[0];
  return { build, tile, summary, after, straight, furniture, piecePanel };
}

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ version: 1, sets: [] })));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the Community mark', () => {
  it('marks a community piece tile and a community furniture tile with the credit; built-in tiles carry no mark', async () => {
    const { build, tile, straight } = await app();
    const html = build(straight());
    expect(tile(html, 'Sample 90° curve')).toContain(MARK);
    expect(tile(html, 'Sample 90° curve')).toContain(CREDIT);
    expect(tile(html, 'Plain table')).toContain(CREDIT);
    for (const label of ['KALLAX 5×5', 'Straight']) {
      expect(tile(html, label), label).not.toBe('');
      expect(tile(html, label), label).not.toContain(MARK);
    }
  });

  it('shows a selected community furniture item’s credit, licence and library folder; a KALLAX 5×5 shows none', async () => {
    const { furniture, piecePanel, straight } = await app();
    const [withTable, tableId] = furniture.placeFurniture(straight(), { x: 1000, y: 1000 }, 0, TABLE);
    const [withBoth, kallaxId] = furniture.placeFurniture(withTable, { x: 2000, y: 1000 }, 0);
    const panel = (id: string) => renderToStaticMarkup(createElement(piecePanel.FurniturePanel, { name: 'Selected', actions: [], onClose: () => {},
      item: withBoth.furniture.find(item => item.id === id)! }));
    const table = panel(tableId);
    expect(table).toContain(MARK);
    expect(table).toContain(CREDIT);
    expect(table).toContain('CC0-1.0');
    expect(table).toContain('href="https://github.com/AlexMC/plateway-library/tree/main/furniture/community_plain_table/1/"');
    expect(panel(kallaxId)).not.toContain(MARK);
  });

  it('credits community pieces under To print and community furniture under Furniture in This build; a built-in layout has no mark', async () => {
    const { build, summary, after, straight, furniture } = await app();
    const builtIn = furniture.placeFurniture(after(straight(), 'printed_straight'), { x: 2000, y: 1000 }, 0)[0];
    expect(summary(build(builtIn))).not.toContain(MARK);
    const layout = furniture.placeFurniture(after(after(straight(), CURVE), CURVE), { x: 1000, y: 1000 }, 0, TABLE)[0];
    const sidebar = summary(build(layout));
    const toPrint = sidebar.split('aria-label="Community pieces to print"')[1]?.split('</ul>')[0] ?? '';
    expect(toPrint).toContain('2 × Sample 90° curve');
    expect(toPrint).toContain(CREDIT);
    const placed = sidebar.split('aria-label="Community furniture"')[1]?.split('</ul>')[0] ?? '';
    expect(placed).toContain('1 × Plain table');
    expect(placed).toContain(CREDIT);
  });
});
