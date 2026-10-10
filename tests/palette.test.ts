import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { fitProject } from '../src/fitting/fit';
import { RouteEditor } from '../src/editor/app';
import { furnitureTiles } from '../src/editor/furniture-tiles';
import { PALETTE_OPEN_KEY, Palette, entryMatches, jumpOffset, paletteSectionId, paletteSections, readOpenGroups, tileSource, withGroupOpen, writeOpenGroups,
  type PaletteEntry } from '../src/editor/palette';
import { PlacingPanel } from '../src/editor/piece-panel';

const entry = (fields: Partial<PaletteEntry> & Pick<PaletteEntry, 'key' | 'label'>): PaletteEntry =>
  ({ group: 'track', meta: '', terms: '', sources: [], active: false, handlers: {}, ...fields });
/** The Pieces sidebar of the Build view for `project`. */
const sidebar = (project: WorkshopProject) => renderToStaticMarkup(createElement(RouteEditor, { project, fit: fitProject(project), account: { status: 'offline' },
  onChange: () => {}, onOpenSetup: () => {}, inventoryCue: false, startDismissed: true, onDismissStart: () => {} }))
  .split('aria-label="Pieces sidebar"')[1].split('</aside>')[0];
const tileLabels = (html: string) => [...html.matchAll(/<strong>([^<]*)<\/strong><small>/g)].map(match => match[1]);
/** A storage that keeps what is written, like the browser's. */
const memory = (initial: Record<string, string> = {}) => {
  const values = { ...initial };
  return { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } };
};

describe('Your track', () => {
  it('pins exactly the families the user owns, with what is left of each', () => {
    const project = createProject('Owned');
    Object.assign(project.inventory, { brick_straight_nominal: 8, brick_curve_r40: 16, brick_switch_left: 2, brick_switch_right: 0 });
    const owned = sidebar(project).split('aria-label="Your track"')[1].split('</section>')[0];
    expect(tileLabels(owned)).toEqual(['Straight', 'Curve', 'Left turnout']);
    expect([...owned.matchAll(/aria-label="(\d+) owned left"/g)].map(match => Number(match[1]))).toEqual([8, 16, 2]);
  });

  it('is one line pointing to Setup when nothing is owned', () => {
    const shown = sidebar(createProject('Empty'));
    expect(shown).not.toContain('aria-label="Your track"');
    expect(shown).toContain('You own no track yet — add it in Setup');
  });
});

describe('furniture in the sidebar', () => {
  it('is a Furniture group with the KALLAX tile; the canvas has no Room control', () => {
    const project = createProject('Room');
    const editor = renderToStaticMarkup(createElement(RouteEditor, { project, fit: fitProject(project), account: { status: 'offline' },
      onChange: () => {}, onOpenSetup: () => {}, inventoryCue: false, startDismissed: true, onDismissStart: () => {} }));
    const furniture = editor.split(`id="${paletteSectionId('furniture')}"`)[1].split('</section>')[0];
    expect(furniture).toContain('aria-label="Add KALLAX 5 by 5 shelving unit"');
    expect(editor).not.toContain('aria-label="Room"');
    const kallax = entry({ ...furnitureTiles()[0], key: 'furniture:kallax_5x5', group: 'furniture' });
    expect(['Kallax', 'shelf', 'furniture', 'curve'].map(query => entryMatches(kallax, query))).toEqual([true, true, true, false]);
  });
});

describe('palette folding', () => {
  const curve = entry({ key: 'kind:curve', label: 'Curve', meta: 'R40 · 22.5°', terms: 'curve' });
  const turnout = entry({ key: 'turnout', label: 'Left turnout', group: 'junction', terms: 'switch' });
  const turntable = entry({ key: 'turntable', label: 'Turntable', group: 'mechanism', terms: 'turntable' });
  const entries = [curve, turnout, turntable];

  it('opens Track and Furniture on a first visit and remembers the user’s folds', () => {
    expect([...readOpenGroups(undefined)]).toEqual(['track', 'furniture']);
    expect([...readOpenGroups(memory({ [PALETTE_OPEN_KEY]: '{not json' }))]).toEqual(['track', 'furniture']);
    const storage = memory();
    writeOpenGroups(withGroupOpen(withGroupOpen(readOpenGroups(storage), 'track', false), 'mechanism', true), storage);
    expect([...readOpenGroups(storage)].sort()).toEqual(['furniture', 'mechanism']);
    // Everything folded is remembered too, not taken for a first visit.
    writeOpenGroups(new Set(), storage);
    expect([...readOpenGroups(storage)]).toEqual([]);
  });

  it('folds groups by their remembered state, with a count on each header', () => {
    const sections = paletteSections(entries, '', new Set(['junction']));
    expect(sections.map(section => [section.id, section.open, section.entries.length])).toEqual([['track', false, 1], ['junction', true, 1], ['mechanism', false, 1]]);
  });

  it('ignores folding while searching, then restores it when the search is cleared', () => {
    const open = new Set(['track'] as const);
    expect(paletteSections(entries, 'turn', open).map(section => [section.id, section.open])).toEqual([['junction', true], ['mechanism', true]]);
    expect(paletteSections(entries, '  ', open).map(section => [section.id, section.open])).toEqual([['track', true], ['junction', false], ['mechanism', false]]);
  });
});

describe('palette jump chips', () => {
  it('one chip per group (no All), each pointing at its group in the list', () => {
    const project = createProject('Chips');
    const shown = sidebar(project);
    const chips = shown.split('aria-label="Jump to a group"')[1].split('</nav>')[0];
    expect(chips).not.toContain('>All<');
    const targets = [...chips.matchAll(/aria-controls="([^"]*)"/g)].map(match => match[1]);
    expect(targets).toContain(paletteSectionId('furniture'));
    for (const target of targets) expect(shown).toContain(`<section id="${target}"`);
  });

  it('scrolls the list so the group starts at its top, from wherever the list is', () => {
    expect(jumpOffset({ scrollTop: 300, scrollLeft: 0 }, { top: 200, left: 10 }, { top: 520, left: 10 })).toEqual({ top: 620, left: 0 });
    expect(jumpOffset({ scrollTop: 300, scrollLeft: 0 }, { top: 200, left: 10 }, { top: 150, left: 10 })).toEqual({ top: 250, left: 0 });
  });
});

describe('palette search', () => {
  const curve = entry({ key: 'kind:curve', label: 'Curve', meta: 'R40 · 22.5°', terms: 'curve brick_curve_r40 printed_curve_r40' });
  const turntable = entry({ key: 'turntable', label: 'Turntable', group: 'mechanism', meta: '8 tracks', terms: 'turntable' });

  it('matches label, summary, family id and group, ignoring case and word order', () => {
    expect([curve, turntable].filter(item => entryMatches(item, 'CURVE')).map(item => item.key)).toEqual(['kind:curve']);
    expect(entryMatches(curve, 'r40 22.5')).toBe(true);
    expect(entryMatches(curve, 'brick_curve_r40')).toBe(true);
    expect(entryMatches(turntable, 'mechanisms')).toBe(true);
    expect(entryMatches(turntable, 'turntable R40')).toBe(false);
    expect(entryMatches(turntable, '  ')).toBe(true);
  });
});

describe('palette print source', () => {
  it('uses owned track while stock remains, then the default style, unless the tile has its own pick', () => {
    expect(tileSource({ defaultStyle: 'fast', fast: true, ownedLeft: 2 })).toBe('owned');
    expect(tileSource({ defaultStyle: 'fast', fast: true, ownedLeft: 0 })).toBe('fast');
    expect(tileSource({ defaultStyle: 'fast', fast: true })).toBe('fast');
    expect(tileSource({ pick: 'printed', defaultStyle: 'fast', fast: true, ownedLeft: 2 })).toBe('printed');
    expect(tileSource({ pick: 'fast', defaultStyle: 'printed', fast: true })).toBe('fast');
    expect(tileSource({ pick: 'owned', defaultStyle: 'printed', fast: true, ownedLeft: 0 })).toBe('owned');
  });

  it('prints full detail where fast print is not offered, and falls back to the default when Own has no owned shape', () => {
    expect(tileSource({ defaultStyle: 'fast', fast: false })).toBe('printed');
    expect(tileSource({ pick: 'fast', defaultStyle: 'fast', fast: false, ownedLeft: 0 })).toBe('printed');
    expect(tileSource({ pick: 'owned', defaultStyle: 'fast', fast: true })).toBe('fast');
  });
});

describe('placing panel', () => {
  const tiles = (entries: PaletteEntry[]) => renderToStaticMarkup(createElement(Palette, { entries, brickTrack: true, onOpenSetup: () => {}, collapsed: false, onCollapse: () => {},
    fastAvailable: true, defaultStyle: 'printed', onDefaultStyle: () => {} }));
  const panel = (armed: PaletteEntry) => renderToStaticMarkup(createElement(PlacingPanel, { entry: armed, onSource: () => {}, onClose: () => {} }));
  const curve = entry({ key: 'kind:curve', label: 'Curve', meta: 'R40 · 22.5°', source: 'owned', active: true,
    owned: { left: 3, total: 8 }, sources: ['owned', 'printed', 'fast'], options: createElement('div', { id: 'curve-form' }) });
  const turntable = entry({ key: 'turntable', label: 'Turntable', group: 'mechanism', source: 'printed', sources: ['printed'],
    options: createElement('div', { id: 'turntable-form' }), caution: 'Untested.', experimental: true });

  it('shows the armed tile as Placing, with its shape options, then Own / Print / Fast and owned count', () => {
    const shown = panel(curve);
    expect(shown).toContain('aria-label="Placing: Curve · R40 · 22.5°"');
    expect(shown).toContain('aria-label="Stop placing"');
    const shape = shown.split('aria-label="Shape"')[1].split('aria-label="Print"')[0];
    expect(shape).toContain('id="curve-form"');
    const print = shown.split('aria-label="Print"')[1];
    expect(print).toContain('aria-label="Curve: owned, printed or fast print"');
    expect(print).toContain('title="Use a piece you own (3 of 8 left)"');
    expect(print).toContain('3 of 8 owned left');
    expect(shown).not.toContain('Route height');
  });

  it('marks an experimental tile and keeps its caution for the panel’s Info', () => {
    const shown = tiles([curve, turntable]);
    expect(shown).toContain('builder-tile-flag');
    expect(shown).not.toContain('Untested.');
    const info = panel({ ...turntable, active: true }).split('aria-label="Info"')[1];
    expect(info).toContain('<strong>Experimental.</strong> Untested.');
    expect(panel(turntable)).not.toContain('data-source');
  });
});
