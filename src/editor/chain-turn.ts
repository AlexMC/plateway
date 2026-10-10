import type { RoutePiece, WorkshopProject } from '../domain/project';
import { physicalPaths, piecePaths, portsFromPaths, portsMate, type ShapePath, type ShapePort } from '../domain/pieces';

/** Ends this close (and facing) are joined, as in placement; a loop "closes exactly" within the same tolerance. */
const JOIN_DISTANCE = 0.5, JOIN_ANGLE = 0.01;
/** "Parallel to start" tolerance. */
export const PARALLEL_TOLERANCE = 0.5 * Math.PI / 180;
const normalize = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

type Pose = { x: number; y: number; z: number; heading: number };
export interface ChainTurn {
  /** Signed total turn in radians (+ = left) a train makes from the chain's start to `end`; a full loop is ±2π. */
  turn: number;
  /** Some piece on the way bends (a chain of straights reports nothing worth showing). */
  curved: boolean;
  /** Where the chain starts, heading the way a train leaves it. */
  start: Pose;
  /** The end, heading outwards. */
  end: Pose;
  /** The end heads the same way as the start ('same') or back the other way ('opposite'), within 0.5°. */
  parallel: 'same' | 'opposite' | null;
  /** The chain came back round to `end`: the loop is closed. */
  closed: boolean;
}

interface Node { piece: RoutePiece; paths: ShapePath[]; ports: ShapePort[] }

/**
 * Walks back from `endPortId` of `endPieceId` to the chain's start, adding up each piece's turn. The chain starts at an open
 * end, where the walk would revisit a piece, or at a junction's common end when the walk came back along its branch (a
 * siding is measured from its turnout, not round the line it leaves). At a junction entered from its common end the set
 * route is followed. `extra`: ghost pieces that count as laid (the snapped piece being placed).
 */
export function chainTurn(project: WorkshopProject, endPieceId: string, endPortId: string, extra: readonly RoutePiece[] = []): ChainTurn | null {
  const nodes = new Map<string, Node>();
  for (const piece of [...project.routes.flatMap(route => route.pieces), ...extra]) {
    const paths = physicalPaths(piecePaths(piece, project)).filter(path => !path.cable);
    nodes.set(piece.id, { piece, paths, ports: portsFromPaths(paths) });
  }
  const first = nodes.get(endPieceId), endPort = first?.ports.find(port => port.id === endPortId);
  if (!first || !endPort) return null;
  let node = first, portId = endPortId, turn = 0, curved = false, closed = false;
  let start: Pose = { x: endPort.x, y: endPort.y, z: endPort.z, heading: normalize(endPort.heading + Math.PI) };
  const visited = new Set([first.piece.id]);
  for (;;) {
    const touching = node.paths.filter(path => path.from === portId || path.to === portId);
    const path = touching.find(item => item.enabled) ?? touching[0];
    if (!path) break;
    let bend = 0;
    for (let index = 1; index < path.points.length; index++) bend += normalize(path.points[index].heading - path.points[index - 1].heading);
    // Travel runs towards the end: along the path when it leads into `portId`, against it otherwise.
    turn += path.to === portId ? bend : -bend;
    if (Math.abs(bend) > 1e-6) curved = true;
    const otherId = path.to === portId ? path.from : path.to, other = node.ports.find(port => port.id === otherId)!;
    // Back through a junction from its branch: the branch starts at the junction's common end, which the main line also uses.
    const common = node.paths.some(item => item !== path && (item.from === otherId || item.to === otherId));
    const mainLine = path.id === 'main' || path.from === 'in' && path.to === 'out';
    const here = { x: other.x, y: other.y, z: other.z, heading: normalize(other.heading + Math.PI) };
    if (common && !mainLine) { start = here; break; }
    let mate: { node: Node; port: ShapePort } | undefined;
    for (const candidate of nodes.values()) {
      if (candidate === node) continue;
      const port = candidate.ports.find(item => portsMate(item, other, JOIN_DISTANCE, JOIN_ANGLE));
      if (port) { mate = { node: candidate, port }; break; }
    }
    if (!mate) { start = here; break; }
    // Back at a piece already walked: the loop is closed when it is the end piece, else the chain started where it rejoined.
    if (visited.has(mate.node.piece.id)) { closed = mate.node === first; if (!closed) start = here; break; }
    visited.add(mate.node.piece.id);
    node = mate.node; portId = mate.port.id;
  }
  const end = { x: endPort.x, y: endPort.y, z: endPort.z, heading: endPort.heading };
  const offset = Math.abs(normalize(end.heading - start.heading));
  const parallel = offset < PARALLEL_TOLERANCE ? 'same' : Math.PI - offset < PARALLEL_TOLERANCE ? 'opposite' : null;
  return { turn, curved, start, end, parallel, closed };
}

/**
 * One more `piece` (same shape, either hand: a piece authored from its far end turns the other way along the travel)
 * laid on `end` would meet the chain's start face to face: the loop closes exactly.
 */
export function closesWithOneMore(project: WorkshopProject, chain: ChainTurn, piece: RoutePiece): boolean {
  if (chain.closed) return false;
  const pose = { id: 'closing', x: chain.end.x, y: chain.end.y, z: chain.end.z, heading: chain.end.heading };
  const mirrored: RoutePiece = { ...piece, ...(piece.sweep !== undefined ? { sweep: -piece.sweep } : {}),
    ...(piece.params?.sweep !== undefined ? { params: { ...piece.params, sweep: -piece.params.sweep } } : {}) };
  return [piece, mirrored].some(candidate => {
    const next = portsFromPaths(physicalPaths(piecePaths({ ...candidate, ...pose }, project)));
    const start: ShapePort = { x: chain.start.x, y: chain.start.y, z: chain.start.z, heading: chain.start.heading + Math.PI, id: 'start', gauge: next[0]?.gauge ?? 'standard' };
    return next.some(port => port.id !== 'in' && portsMate(port, start, JOIN_DISTANCE, JOIN_ANGLE));
  });
}

/** "135° left of a loop", "parallel to start", "one more closes the loop": the words beside a chain end. */
export function turnWords(chain: ChainTurn, oneMoreCloses: boolean): string[] {
  const degrees = Math.abs(chain.turn) * 180 / Math.PI, shown = Math.round(degrees * 10) / 10;
  if (chain.closed) return ['Loop closed · 360°'];
  const words = [`${shown}°${shown ? chain.turn > 0 ? ' left' : ' right' : ''} of a loop`];
  if (chain.parallel === 'same') words.push('parallel to start');
  if (chain.parallel === 'opposite') words.push('parallel to start · heading back');
  if (oneMoreCloses) words.push('one more piece closes the loop');
  return words;
}
