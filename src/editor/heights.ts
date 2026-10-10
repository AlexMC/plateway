import { piecePaths } from '../domain/pieces';
import type { Route, WorkshopProject } from '../domain/project';
import { unoccupiedPiecePorts } from './operations';

/** Heights within this of each other (mm) read as the same; below it a track is level or on the table. */
const SAME_HEIGHT = 0.05;
/** Marks closer than this (mm) on the plan are one mark. */
const SAME_PLACE = 40;

const round = (z: number) => Math.round(z * 10) / 10;
/** '+38 mm', '0 mm' or '−20 mm' (track height above the table). */
export function heightText(z: number): string {
  return z > SAME_HEIGHT ? `+${round(z)} mm` : z < -SAME_HEIGHT ? `−${round(-z)} mm` : '0 mm';
}

/** Lowest and highest track (path points) of `routes`, or null without track. */
export function heightRange(project: WorkshopProject, routes: readonly Route[] = project.routes): { min: number; max: number } | null {
  let min = Infinity, max = -Infinity;
  for (const route of routes) for (const piece of route.pieces) for (const path of piecePaths(piece, project)) for (const point of path.points) {
    min = Math.min(min, point.z); max = Math.max(max, point.z);
  }
  return min === Infinity ? null : { min, max };
}

/** A route's height for its label: 'ground' on the table, '64 mm' level above it, '0–38 mm' where it climbs. */
export function routeHeightWords(project: WorkshopProject, route: Route): string {
  const range = heightRange(project, [route]);
  if (!range || range.max - range.min < SAME_HEIGHT) {
    const z = range?.min ?? route.points[0]?.z ?? 0;
    return Math.abs(z) < SAME_HEIGHT ? 'ground' : `${round(z)} mm`;
  }
  return `${round(range.min)}–${round(range.max)} mm`;
}

export interface HeightMark { x: number; y: number; z: number; text: string }
/**
 * Where the plan says how high the track is, once any track is off the table: route ends, open ends, and where level
 * track meets a slope (a ramp's foot and top). Marks at one place merge.
 */
export function heightMarks(project: WorkshopProject): HeightMark[] {
  const range = heightRange(project);
  if (!range || Math.max(Math.abs(range.min), Math.abs(range.max)) < SAME_HEIGHT) return [];
  const places: { x: number; y: number; z: number }[] = [];
  for (const route of project.routes) {
    if (route.pieces.length) places.push(route.points[0], route.points.at(-1)!);
    for (const piece of route.pieces) for (const path of piecePaths(piece, project)) {
      const points = path.points, sloped = points.some(point => Math.abs(point.pitch ?? 0) > 1e-6);
      if (!sloped) continue;
      for (const end of [points[0], points.at(-1)!]) if (Math.abs(end.pitch ?? 0) < 1e-6) places.push(end);
    }
  }
  places.push(...unoccupiedPiecePorts(project).map(({ port }) => port));
  const marks: HeightMark[] = [];
  for (const { x, y, z } of places) {
    if (marks.some(mark => Math.hypot(mark.x - x, mark.y - y) < SAME_PLACE && Math.abs(mark.z - z) < SAME_HEIGHT)) continue;
    marks.push({ x, y, z, text: heightText(z) });
  }
  return marks;
}

/**
 * The plan tint for track at height `z` when the highest track is `top` (mm): none on the table, then warmer and
 * brighter the higher it is. `amount` 0–1 places it on the legend's scale.
 */
export function heightTint(z: number, top: number): { colour: string; opacity: number; amount: number } | null {
  if (z <= SAME_HEIGHT || top <= SAME_HEIGHT) return null;
  const amount = Math.min(1, z / top);
  // Pale amber just off the table to a hot orange at the top.
  return { colour: `hsl(${Math.round(48 - 30 * amount)} 95% ${Math.round(70 - 12 * amount)}%)`, opacity: 0.18 + 0.32 * amount, amount };
}
