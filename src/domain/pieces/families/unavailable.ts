import type { RoutePiece, WorkshopProject } from '../../project';
import { origin } from '../geometry';
import type { PieceDefinition, ShapePoint } from '../types';

/** Where the next piece would start when the saved route gives nothing to go on. */
const STUB = 32;

/**
 * The piece's far end in its own frame, from the route as saved: the route's next point, facing the way the next piece
 * starts (or along the chord when it is the last piece). Route points mirror the pieces' end ports.
 */
function savedEnd(piece: RoutePiece, project: WorkshopProject): ShapePoint {
  for (const route of project.routes) {
    const index = route.pieces.findIndex(item => item.id === piece.id), end = route.points[index + 1];
    if (index < 0 || !end) continue;
    const dx = end.x - piece.x, dy = end.y - piece.y, c = Math.cos(piece.heading), s = Math.sin(piece.heading);
    const next = route.pieces[index + 1];
    const heading = (next ? next.heading : Math.hypot(dx, dy) > 0 ? Math.atan2(dy, dx) : piece.heading) - piece.heading;
    return { x: c * dx + s * dy, y: c * dy - s * dx, z: end.z - piece.z, heading };
  }
  return { x: STUB, y: 0, z: 0, heading: 0 };
}

/**
 * A family this app does not have (a library piece removed or not loaded, KTD9). The piece keeps every saved field and
 * shows as plain track along its saved footprint; fit reports it as unavailable, so the layout cannot be prepared until
 * it is replaced.
 */
export function unavailablePiece(family: string): PieceDefinition {
  return {
    family, label: 'Unavailable piece', group: 'track', source: 'printed', styles: [], params: [], gauge: 'standard',
    body: 'path', customJoiner: true, hidden: true, color: 0x8b8f8a,
    description: () => `“${family}” is not in the library`,
    notes: ['This piece is not in the library any more. It stays in the layout as saved; replace it to prepare the layout.'],
    paths: (piece, project) => [{ id: 'main', from: 'in', to: 'out', points: [origin(), savedEnd(piece, project)] }],
    run: (piece, project) => { const end = savedEnd(piece, project); return Math.hypot(end.x, end.y, end.z); },
    cad: () => []
  };
}
