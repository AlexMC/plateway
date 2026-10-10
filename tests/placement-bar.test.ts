import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlacementBar, barActions, barNote, type BarContext, type BarHandlers } from '../src/editor/placement-bar';
import { ShortcutSheet } from '../src/editor/shortcut-sheet';
import { SHORTCUTS, keyLabel, shortcutFor, shortcutSheet, type Shortcut, type ShortcutId } from '../src/editor/shortcuts';
import { REST_MS, REST_PX, frozenPoint, recordSamples, type PointerSample } from '../src/editor/ghost-freeze';

const key = (name: string, modifiers: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
  ({ key: name, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers });

describe('shortcuts table', () => {
  it('maps the keys Build handles to their actions, Shift and ⌘ included', () => {
    expect(shortcutFor(key('r'))).toBe('rotate');
    expect(shortcutFor(key('R', { shiftKey: true }))).toBe('rotate-back');
    expect(shortcutFor(key('F'))).toBe('flip');
    expect(shortcutFor(key('Tab'))).toBe('attach-next');
    expect(shortcutFor(key('Tab', { shiftKey: true }))).toBe('attach-back');
    expect(shortcutFor(key('Escape'))).toBe('escape');
    expect(shortcutFor(key('Backspace'))).toBe('delete');
    expect(shortcutFor(key('Delete'))).toBe('delete');
    expect(shortcutFor(key('z', { metaKey: true }))).toBe('undo');
    expect(shortcutFor(key('z', { ctrlKey: true }))).toBe('undo');
    // ? is typed with Shift on most layouts.
    expect(shortcutFor(key('?', { shiftKey: true }))).toBe('help');
  });

  it('leaves browser and other-scope keys alone', () => {
    expect(shortcutFor(key('r', { metaKey: true }))).toBeNull();
    expect(shortcutFor(key('z'))).toBeNull();
    expect(shortcutFor(key('z', { metaKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutFor(key('ArrowDown'))).toBeNull();
    expect(shortcutFor(key('ArrowDown'), 'checks')).toBe('check-next');
    expect(shortcutFor(key('Escape'), 'palette-search')).toBe('search-clear');
    expect(shortcutFor(key('Escape'), 'palette-options')).toBe('options-close');
  });

  it('lists every row of the table in the Keyboard shortcuts sheet, with the keys the handlers match', () => {
    const rows = shortcutSheet().flatMap(section => section.rows);
    expect(rows.map(row => row.id).sort()).toEqual(SHORTCUTS.map(item => item.id).sort());
    const sheet = renderToStaticMarkup(createElement(ShortcutSheet, { onClose: () => {} }));
    expect(sheet).toContain('role="dialog"');
    expect(sheet).toContain('aria-modal="true"');
    for (const item of SHORTCUTS) {
      expect(sheet).toContain(item.action);
      for (const label of keyLabel(item.id).split(' / ')) expect(sheet).toContain(`<kbd>${label}</kbd>`);
    }
    // Every key the sheet names for a canvas row is one the canvas handler acts on (or an earlier row's same key).
    for (const item of (SHORTCUTS as readonly Shortcut[]).filter(entry => entry.keys && !entry.scope)) {
      for (const binding of item.keys!) {
        const found = shortcutFor(key(binding.key, { shiftKey: binding.shift === true || binding.shift === 'any', metaKey: Boolean(binding.mod) }));
        expect(found, item.id).not.toBeNull();
      }
    }
  });
});

describe('ghost freeze on the placement bar', () => {
  const trail = (...samples: [number, number, number][]) => recordSamples([], samples.map(([x, y, t]) => ({ x, y, t })));
  const at = (point: PointerSample | null) => point && [point.x, point.y];

  it('goes back to where the pointer rested before heading for the bar', () => {
    // Rested on an open end at (100, 100), then swept down to the bar in a tenth of a second.
    const path = trail([98, 99, 0], [100, 100, 40], [101, 102, 600], [140, 160, 616], [180, 240, 632], [220, 320, 648], [260, 400, 664]);
    expect(at(frozenPoint(path, 700))).toEqual([100, 100]);
  });

  it('takes the latest rest, counting jitter within the tolerance as resting', () => {
    const path = trail([0, 0, 0], [300, 0, 500], [302, 1, 560], [300, 3, 620], [303, 1, 900], [500, 500, 916], [600, 600, 932]);
    const rest = frozenPoint(path, 950)!;
    expect(Math.hypot(rest.x - 300, rest.y)).toBeLessThanOrEqual(REST_PX);
  });

  it('keeps the last pose when the pointer never rested, and nothing without a trail', () => {
    const sweep = Array.from({ length: 30 }, (_, index) => [index * 10, 0, index * 16] as [number, number, number]);
    expect(at(frozenPoint(trail(...sweep), 30 * 16))).toEqual([290, 0]);
    expect(frozenPoint([], 1000)).toBeNull();
  });

  it('keeps a long rest even after a long trail of quick moves, and counts a pause at the bar edge', () => {
    const quick = Array.from({ length: 200 }, (_, index) => [200 + index * 4, 0, 5000 + index * 8] as [number, number, number]);
    expect(at(frozenPoint(trail([50, 50, 0], ...quick), 5000 + 200 * 8))).toEqual([50, 50]);
    expect(at(frozenPoint(trail([0, 0, 0], [80, 80, 16]), 16 + REST_MS))).toEqual([80, 80]);
  });
});

describe('placement bar actions', () => {
  const none = () => {};
  const handlers: BarHandlers = { rotate: none, flip: none, ramp: none, attach: none, done: none, rotateRoute: none, options: none, remove: none };
  const placing = (fields: Partial<Extract<BarContext, { mode: 'placing' }>> = {}): BarContext =>
    ({ mode: 'placing', name: 'Curve · R40 · 22.5°', flip: 'bend', bend: 1, sbend: false, rise: null, attach: null, held: false, ...fields });
  const ids = (context: BarContext) => barActions(context, handlers).map(action => action.id);

  it('offers rotate, flip, other side (only with a choice) and Done while placing', () => {
    expect(ids(placing())).toEqual(['rotate-back', 'rotate', 'flip', 'done']);
    expect(ids(placing({ attach: { index: 0, count: 1 } }))).toEqual(['rotate-back', 'rotate', 'flip', 'done']);
    const choice = barActions(placing({ attach: { index: 1, count: 3 } }), handlers);
    expect(choice.find(action => action.id === 'attach')).toMatchObject({ label: 'Other side 2/3', shortcut: 'attach-next' });
    expect(ids(placing({ flip: null }))).toEqual(['rotate-back', 'rotate', 'done']);
  });

  it('names Flip by what it does: Curve / Shift left or right, Swap hand, Ramp up or down', () => {
    const flip = (context: BarContext) => barActions(context, handlers).find(action => action.id === 'flip')!.label;
    expect(flip(placing())).toBe('Curve left ↶');
    expect(flip(placing({ bend: -1, sbend: true }))).toBe('Shift right ↷');
    expect(flip(placing({ flip: 'mirror' }))).toBe('Swap hand');
    expect(flip(placing({ flip: 'rise', rise: -1 }))).toBe('Ramp down ↘ · 8 mm');
    // A ramp whose F turns its hand keeps a separate Ramp up/down.
    expect(barActions(placing({ rise: 1 }), handlers).find(action => action.id === 'ramp')!.label).toBe('Ramp up ↗ · 8 mm');
  });

  it('offers a selected piece rotate, flip, Rotate route, Options… and Delete', () => {
    expect(ids({ mode: 'selected', name: 'Straight', flip: 'turn', rotateBlocked: '' })).toEqual(['rotate-back', 'rotate', 'flip', 'route', 'options', 'delete']);
    expect(ids({ mode: 'selected', name: 'Straight', flip: null, rotateBlocked: '' })).toEqual(['rotate-back', 'rotate', 'route', 'options', 'delete']);
  });

  it('offers a KALLAX a 90° turn, then Done while placing or Delete once placed', () => {
    expect(barActions({ mode: 'placing-furniture', name: 'KALLAX 5×5' }, handlers).map(action => [action.id, action.label]))
      .toEqual([['rotate', 'Rotate 90°'], ['done', 'Done']]);
    expect(ids({ mode: 'selected-furniture', name: 'KALLAX 5×5' })).toEqual(['rotate', 'delete']);
  });

  it('disables rotating a piece joined at both ends and says why, on the button and in the bar', () => {
    const reason = 'Joined at both ends: turning it alone would break the track. Flip it, or use Rotate route.';
    const context: BarContext = { mode: 'selected', name: 'Curve', flip: 'turn', rotateBlocked: reason };
    const rotate = barActions(context, handlers).filter(action => action.id.startsWith('rotate'));
    expect(rotate.map(action => [action.disabled, action.title])).toEqual([[true, reason], [true, reason]]);
    expect(barNote(context)).toBe(reason);
    expect(barActions(context, handlers).find(action => action.id === 'flip')!.disabled).toBeFalsy();
    expect(barNote({ ...context, rotateBlocked: '' })).toBe('');
    // A snapped ghost's direction comes from the track it meets.
    expect(barActions(placing({ held: true }), handlers).filter(action => action.id.startsWith('rotate')).every(action => action.disabled)).toBe(true);
    expect(barNote(placing({ held: true }))).toMatch(/Tab picks another way/);
  });

  it('renders as a named toolbar whose buttons show and announce their keys', () => {
    const context = placing({ attach: { index: 0, count: 2 } });
    const html = renderToStaticMarkup(createElement(PlacementBar, { context, actions: barActions(context, handlers), note: '', tip: true,
      onDismissTip: () => {} }));
    expect(html).toContain('role="toolbar" aria-label="Placing Curve · R40 · 22.5°"');
    for (const [name, shortcut] of [['Rotate 22.5°', 'rotate'], ['Rotate back 22.5°', 'rotate-back'], ['Curve left ↶', 'flip'], ['Other side 1/2', 'attach-next'], ['Done', 'escape']] as [string, ShortcutId][]) {
      const button = html.split('<button').find(part => part.includes(`aria-label="${name}"`))!;
      expect(button, name).toMatch(new RegExp(`title="[^"]*\\(${keyLabel(shortcut).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\)"`));
      expect(button).toContain('<kbd aria-hidden="true">');
    }
    expect(html).toContain('R rotates · F flips · Tab other side · ? all keys');
  });
});
