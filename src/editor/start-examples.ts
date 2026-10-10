import { changeProject, type WorkshopProject } from '../domain/project';
import { pieceDefinition, piecePaths } from '../domain/pieces';
import { fitProject } from '../fitting/fit';
import { furnitureFootprint } from './furniture';
import { assistBase } from '../plan/assist';
import { buildPlan } from '../plan/build';
import { parsePlan } from '../plan/types';

/**
 * Build's start screen: when it shows, and the example plans it offers (docs/plans/examples, the same files the plan
 * tests and the AI layout prompt use) with what each would come to in the user's own room and inventory.
 */

/** The start screen shows while the project has no track and the user has not chosen Build by hand on it. */
export function startScreenShown(project: WorkshopProject, dismissed: boolean): boolean {
  return !dismissed && !project.routes.some(route => route.pieces.length > 0);
}

const FILES = import.meta.glob<unknown>('../../docs/plans/examples/*.json', { eager: true, import: 'default' });
/** Simplest first; files not listed follow by name. */
const ORDER: Record<string, number> = { oval: 0, 'passing-loop': 1, 'figure-eight': 2, 'kallax-station': 3, 'kallax-portal': 4 };

export interface StartExample { id: string; name: string; description: string; plan: unknown }
export const START_EXAMPLES: readonly StartExample[] = Object.entries(FILES).map(([file, plan]): StartExample => {
  const id = file.slice(file.lastIndexOf('/') + 1, -'.json'.length), parsed = parsePlan(plan).plan;
  return { id, name: parsed?.name ?? id, description: parsed?.description ?? '', plan };
}).sort((a, b) => (ORDER[a.id] ?? 99) - (ORDER[b.id] ?? 99) || a.id.localeCompare(b.id));

/** A top-view picture in plan millimetres, y already flipped for SVG (plan y runs up the screen). */
export interface Thumbnail {
  viewBox: string;
  /** Centrelines as SVG path data; `owned` pieces draw like the summary's owned track, the rest as prints. */
  tracks: { d: string; owned: boolean }[];
  shelves: { x: number; y: number; width: number; height: number }[];
}

export interface ExampleFacts {
  /** Metres of track, as Build's summary counts it. */
  metres: number;
  /** Owned pieces the example uses from the inventory, and pieces to print. */
  owned: number; printed: number;
  /** It needs a bigger room: track or its shelf would cross the `walls`, or track would run into its `shelf`. */
  needsRoom: false | 'walls' | 'shelf';
  /** Other builder and fit errors in this project. */
  problems: number;
  thumbnail: Thumbnail;
}

/** What the examples are measured against: the project's room, track system, inventory and cars, with no track or furniture. */
export function exampleBase(project: WorkshopProject): WorkshopProject {
  return changeProject(project, draft => { draft.routes = []; draft.crossings = []; draft.furniture = []; });
}

/** `base` comes from `exampleBase`. */
export function exampleFacts(example: StartExample, base: WorkshopProject): ExampleFacts {
  const { project, report } = buildPlan(example.plan, base);
  const fit = fitProject(project);
  const room = report.errors.filter(error => error.space);
  return {
    metres: fit.sections.reduce((sum, section) => sum + section.run, 0) / 1000,
    owned: report.bill.owned.reduce((sum, item) => sum + item.used, 0),
    printed: report.bill.detailed + report.bill.fast,
    needsRoom: room.some(error => error.space === 'room') ? 'walls' : room.length ? 'shelf' : false,
    problems: report.errors.length - room.length + fit.issues.filter(issue => issue.severity === 'error').length,
    thumbnail: thumbnail(project)
  };
}

/** The example laid onto the project as it is (its shelves stay) — one change, so one Undo takes it back. */
export function pickExample(example: StartExample, project: WorkshopProject): WorkshopProject {
  return buildPlan(example.plan, assistBase(project, 'fresh')).project;
}

export function thumbnail(project: WorkshopProject): Thumbnail {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const include = (x: number, y: number) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  const tracks = project.routes.flatMap(route => route.pieces).flatMap(piece => {
    const owned = pieceDefinition(piece.family).source === 'owned';
    return piecePaths(piece, project).filter(path => path.points.length > 1).map(path => {
      path.points.forEach(point => include(point.x, -point.y));
      return { d: path.points.map((point, index) => `${index ? 'L' : 'M'}${Math.round(point.x)} ${Math.round(-point.y)}`).join(''), owned };
    });
  });
  const shelves = project.furniture.map(item => {
    const { width, depth: height } = furnitureFootprint(item.family, item.quarterTurns);
    const shelf = { x: item.x - width / 2, y: -item.y - height / 2, width, height };
    include(shelf.x, shelf.y); include(shelf.x + width, shelf.y + height);
    return shelf;
  });
  if (x0 === Infinity) return { viewBox: '0 0 1 1', tracks, shelves };
  const pad = Math.max(x1 - x0, y1 - y0) * 0.06 + 40;
  return { viewBox: [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad].map(Math.round).join(' '), tracks, shelves };
}
