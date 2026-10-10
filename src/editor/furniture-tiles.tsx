import type { ReactNode } from 'react';
import { furnitureTypes, type FurnitureType } from '../domain/furniture';
import type { Community } from '../domain/project';

/** A Furniture tile in the Pieces sidebar: one per furniture family the room can hold. */
export interface FurnitureTile {
  family: string;
  label: string;
  /** One line: the outer size. */
  meta: string;
  /** More search words. */
  terms: string;
  ariaLabel: string;
  preview: ReactNode;
  /** A community preset: its tile carries the Community mark. */
  community?: Community;
}

/**
 * The tile's 80 × 80 miniature, seen from the front: a cubby grid (KALLAX) as its outline and dividers, else its panels
 * as boxes, scaled to fit.
 */
function miniature({ surfaces, panels, width, height }: FurnitureType): ReactNode {
  const rows = Math.max(0, ...surfaces.map(surface => surface.cell?.row ?? 0)), cols = Math.max(0, ...surfaces.map(surface => surface.cell?.col ?? 0));
  if (rows && cols) return <svg className="builder-tile-preview builder-furniture-miniature" viewBox="0 0 80 80" aria-hidden="true">
    <rect x="5" y="5" width="70" height="70"/>
    {Array.from({ length: Math.max(rows, cols) - 1 }, (_, i) => i + 1).map(index => <path key={index}
      d={`${index < cols ? `M ${5 + index * 70 / cols} 5 v 70` : ''} ${index < rows ? `M 5 ${5 + index * 70 / rows} h 70` : ''}`.trim()}/>)}
  </svg>;
  const scale = 70 / Math.max(width, height, 1);
  return <svg className="builder-tile-preview builder-furniture-miniature" viewBox="0 0 80 80" aria-hidden="true">
    {panels.map((panel, index) => <rect key={index} x={40 + (panel.x - panel.width / 2) * scale} y={75 - (panel.z + panel.height / 2) * scale}
      width={Math.max(1, panel.width * scale)} height={Math.max(1, panel.height * scale)}/>)}
  </svg>;
}

/** The Furniture group's tiles, in sidebar order: one per registered furniture type but retired community ones. */
export function furnitureTiles(): FurnitureTile[] {
  return furnitureTypes().filter(type => !type.community?.retired).map(type => ({ family: type.family, label: type.label,
    meta: `${type.width} × ${type.depth} × ${type.height} mm`, terms: `${type.terms}${type.community ? ` community ${type.community.credit}` : ''}`,
    ariaLabel: `Add ${type.description}`, preview: miniature(type), community: type.community }));
}
