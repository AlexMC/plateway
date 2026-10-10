import { furnitureType } from '../domain/furniture';
import { findPieceDefinition } from '../domain/pieces';
import type { Community, WorkshopProject } from '../domain/project';
import { Icon } from './icons';
import './community-mark.css';

/**
 * The Community mark, the same wherever a community library item shows (palette tiles, the piece panel, This build, the
 * Print step, the train picker): a small Community chip and 'by <credit>'. `details` adds its licence and a link to its
 * folder in the library repository (the piece panel).
 */
export function CommunityMark({ community, details = false }: { community: Community; details?: boolean }) {
  return <span className={`community-mark${details ? ' is-details' : ''}`} title={`Community item by ${community.credit} · ${community.licence}`}>
    <span className="community-badge"><Icon name="community" size={10}/>Community</span>
    <span className="community-by">by {community.credit}</span>
    {details && <>
      <span className="community-licence">{community.licence}</span>
      <a href={community.folder} target="_blank" rel="noopener noreferrer">Library folder</a>
    </>}
  </span>;
}

/** A community item a layout uses: its name, how many of it the layout has, and its provenance. */
export interface CommunityItem { family: string; label: string; count: number; community: Community }

/** The layout's community pieces (`pieces`) and furniture (`furniture`), each family once, in the order first placed. */
export function communityItems(project: WorkshopProject): { pieces: CommunityItem[]; furniture: CommunityItem[] } {
  const tally = (entries: readonly { family: string; label: string; community?: Community }[]) => {
    const items = new Map<string, CommunityItem>();
    for (const { family, label, community } of entries) {
      if (!community) continue;
      const item = items.get(family);
      if (item) item.count++; else items.set(family, { family, label, count: 1, community });
    }
    return [...items.values()];
  };
  return {
    pieces: tally(project.routes.flatMap(route => route.pieces).map(piece => {
      const definition = findPieceDefinition(piece.family);
      return { family: piece.family, label: definition?.label ?? piece.family, community: definition?.community };
    })),
    furniture: tally(project.furniture.map(item => furnitureType(item.family)))
  };
}

/** One line per community item: '2 × Tunnel portal straight' and its mark; nothing when there are none. */
export function CommunityRows({ items, label }: { items: readonly CommunityItem[]; label: string }) {
  if (!items.length) return null;
  return <ul className="community-rows" aria-label={label}>{items.map(item => <li key={item.family}>
    <span>{item.count} × {item.label}</span><CommunityMark community={item.community}/></li>)}</ul>;
}
