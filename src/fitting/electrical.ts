import type { WorkshopProject } from '../domain/project';
import type { FitIssue } from '../domain/route';
import { physicalPaths, piecePaths, portsFromPaths, portsMate } from '../domain/pieces';

/**
 * 9V track power (metal-rail inserts). Each port has two rails, left and right as seen looking out of it. Running a path
 * from one end to the other swaps them (looking out of the start you face backwards), and so does a joint (two ports face
 * each other). Labelling every port's rails as conductor A/B is therefore a two-colouring: a cycle with an odd number of
 * swaps is a reversing loop (balloon loop, wye), where conductor A meets conductor B — a dead short on 9V.
 */
export const REVERSING_LOOP = 'reversing-loop-9v';
export const POWER_GAP = 'power-gap-9v';
const JOIN_DISTANCE = 0.5, JOIN_ANGLE = 0.01;

export function checkElectrical(project: WorkshopProject): FitIssue[] {
  const pieces = project.routes.flatMap(route => route.pieces.map(piece => ({ piece, route })));
  const ports = pieces.map(({ piece }) => portsFromPaths(physicalPaths(piecePaths(piece, project))));
  if (!ports.some(list => list.some(port => port.electrical))) return [];
  const parent = new Map<string, string>(), parity = new Map<string, number>();
  const find = (node: string): [string, number] => {
    let root = node, flips = 0;
    while (parent.get(root) !== root) { flips ^= parity.get(root)!; root = parent.get(root)!; }
    return [root, flips];
  };
  const node = (index: number, port: string) => {
    const key = `${pieces[index].piece.id}:${port}`;
    if (!parent.has(key)) { parent.set(key, key); parity.set(key, 0); }
    return key;
  };
  /** Joins two ports whose rails swap; false when they were already joined without a swap (odd cycle). */
  const swap = (a: string, b: string): boolean => {
    const [ra, pa] = find(a), [rb, pb] = find(b);
    if (ra === rb) return (pa ^ pb) === 1;
    parent.set(rb, ra); parity.set(rb, pa ^ pb ^ 1);
    return true;
  };
  /** Odd cycles, by the joint or piece that closed them; reported only where the track they lie on carries 9V rails. */
  const conflicts: { routeId: string; pieceId: string; node: string }[] = [];
  pieces.forEach(({ piece, route }, index) => {
    for (const path of physicalPaths(piecePaths(piece, project)))
      if (!swap(node(index, path.from), node(index, path.to))) conflicts.push({ routeId: route.id, pieceId: piece.id, node: node(index, path.from) });
  });
  const gaps: { pieceIds: string[]; point: { x: number; y: number; z: number } }[] = [];
  pieces.forEach(({ piece, route }, index) => {
    for (const port of ports[index]) for (let other = index + 1; other < pieces.length; other++) {
      const found = ports[other].find(candidate => portsMate(port, candidate, JOIN_DISTANCE, JOIN_ANGLE));
      if (!found) continue;
      if (Boolean(port.electrical) !== Boolean(found.electrical)) gaps.push({ pieceIds: [piece.id, pieces[other].piece.id], point: { x: port.x, y: port.y, z: port.z } });
      if (!swap(node(index, port.id), node(other, found.id))) conflicts.push({ routeId: route.id, pieceId: piece.id, node: node(index, port.id) });
    }
  });
  const powered = new Set(pieces.flatMap((_, index) => ports[index].filter(port => port.electrical).map(port => find(node(index, port.id))[0])));
  const issues: FitIssue[] = [], reported = new Set<string>();
  for (const { routeId, pieceId, node: at } of conflicts) {
    const root = find(at)[0];
    if (!powered.has(root) || reported.has(root)) continue;
    reported.add(root);
    issues.push({ code: REVERSING_LOOP, severity: 'warning', routeId, span: [`${pieceId}:start`, `${pieceId}:end`],
      message: 'Reversing loop on metal-rail 9 V track: it turns back on itself, so its metal rails meet left to right — a short circuit. ' +
        'Isolate the loop with plastic rail joiners at both ends and switch its polarity (or feed it from its own controller).' });
  }
  if (gaps.length) issues.push({ code: POWER_GAP, severity: 'warning',
    pieceIds: [...new Set(gaps.flatMap(gap => gap.pieceIds))], points: gaps.map(gap => gap.point),
    message: `Track power stops at ${gaps.length} joint${gaps.length === 1 ? '' : 's'} between metal-rail and printed-rail track; a 9 V train stalls on unpowered track longer than its wheelbase.` });
  return issues;
}
