/**
 * Every keyboard shortcut and pointer gesture in Build, in one table: the key handlers match keys through `shortcutFor`, and
 * the Keyboard shortcuts sheet, the placement bar's key badges, the footer hint and the first-placement tip all read it.
 */

export type ShortcutScope = 'build' | 'checks' | 'palette-search' | 'palette-options';
export interface KeyBinding {
  /** `KeyboardEvent.key`, compared without case. */
  key: string;
  /** Shift must be held (true), must not be (false or absent), or either ('any', for keys typed with Shift such as ?). */
  shift?: boolean | 'any';
  /** ⌘ on a Mac, Ctrl elsewhere. */
  mod?: boolean;
}
export interface Shortcut {
  id: string;
  group: string;
  action: string;
  /** Matched by `shortcutFor`; absent for a pointer gesture (then `gesture` names it). */
  keys?: readonly KeyBinding[];
  gesture?: string;
  /** Where the keys apply: the canvas (window), the Checks list, or the Pieces sidebar's search field or a tile's options. */
  scope?: ShortcutScope;
  /** Only in this view. */
  view?: 'top' | '3d';
  /** Words after the keys in the table footer hint. */
  footer?: string;
}

export const SHORTCUT_GROUPS = ['Placing a piece', 'Selected piece or shelf', 'View', 'History', 'Checks', 'Pieces sidebar', 'Help'] as const;

export const SHORTCUTS = [
  { id: 'place', group: 'Placing a piece', gesture: 'Click', action: 'Place the armed piece (it stays armed); drag a tile to place one' },
  { id: 'rotate', group: 'Placing a piece', keys: [{ key: 'r' }], action: 'Rotate 22.5° (a KALLAX 90°)', footer: 'rotate' },
  { id: 'rotate-back', group: 'Placing a piece', keys: [{ key: 'r', shift: true }], action: 'Rotate back 22.5°' },
  { id: 'flip', group: 'Placing a piece', keys: [{ key: 'f' }], action: 'Flip: a curve turns the other way, a turnout swaps hand, a ramp climbs the other way', footer: 'flips' },
  { id: 'attach-next', group: 'Placing a piece', keys: [{ key: 'Tab' }], action: 'Other side: the piece faces the next way round where it joins the track', footer: 'other side' },
  { id: 'attach-back', group: 'Placing a piece', keys: [{ key: 'Tab', shift: true }], action: 'Faces the previous way round' },
  { id: 'escape', group: 'Placing a piece', keys: [{ key: 'Escape' }], action: 'Done placing; clear the selection, the framed check or Close gap', footer: 'done' },
  { id: 'select', group: 'Selected piece or shelf', gesture: 'Click', action: 'Select a piece or shelf; drag it to move it (with its connected track)' },
  { id: 'rotate-selected', group: 'Selected piece or shelf', keys: [{ key: 'r' }, { key: 'r', shift: true }], action: 'Turn a piece about the joint holding it (a shelf 90°)' },
  { id: 'flip-selected', group: 'Selected piece or shelf', keys: [{ key: 'f' }], action: 'Flip the piece in place' },
  { id: 'delete', group: 'Selected piece or shelf', keys: [{ key: 'Delete' }, { key: 'Backspace' }], action: 'Delete it' },
  { id: 'zoom', group: 'View', gesture: 'Scroll', action: 'Zoom round the pointer', footer: 'to zoom' },
  { id: 'pan-space', group: 'View', gesture: 'Space + drag', action: 'Pan (top view)', view: 'top', footer: 'to pan' },
  { id: 'pan-middle', group: 'View', gesture: 'Middle-drag', action: 'Pan (top view)', view: 'top' },
  { id: 'orbit', group: 'View', gesture: 'Drag', action: 'Orbit (3D)', view: '3d', footer: 'to orbit' },
  { id: 'pan-3d', group: 'View', gesture: 'Right-drag', action: 'Pan (3D)', view: '3d', footer: 'to pan' },
  { id: 'undo', group: 'History', keys: [{ key: 'z', mod: true }], action: 'Undo' },
  { id: 'check-next', group: 'Checks', scope: 'checks', keys: [{ key: 'ArrowDown' }], action: 'Next check in the list' },
  { id: 'check-back', group: 'Checks', scope: 'checks', keys: [{ key: 'ArrowUp' }], action: 'Previous check in the list' },
  { id: 'check-frame', group: 'Checks', gesture: 'Enter', action: 'Frame what the focused check is about (again to clear)' },
  { id: 'search-clear', group: 'Pieces sidebar', scope: 'palette-search', keys: [{ key: 'Escape' }], action: 'Clear the search (in the search field)' },
  { id: 'options-close', group: 'Pieces sidebar', scope: 'palette-options', keys: [{ key: 'Escape' }], action: 'Close the piece panel (inside it)' },
  { id: 'help', group: 'Help', keys: [{ key: '?', shift: 'any' }], action: 'Keyboard shortcuts', footer: 'all keys' }
] as const satisfies readonly Shortcut[];

export type ShortcutId = typeof SHORTCUTS[number]['id'];
/** The shortcuts only described by others: the same keys as an earlier row, which `shortcutFor` reports instead. */
const SHADOWED: Partial<Record<ShortcutId, true>> = { 'rotate-selected': true, 'flip-selected': true };
export const shortcut = (id: ShortcutId): Shortcut => SHORTCUTS.find(item => item.id === id)!;

interface KeyEventLike { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }
function matches(binding: KeyBinding, event: KeyEventLike): boolean {
  if (event.key.toLowerCase() !== binding.key.toLowerCase()) return false;
  if (binding.shift !== 'any' && event.shiftKey !== Boolean(binding.shift)) return false;
  return binding.mod ? event.metaKey || event.ctrlKey : !(event.metaKey || event.ctrlKey || event.altKey);
}
/** The shortcut a key press means in `scope` (the canvas by default), or null. */
export function shortcutFor(event: KeyEventLike, scope: ShortcutScope = 'build'): ShortcutId | null {
  const found = (SHORTCUTS as readonly Shortcut[]).find(item => (item.scope ?? 'build') === scope && !SHADOWED[item.id as ShortcutId] &&
    item.keys?.some(binding => matches(binding, event)));
  return (found?.id as ShortcutId | undefined) ?? null;
}

const KEY_NAMES: Record<string, string> = { escape: 'Esc', delete: 'Del', backspace: '⌫', tab: 'Tab', arrowdown: '↓', arrowup: '↑', ' ': 'Space' };
/** How one key binding reads: R, ⇧R, ⌘Z (Ctrl+Z off a Mac), Esc. */
export function bindingLabel(binding: KeyBinding): string {
  const name = KEY_NAMES[binding.key.toLowerCase()] ?? binding.key.toUpperCase();
  const mac = typeof navigator === 'undefined' || /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  return `${binding.mod ? mac ? '⌘' : 'Ctrl+' : ''}${binding.shift === true ? '⇧' : ''}${name}`;
}
/** `aria-keyshortcuts` for a shortcut: "Shift+R", "Delete Backspace", "Meta+Z Control+Z". */
export function ariaKeyShortcuts(id: ShortcutId): string {
  return (shortcut(id).keys ?? []).flatMap(binding => {
    const key = `${binding.shift === true ? 'Shift+' : ''}${binding.key.length === 1 ? binding.key.toUpperCase() : binding.key}`;
    return binding.mod ? [`Meta+${key}`, `Control+${key}`] : [key];
  }).join(' ');
}
/** The keys (or gesture) of a shortcut as shown: the bindings joined with ' / '. */
export function keyLabel(id: ShortcutId): string {
  const item = shortcut(id);
  return item.keys?.map(bindingLabel).join(' / ') ?? item.gesture ?? '';
}
/** The rows of the Keyboard shortcuts sheet, grouped in sheet order. */
export function shortcutSheet(): { group: string; rows: { id: ShortcutId; keys: string; action: string }[] }[] {
  return SHORTCUT_GROUPS.map(group => ({ group, rows: SHORTCUTS.filter(item => item.group === group)
    .map(item => ({ id: item.id, keys: keyLabel(item.id), action: item.action })) })).filter(section => section.rows.length);
}
/** The footer hint on the table for `view`, view gestures first: "Scroll to zoom · Space + drag to pan · R rotate · …". */
export function footerHint(view: 'top' | '3d'): string {
  const shown = (SHORTCUTS as readonly Shortcut[]).filter(item => item.footer && (!item.view || item.view === view));
  return [...shown.filter(item => item.group === 'View'), ...shown.filter(item => item.group !== 'View')]
    .map(item => `${keyLabel(item.id as ShortcutId)} ${item.footer}`).join(' · ');
}
/** The one-time tip on the first placement: "R rotates · F flips · Tab other side · ? all keys". */
export function placementTip(): string {
  return `${keyLabel('rotate')} rotates · ${keyLabel('flip')} flips · ${keyLabel('attach-next')} other side · ${keyLabel('help')} all keys`;
}
