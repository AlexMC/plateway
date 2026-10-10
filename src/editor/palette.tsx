import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { PIECE_GROUPS, applyChoice, type KindRow, type PieceGroup, type TrackKind } from '../domain/pieces';
import { PRINTS_AS_UPLOADED } from '../domain/pieces/families/community';
import type { Community } from '../domain/project';
import { CommunityMark } from './community-mark';
import type { PieceSource } from './operations';
import { shortcutFor } from './shortcuts';

/** A sidebar group: the piece groups, then furniture. `note`: one line under its header while it is open. */
export type PaletteGroup = PieceGroup | 'furniture';
export const PALETTE_GROUPS: readonly { id: PaletteGroup; label: string; note?: string }[] = [
  ...PIECE_GROUPS.map(group => group.id === 'community' ? { ...group, note: PRINTS_AS_UPLOADED } : group), { id: 'furniture', label: 'Furniture' }];

/** One catalogue tile: a piece family, a track kind, a multi-piece kit or a piece of furniture. */
export interface PaletteEntry {
  /** Unique; also the key of the tile's own Own / Print / Fast pick. */
  key: string;
  group: PaletteGroup;
  label: string;
  /** One line: the current options. */
  meta: string;
  /** More search words (family ids). */
  terms: string;
  /** Colour cue: owned, full detail or fast print. */
  source?: PieceSource;
  preview?: ReactNode;
  owned?: OwnedStock;
  /** The user owns track this tile can place (with any of its options): it is also pinned under Your track. */
  owns?: boolean;
  /** Marks the tile; the full `caution` text shows in its options. */
  experimental?: boolean;
  caution?: string;
  notes?: readonly string[];
  /** A community library item: its tile and options carry the Community mark. */
  community?: Community;
  /** The Own / Print / Fast choices its options offer (none below two). */
  sources: readonly PieceSource[];
  options?: ReactNode;
  /** How the piece is worked (by hand, motor, servo), for tiles with a drive setting. */
  drive?: ReactNode;
  /** The bought parts a piece with these options needs (the armed tile only). */
  alsoNeeds?: ReactNode;
  /** Armed: highlighted, with its options open beside the sidebar. */
  active: boolean;
  /** Its current options build nothing on this track system; it still opens them. */
  unavailable?: boolean;
  ariaLabel?: string;
  /** Arming (click) and one-off placement (drag onto the table). */
  handlers: ButtonHTMLAttributes<HTMLButtonElement>;
}

/** Case-insensitive: every word of the query appears in the text. */
function textMatches(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}
/** Case-insensitive: every word of the query appears in the label, summary, family ids or group. */
export function entryMatches(entry: PaletteEntry, query: string): boolean {
  return textMatches([entry.label, entry.meta, entry.terms, PALETTE_GROUPS.find(item => item.id === entry.group)!.label].join(' '), query);
}
/** Whether the user owns any of these track families (more than none in the inventory), as `stock` reports them. */
export function ownsAny(families: readonly (string | undefined)[], stock: (family: string) => OwnedStock | undefined): boolean {
  return families.some(family => family !== undefined && (stock(family)?.total ?? 0) > 0);
}

/** Where this browser remembers which sidebar groups are open. */
export const PALETTE_OPEN_KEY = 'train-layout-workshop:palette-open';
/** Open on a first visit; the rest start folded. */
const FIRST_OPEN: readonly PaletteGroup[] = ['track', 'furniture'];
function browserStorage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
/** The open groups this browser remembers, else Track and Furniture. */
export function readOpenGroups(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): ReadonlySet<PaletteGroup> {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(PALETTE_OPEN_KEY) ?? 'null');
    if (Array.isArray(saved)) return new Set(PALETTE_GROUPS.map(group => group.id).filter(id => saved.includes(id)));
  } catch { /* unreadable: first-visit defaults */ }
  return new Set(FIRST_OPEN);
}
export function writeOpenGroups(open: ReadonlySet<PaletteGroup>, storage: Pick<Storage, 'setItem'> | undefined = browserStorage()) {
  try { storage?.setItem(PALETTE_OPEN_KEY, JSON.stringify([...open])); } catch { /* not remembered: folds reset next visit */ }
}
/** `open` with group `id` opened or folded. */
export function withGroupOpen(open: ReadonlySet<PaletteGroup>, id: PaletteGroup, isOpen: boolean): ReadonlySet<PaletteGroup> {
  const next = new Set(open);
  if (isOpen) next.add(id); else next.delete(id);
  return next;
}

export interface PaletteSection { id: PaletteGroup; label: string; note?: string; entries: PaletteEntry[]; open: boolean }
/** The list's groups in order, without empty ones. A query ignores folding: only groups with matches, all open. */
export function paletteSections(entries: readonly PaletteEntry[], query: string, open: ReadonlySet<PaletteGroup>): PaletteSection[] {
  const searching = query.trim() !== '';
  return PALETTE_GROUPS.map(group => ({ ...group, entries: entries.filter(entry => entry.group === group.id && entryMatches(entry, query)),
    open: searching || open.has(group.id) })).filter(section => section.entries.length);
}
export const paletteSectionId = (id: PaletteGroup) => `builder-palette-group-${id}`;

type Box = { top: number; left: number };
/** The list scroll position that brings `target` to the list's top (left in the narrow horizontal strip). */
export function jumpOffset(list: { scrollTop: number; scrollLeft: number }, listBox: Box, target: Box): Box {
  return { top: list.scrollTop + target.top - listBox.top, left: list.scrollLeft + target.left - listBox.left };
}

/** Owned pieces of one family: how many the user has and how many are still free. */
export interface OwnedStock { left: number; total: number }
/** The owned stock a kind's preset chip would use, or null when that choice is not an owned shape (or none are owned). */
export function choiceStock(kind: TrackKind, values: Record<string, number>, choice: KindRow['choices'][number],
  stock: (family: string) => OwnedStock | undefined): OwnedStock | null {
  const family = kind.shape(applyChoice(kind, values, choice.values), 'owned')?.family;
  const found = family === undefined ? undefined : stock(family);
  return found && found.total > 0 ? found : null;
}
/** '16 owned', '3 of 16 owned' or 'none left'. */
export function ownedMark({ left, total }: OwnedStock): string {
  return left === 0 ? 'none left' : left === total ? `${left} owned` : `${left} of ${total} owned`;
}

/**
 * A tile's source: the user's own pick, else owned track while any remain (`ownedLeft`: the tile has an owned shape),
 * else the default print style. `fast`: the tile can fast print here; otherwise every print is full detail.
 */
export function tileSource({ pick, defaultStyle, fast, ownedLeft }: { pick?: PieceSource; defaultStyle: 'printed' | 'fast'; fast: boolean; ownedLeft?: number }): PieceSource {
  if (ownedLeft !== undefined && (pick === 'owned' || (!pick && ownedLeft > 0))) return 'owned';
  return fast && (pick && pick !== 'owned' ? pick : defaultStyle) === 'fast' ? 'fast' : 'printed';
}

/**
 * The Pieces sidebar: Your track pinned on top, search, the default print style, jump chips and one list of groups whose
 * headers stick while it scrolls and fold on click (remembered per browser); the armed tile's options open beside it in the piece panel.
 */
export function Palette({ entries, brickTrack, onOpenSetup, collapsed, onCollapse, fastAvailable, defaultStyle, onDefaultStyle }: {
  entries: readonly PaletteEntry[];
  /** This track system takes standard brick track: Your track shows (or asks for the user's track in Setup). */
  brickTrack: boolean; onOpenSetup: () => void;
  collapsed: boolean; onCollapse: () => void;
  /** Fast print exists on this track system. */
  fastAvailable: boolean;
  /** How tiles without their own Print / Fast pick print. */
  defaultStyle: 'printed' | 'fast'; onDefaultStyle: (style: 'printed' | 'fast') => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(readOpenGroups);
  /** A chip asked for this group at the top of the list (a fresh object per click, so the same chip jumps again). */
  const [jump, setJump] = useState<{ id: PaletteGroup } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const searching = query.trim() !== '';
  const sections = paletteSections(entries, query, open);
  const pinned = entries.filter(entry => entry.owns);
  const fold = (id: PaletteGroup, isOpen: boolean) => {
    const next = withGroupOpen(open, id, isOpen);
    setOpen(next);
    writeOpenGroups(next);
  };
  useEffect(() => {
    const section = jump && document.getElementById(paletteSectionId(jump.id));
    // In the narrow strip a group has no box of its own: its first tile marks where it starts.
    const target = section && (section.getClientRects().length ? section : section.querySelector('.builder-tile'));
    if (!list.current || !target) return;
    const at = jumpOffset(list.current, list.current.getBoundingClientRect(), target.getBoundingClientRect());
    list.current.scrollTo({ ...at, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [jump]);
  const tile = (entry: PaletteEntry) => <button key={entry.key} type="button" title={`${entry.label} · ${entry.meta}${entry.community ? ` · by ${entry.community.credit}` : ''}`} aria-label={entry.ariaLabel}
    className={`builder-tile ${entry.source ?? ''} ${entry.active ? 'active' : ''} ${entry.unavailable ? 'is-unavailable' : ''}`} aria-pressed={entry.active} {...entry.handlers}>
    {entry.owned && entry.owned.total > 0 && <span className={`builder-tile-count ${entry.owned.left ? '' : 'empty'}`}
      title={`${entry.owned.left} of ${entry.owned.total} owned left`} aria-label={`${entry.owned.left} owned left`}>{entry.owned.left}</span>}
    {entry.experimental && <span className="builder-tile-flag">Experimental</span>}
    {entry.preview}<strong>{entry.label}</strong><small>{entry.meta}</small>{entry.community && <CommunityMark community={entry.community}/>}
  </button>;
  return <aside className={`builder-palette ${collapsed ? 'is-collapsed' : ''}`} aria-label="Pieces sidebar">
    <div className="builder-heading builder-aside-heading"><strong className="builder-aside-label">PIECES</strong><span className="builder-palette-hint">drag onto table</span><span className="builder-swipe-hint">swipe for more</span>
      <button type="button" className="builder-collapse" aria-label={`${collapsed ? 'Expand' : 'Collapse'} pieces sidebar`} aria-expanded={!collapsed} aria-controls="builder-palette-content" onClick={onCollapse}>{collapsed ? '›' : '‹'}</button></div>
    <div id="builder-palette-content" className="builder-palette-content" hidden={collapsed}>
      {brickTrack && (pinned.length ? <section className="builder-palette-owned" aria-label="Your track">
        <h3 className="builder-palette-owned-title">YOUR TRACK</h3>
        <div className="builder-tiles">{pinned.map(tile)}</div>
      </section> : <button type="button" className="builder-palette-owned-none" onClick={onOpenSetup}>You own no track yet — add it in Setup</button>)}
      <input type="search" className="builder-palette-search" placeholder="Search pieces" aria-label="Search pieces" value={query}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (shortcutFor(event, 'palette-search') === 'search-clear') setQuery(''); }}/>
      {fastAvailable && <div className="builder-default-style"><span>New prints</span>
        <div className="builder-source" role="group" aria-label="New prints: full detail or fast print">
          <button type="button" data-source="printed" aria-pressed={defaultStyle === 'printed'} title="Print new pieces in full detail unless a piece says otherwise"
            onClick={() => onDefaultStyle('printed')}>Full detail</button>
          <button type="button" data-source="fast" aria-pressed={defaultStyle === 'fast'} title="Fast print new pieces (rails and connectors only) unless a piece says otherwise"
            onClick={() => onDefaultStyle('fast')}>Fast</button>
        </div></div>}
      <nav className="builder-chips builder-palette-chips" aria-label="Jump to a group">
        {sections.map(section => <button key={section.id} type="button" aria-controls={paletteSectionId(section.id)} title={`Show ${section.label}`}
          onClick={() => { if (!searching) fold(section.id, true); setJump({ id: section.id }); }}>{section.label}</button>)}
      </nav>
      <div ref={list} className="builder-palette-groups">
        {sections.length ? sections.map(section => {
          const tilesId = `${paletteSectionId(section.id)}-tiles`;
          const title = <><span className="builder-palette-section-name">{section.label}</span><span className="builder-palette-count">{section.entries.length}</span></>;
          return <section key={section.id} id={paletteSectionId(section.id)} className={`builder-palette-group ${section.open ? '' : 'is-folded'}`} aria-label={section.label}>
            <h3 className="builder-palette-section">{searching ? <span className="builder-palette-section-head">{title}</span> :
              <button type="button" className="builder-palette-section-head" aria-expanded={section.open} aria-controls={tilesId}
                onClick={() => fold(section.id, !section.open)}><span className="builder-palette-chevron" aria-hidden="true">›</span>{title}</button>}</h3>
            {section.note && <p className="builder-palette-group-note">{section.note}</p>}
            <div id={tilesId} className="builder-tiles">{section.entries.map(tile)}</div>
          </section>;
        }) : <p className="builder-palette-empty" role="status">No pieces match</p>}
      </div>
    </div>
  </aside>;
}
