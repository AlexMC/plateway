/**
 * The community gallery (R14–R16, R26, R27, KTD11): the service's `/api/gallery` routes, the structured thumbnail a
 * publish sends, and the remix a visitor or member takes into their editor.
 *
 * Addresses: `#gallery` is the gallery, `#gallery=<id>` a layout's read-only page. Opening one never touches the
 * browser draft; only Remix loads a layout into the editor.
 */
import { applyCalibration, loadCalibrations, savedCalibrations, type CalibrationProfile } from '../domain/calibration';
import { parseProject, remixOf, stripForPublish, type LayoutCredit, type PrintSetup, type WorkshopProject } from '../domain/project';
import { thumbnail } from '../editor/start-examples';
import { createStandardProject } from '../editor/setup-defaults';
import { apiFetch, apiJson } from '../net/api';

export const LICENCE_URL = 'https://creativecommons.org/licenses/by/4.0/';
export const TITLE_MAX = 120, DESCRIPTION_MAX = 2000, REASON_MAX = 1000;
/** The service's thumbnail bounds (`cad/service/gallery.py`): x, y points, and bytes of compact JSON as stored. */
export const THUMBNAIL_POINTS = 4000, THUMBNAIL_BYTES = 64 * 1024;

/** A top view in plan millimetres, y flipped for SVG: `box` is the view box; points are x, y pairs; shelves x, y, w, h. */
export interface GalleryThumbnail {
  box: [number, number, number, number];
  tracks: { points: number[]; owned: boolean }[];
  shelves: [number, number, number, number][];
}
export interface GallerySummary {
  id: string; title: string; description: string;
  /** The author's display name when it was published (R25). */
  author: string; licence: LayoutCredit['licence']; publishedAt: string; pieces: number;
  thumbnail: GalleryThumbnail | null;
  /** The layout this one remixes, if any. */
  remixOf: LayoutCredit | null;
  mine: boolean;
  /** Only its author and admins see a hidden layout. */
  hidden?: { at: string; reason: string };
  /** Admins only: reports not yet acted on. */
  openReports?: number;
}
export interface GalleryLayout extends GallerySummary {
  project: unknown;
  /** Nearest first. */
  ancestors: LayoutCredit[];
  canModerate: boolean;
  reports?: { reason: string; reportedAt: string }[];
}
export interface GalleryPage { layouts: GallerySummary[]; next: string | null }

export type GalleryRoute = { view: 'browse' } | { view: 'layout'; id: string };
const LAYOUT_HASH = /^#gallery=([0-9a-f-]{36})$/;
export function galleryRoute(hash: string): GalleryRoute | null {
  if (hash === '#gallery') return { view: 'browse' };
  const match = LAYOUT_HASH.exec(hash);
  return match ? { view: 'layout', id: match[1] } : null;
}
export const layoutHash = (id: string) => `#gallery=${id}`;
export const layoutLink = (id: string) => `${window.location.origin}${import.meta.env.BASE_URL}${layoutHash(id)}`;

export function credit(layout: Pick<GallerySummary, 'id' | 'title' | 'author' | 'licence'>): LayoutCredit {
  return { id: layout.id, title: layout.title, author: layout.author, licence: layout.licence };
}

/**
 * The structured top view a publish sends: the start screen's example thumbnail, as whole-millimetre numbers, simplified
 * until it is within the service's bounds.
 */
export function galleryThumbnail(project: WorkshopProject): GalleryThumbnail {
  const view = thumbnail(project);
  const numbers = (text: string) => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(value => Math.round(Number(value)));
  const [x, y, width, height] = numbers(view.viewBox);
  return withinBounds({
    box: [x, y, Math.max(1, width), Math.max(1, height)],
    tracks: view.tracks.map(track => ({ points: numbers(track.d), owned: track.owned })).filter(track => track.points.length >= 4),
    shelves: view.shelves.map(shelf => [Math.round(shelf.x), Math.round(shelf.y), Math.max(1, Math.round(shelf.width)), Math.max(1, Math.round(shelf.height))])
  });
}

/** Ramer–Douglas–Peucker over x, y pairs: drops each point within `tolerance` mm of the line its kept neighbours draw. */
function simplify(points: number[], tolerance: number): number[] {
  const last = points.length / 2 - 1, keep = new Uint8Array(last + 1);
  keep[0] = keep[last] = 1;
  const spans: [number, number][] = [[0, last]];
  while (spans.length) {
    const [from, to] = spans.pop()!;
    const ax = points[2 * from], ay = points[2 * from + 1], dx = points[2 * to] - ax, dy = points[2 * to + 1] - ay, length = Math.hypot(dx, dy);
    let farthest = -1, distance = tolerance;
    for (let index = from + 1; index < to; index++) {
      const px = points[2 * index] - ax, py = points[2 * index + 1] - ay;
      const away = length ? Math.abs(dx * py - dy * px) / length : Math.hypot(px, py);
      if (away > distance) { farthest = index; distance = away; }
    }
    if (farthest >= 0) { keep[farthest] = 1; spans.push([from, farthest], [farthest, to]); }
  }
  return points.filter((_, index) => keep[index >> 1]);
}

/**
 * The view within `THUMBNAIL_POINTS` and `THUMBNAIL_BYTES`: collinear points go first, then curves coarsen (the tolerance
 * doubling from a 4000th of the view); a layout with more tracks than that leaves room for keeps its longest ones.
 */
function withinBounds(view: GalleryThumbnail): GalleryThumbnail {
  const bytes = (value: unknown) => JSON.stringify(value).length;
  const span = Math.max(view.box[2], view.box[3]);
  for (let tolerance = 0; tolerance <= 2 * span; tolerance = tolerance ? tolerance * 2 : span / 4000) {
    const tracks = view.tracks.map(track => ({ ...track, points: simplify(track.points, tolerance) }));
    if (tracks.reduce((sum, track) => sum + track.points.length / 2, 0) <= THUMBNAIL_POINTS && bytes({ ...view, tracks }) <= THUMBNAIL_BYTES) {
      return { ...view, tracks };
    }
  }
  const ends = view.tracks.map(track => ({ ...track, points: [...track.points.slice(0, 2), ...track.points.slice(-2)] }));
  const lengths = ends.map(({ points }) => Math.hypot(points[2] - points[0], points[3] - points[1]));
  const kept = new Uint8Array(ends.length);
  let points = 0, size = bytes({ ...view, tracks: [] });
  for (const index of lengths.map((_, index) => index).sort((a, b) => lengths[b] - lengths[a])) {
    points += 2;
    size += bytes(ends[index]) + 1;
    if (points > THUMBNAIL_POINTS || size > THUMBNAIL_BYTES) break;
    kept[index] = 1;
  }
  return { ...view, tracks: ends.filter((_, index) => kept[index]) };
}

export async function listGallery(before: string | null = null): Promise<GalleryPage> {
  return await apiJson<GalleryPage>(`gallery${before ? `?before=${encodeURIComponent(before)}` : ''}`, { fallback: 'Could not load the gallery.' });
}

/** The layout page's record, and its shared copy as a project (validated like any saved file). */
export async function loadLayout(id: string): Promise<{ layout: GalleryLayout; project: WorkshopProject }> {
  const layout = await apiJson<GalleryLayout>(`gallery/${encodeURIComponent(id)}`, { fallback: 'Could not open the layout.' });
  return { layout, project: parseProject(JSON.stringify(layout.project)) };
}

export async function publishLayout(project: WorkshopProject, title: string, description: string): Promise<GalleryLayout> {
  return await apiJson<GalleryLayout>('gallery', { json: { title, description, project: stripForPublish(project), thumbnail: galleryThumbnail(project) },
    fallback: 'Could not publish the layout.' });
}

export async function reportLayout(id: string, reason: string): Promise<void> {
  await apiFetch(`gallery/${encodeURIComponent(id)}/report`, { json: { reason }, fallback: 'Could not send the report.' });
}

export async function unpublishLayout(id: string): Promise<void> {
  await apiFetch(`gallery/${encodeURIComponent(id)}`, { method: 'DELETE', fallback: 'Could not unpublish the layout.' });
}

export async function hideLayout(id: string, reason: string): Promise<GalleryLayout> {
  return await apiJson<GalleryLayout>(`gallery/${encodeURIComponent(id)}/hide`, { json: { reason }, fallback: 'Could not hide the layout.' });
}

export async function unhideLayout(id: string): Promise<GalleryLayout> {
  return await apiJson<GalleryLayout>(`gallery/${encodeURIComponent(id)}/unhide`, { method: 'POST', fallback: 'Could not show the layout again.' });
}

/** What a remix starts from (R27): the print setup of the member's most recent project and their saved calibrations, or a
 * new project's setup and none for a visitor. */
export interface RemixSetup { setup: PrintSetup; calibrations: CalibrationProfile[] }
const setupOf = (project: WorkshopProject): PrintSetup =>
  ({ printer: project.printer, material: project.material, printSettings: structuredClone(project.printSettings) });

export async function remixSetup(member: boolean): Promise<RemixSetup> {
  const fallback = setupOf(createStandardProject(''));
  if (!member) return { setup: fallback, calibrations: [] };
  const fail = 'Could not load your print setup.';
  const [latest] = await apiJson<{ id: string; revision: string }[]>('projects', { fallback: fail });
  const setup = latest ? setupOf(parseProject(await (await apiFetch(
    `projects/${encodeURIComponent(latest.id)}/${encodeURIComponent(latest.revision)}`, { fallback: fail })).text())) : fallback;
  return { setup, calibrations: await loadCalibrations() };
}

/** The remixer's newest calibration that fits this setup, if any; never the original author's (R27). */
export function withNewestFit(project: WorkshopProject, calibrations: readonly CalibrationProfile[]): WorkshopProject {
  const newest = savedCalibrations(project, calibrations).find(item => item.applicable);
  return newest ? applyCalibration(project, newest.profile) : project;
}

/** The remix as it opens in the editor: the layout and its credits, the remixer's own setup and fit. */
export function remixLayout(layout: GalleryLayout, project: WorkshopProject, { setup, calibrations }: RemixSetup, account: string | null): WorkshopProject {
  return withNewestFit(remixOf(project, [credit(layout), ...layout.ancestors], setup, account), calibrations);
}
