import { registerFurnitureType, validFurnitureType } from './furniture';
import { registerLibraryPiece } from './pieces';
import { meshEndsProblem, meshPiece, type MeshEnd } from './pieces/families/community';
import { LIBRARY_ID, MAX_OUTLINE_POINTS, isObject, libraryAsset, validNumber, type LibraryOrigin } from './project';
import { POWER_NOTES, registerLibraryTrain, type TrainCar, type TrainPower } from './trains';

/**
 * The community library index (KTD9): `index.json` at the root of the public-read `plateway-library` bucket, which the
 * service serves at `LIBRARY_INDEX_URL` (the local bucket itself; hosted, a redirect to `PLATEWAY_LIBRARY_URL`). The app
 * loads it once at start-up and renders once the index is in; train and furniture files register later (`loadLibrary`).
 * README.md ("Community library") describes the format for the contribution tooling; a piece's marked ends are `MeshEnd`
 * (src/domain/pieces/families/community.ts).
 *
 * Every item has an `id` (`LIBRARY_ID`: the family of a piece or furniture type, the id of a train), a `version`, a `kind`
 * and a `state`. A `live` or `retired` item also has a `name`, a `licence`, a `credit` (the contributor's display name
 * when it was approved), one `file` (a URL relative to the index, inside the index's folder) and the lowercase hex
 * sha256 `digest` of that file. A `removed` item is a tombstone: its files are gone and the app ignores it, so layouts
 * that use it show the unavailable placeholder. A retired item is registered, so layouts that use it still open and
 * print as before, but it is not offered in the palette or the train picker.
 */
export const LIBRARY_INDEX_URL = '/api/library/index.json';
/** The library's GitHub repository, whose folders mirror the index's: an item's files sit in the same folder in both. */
export const LIBRARY_REPOSITORY = 'https://github.com/AlexMC/plateway-library/tree/main/';
export const LIBRARY_FORMAT = 1;
/** The index gives up after this long, leaving the built-in catalogue. */
const INDEX_TIMEOUT_MS = 10_000;
/** Each train or furniture file gives up after this long, from when its download starts, refusing only that item. */
const FILE_TIMEOUT_MS = 10_000;

export type LibraryKind = 'piece' | 'train' | 'furniture';
interface Listed {
  id: string; version: number; state: 'live' | 'retired'; name: string; licence: string; credit: string; file: string; digest: string;
}
/**
 * A community piece: `file` is its binary STL; `piece.ends` are its two marked ends in the STL's frame (`MeshEnd`). The app
 * registers it from this entry alone; Build and Test drive download the STL the first time a placed piece is drawn and
 * check it against `digest` (src/editor/community-mesh.ts), as the prepare does.
 */
export interface LibraryPieceItem extends Listed { kind: 'piece'; piece: { ends: [MeshEnd, MeshEnd] } }
/**
 * A community train model: `file` is one car's glTF binary in the car frame (src/domain/trains.ts), offered in Test drive
 * as a one-car set with these measurements.
 */
export interface LibraryTrainItem extends Listed {
  kind: 'train';
  train: { year: number; power: TrainPower; gauge: 'standard' | 'monorail';
    car: Pick<TrainCar, 'kind' | 'motorised' | 'length' | 'width' | 'height' | 'bogies' | 'wheelbase' | 'couplers' | 'outline' | 'triangles'> };
}
/** A community furniture preset: `file` is its `FurnitureType` JSON (src/domain/furniture.ts), whose `family` is the item id. */
export interface LibraryFurnitureItem extends Listed { kind: 'furniture' }
export interface LibraryTombstone { id: string; version: number; kind: LibraryKind; state: 'removed' }
export type LibraryItem = LibraryPieceItem | LibraryTrainItem | LibraryFurnitureItem | LibraryTombstone;
export interface LibraryIndex { format: typeof LIBRARY_FORMAT; items: LibraryItem[] }

/** How the start-up load went: whether the index loaded, and the items it lists that were refused, with why. */
export interface LibraryLoad { loaded: boolean; error?: string; refused: { id: string; reason: string }[] }
let outcome: LibraryLoad | null = null;
/** The start-up load's outcome; null before the index arrives or fails. Refusals of train and furniture files join it as they settle. */
export function libraryLoad(): LibraryLoad | null {
  return outcome;
}

/** The start-up load's train and furniture files, settled; resolved already when no load is under way. */
let filesSettled: Promise<unknown> = Promise.resolve();
/** Resolves once every train and furniture file of the start-up load has registered or been refused. */
export function librarySettled(): Promise<void> {
  return filesSettled.then(() => {});
}

/** Counts the times late items (trains, furniture) registered, so views drawn before them can draw again. */
let version = 0;
const listeners = new Set<() => void>();
/** How many times late library items have registered since the page loaded. */
export function libraryVersion(): number {
  return version;
}
/** Calls `listener` whenever late library items register; returns the unsubscribe (for `useSyncExternalStore`). */
export function onLibraryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const KINDS: readonly LibraryKind[] = ['piece', 'train', 'furniture'];
const DIGEST = /^[0-9a-f]{64}$/;

/** Why an index entry can't be used, or null when its common fields are whole. */
function listingProblem(item: Record<string, unknown>): string | null {
  if (typeof item.id !== 'string' || !LIBRARY_ID.test(item.id)) return 'Its id is not a library id.';
  if (!Number.isInteger(item.version) || (item.version as number) < 1) return 'Its version is not a whole number.';
  if (!KINDS.includes(item.kind as LibraryKind)) return 'Its kind is unknown.';
  if (item.state === 'removed') return null;
  if (item.state !== 'live' && item.state !== 'retired') return 'Its state is unknown.';
  if (![item.name, item.licence, item.credit].every(value => typeof value === 'string' && value.trim() && value.length <= 120)) return 'Its name, licence or credit is missing.';
  if (typeof item.file !== 'string' || !item.file) return 'It names no file.';
  if (typeof item.digest !== 'string' || !DIGEST.test(item.digest)) return 'Its digest is not a sha256.';
  return null;
}

function trainProblem(train: unknown): string | null {
  if (!isObject(train) || !isObject(train.car)) return 'It has no car measurements.';
  const { car } = train;
  if (!Number.isInteger(train.year) || !(train.power as string in POWER_NOTES) || !['standard', 'monorail'].includes(train.gauge as string))
    return 'Its year, power or gauge is missing.';
  if (!['loco', 'tender', 'wagon', 'coach', 'caboose', 'other'].includes(car.kind as string) || typeof car.motorised !== 'boolean' ||
    ![car.length, car.width, car.height, car.wheelbase].every(size => validNumber(size) && size > 0) || !Number.isInteger(car.triangles) ||
    !Array.isArray(car.bogies) || !car.bogies.length || !car.bogies.every(validNumber) ||
    !isObject(car.couplers) || !validNumber(car.couplers.front) || !validNumber(car.couplers.rear) || car.couplers.front <= 0 || car.couplers.rear >= 0 ||
    !Array.isArray(car.outline) || car.outline.length < 3 || car.outline.length > MAX_OUTLINE_POINTS ||
    !car.outline.every(point => Array.isArray(point) && point.length === 2 && point.every(validNumber))) return 'Its car measurements are incomplete.';
  return null;
}

/** Where an item's file is: inside the index's folder, or why not. */
function libraryFile(item: Listed, folder: URL): URL | string {
  const url = new URL(item.file, folder);
  return url.origin !== folder.origin || !url.pathname.startsWith(folder.pathname) || url.search || url.hash ? 'Its file is outside the library.' : url;
}

/** The item's folder in the library repository: the folder of its file, relative to the index (`pieces/<id>/<version>`). */
function repositoryFolder(file: URL, folder: URL): string {
  const path = decodeURIComponent(file.pathname.slice(folder.pathname.length));
  return `${LIBRARY_REPOSITORY}${path.slice(0, path.lastIndexOf('/') + 1)}`;
}

/**
 * Downloads an item's file from the index's folder, giving up after `timeout` ms; its bytes, or why they were refused (a
 * digest that differs from the index).
 */
async function checkedFile(item: Listed, folder: URL, fetcher: typeof fetch, timeout: number): Promise<ArrayBuffer | string> {
  const url = libraryFile(item, folder);
  if (typeof url === 'string') return url;
  const response = await fetcher(url.href, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) return `Its file did not download (${response.status}).`;
  const bytes = await response.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== item.digest) return 'Its file does not match the index digest.';
  return bytes;
}

/** Registers one item, a train or furniture from its checked file (a piece needs none); why it was refused, or null. */
function register(item: LibraryPieceItem | LibraryTrainItem | LibraryFurnitureItem, folder: URL, bytes?: ArrayBuffer): string | null {
  const file = libraryFile(item, folder);
  if (typeof file === 'string') return file;
  const origin: LibraryOrigin = { id: item.id, version: item.version, digest: item.digest, licence: item.licence, credit: item.credit,
    folder: repositoryFolder(file, folder), retired: item.state === 'retired' };
  if (item.kind === 'piece') {
    const ends = isObject(item.piece) && Array.isArray(item.piece.ends) && item.piece.ends.length === 2 && item.piece.ends.every(isObject) ?
      item.piece.ends as [MeshEnd, MeshEnd] : null;
    const problem = ends ? meshEndsProblem(ends) : 'It has no marked ends.';
    if (problem) return problem;
    try { registerLibraryPiece(meshPiece({ name: item.name, ends: ends!, origin, file: file.href })); } catch (error) { return (error as Error).message; }
    return null;
  }
  if (!bytes) throw new Error(`Library ${item.kind} ${item.id} registered without its file.`);
  if (item.kind === 'train') {
    const problem = trainProblem(item.train);
    if (problem) return problem;
    if (bytes.byteLength < 12 || new DataView(bytes).getUint32(0, true) !== 0x46546c67) return 'Its file is not a glTF binary.';
    const { year, power, gauge, car } = item.train;
    registerLibraryTrain({ id: item.id, name: item.name, year, theme: 'Community', power, gauge,
      source: { kind: 'library', authors: [item.credit], license: item.licence }, community: origin,
      cars: [{ ...car, id: `${item.id}/car`, name: item.name, asset: libraryAsset(item.id, item.digest), bytes: bytes.byteLength,
        bogies: [...car.bogies], couplers: { ...car.couplers }, outline: car.outline.map(([x, y]) => [x, y] as [number, number]) }] },
      bytes, item.state === 'live');
    return null;
  }
  let type: unknown;
  try { type = JSON.parse(new TextDecoder().decode(bytes)); } catch { return 'Its file is not JSON.'; }
  if (!validFurnitureType(type)) return 'Its file is not a furniture type.';
  if (type.family !== item.id) return 'Its furniture family is not its id.';
  registerFurnitureType({ ...type, community: origin });
  return null;
}

/**
 * Loads the library index and registers its pieces, trains and furniture (KTD9). Call once, at start-up.
 *
 * `indexed` resolves as soon as the index is in (or has failed): its pieces are registered from their entries, so the app
 * renders and parses the draft then, waiting for no file. Each train or furniture file downloads on its own timeout, and
 * each kind registers in index order once its own files have settled; `settled` resolves when all have. A layout parsed
 * before its furniture registered keeps the item as it is (it draws as a placeholder meanwhile), and a car keeps its
 * model reference; `onLibraryChange` tells views to draw again once they register.
 *
 * Never throws: an index that can't be loaded leaves the built-in catalogue as it is (`loaded` false), and an item whose
 * entry is incomplete, or whose file is missing or differs from its digest, is refused on its own.
 */
export function loadLibrary({ url = LIBRARY_INDEX_URL, fetcher = fetch, timeout = INDEX_TIMEOUT_MS, fileTimeout = FILE_TIMEOUT_MS }:
  { url?: string; fetcher?: typeof fetch; timeout?: number; fileTimeout?: number } = {}): { indexed: Promise<LibraryLoad>; settled: Promise<LibraryLoad> } {
  const refused: LibraryLoad['refused'] = [];
  const refuse = (id: string, problem: string | null) => { if (problem) refused.push({ id, reason: problem }); };
  let files: Promise<unknown> = Promise.resolve();
  const indexed = (async (): Promise<LibraryLoad> => {
    try {
      const signal = AbortSignal.timeout(timeout);
      const response = await fetcher(url, { signal, cache: 'no-cache' });
      if (!response.ok) throw new Error(`The library index did not load (${response.status}).`);
      const index: unknown = await response.json();
      if (!isObject(index) || index.format !== LIBRARY_FORMAT || !Array.isArray(index.items)) throw new Error('The library index has an unknown format.');
      // Files are named relative to where the index was finally served from (after the service's redirect, when hosted).
      const folder = new URL('.', new URL(response.url || url, globalThis.location?.href));
      const ids = new Set<string>(), usable: (LibraryPieceItem | LibraryTrainItem | LibraryFurnitureItem)[] = [];
      for (const item of index.items) {
        const problem = isObject(item) ? listingProblem(item) : 'It is not an object.';
        const id = isObject(item) && typeof item.id === 'string' ? item.id : '?';
        if (problem || ids.has(id)) { refuse(id, problem ?? 'It is listed twice.'); continue; }
        ids.add(id);
        if ((item as LibraryItem).state !== 'removed') usable.push(item as LibraryPieceItem | LibraryTrainItem | LibraryFurnitureItem);
      }
      // Registered in index order within each kind, so the palette and the picker list community items as the index does.
      for (const item of usable) if (item.kind === 'piece') refuse(item.id, register(item, folder));
      files = Promise.all((['furniture', 'train'] as const).map(async kind => {
        const items = usable.filter(item => item.kind === kind);
        if (!items.length) return;
        const checked = await Promise.all(items.map(item => checkedFile(item, folder, fetcher, fileTimeout).catch(error =>
          `Its file did not download (${error instanceof Error ? error.message : 'unknown error'}).`)));
        items.forEach((item, n) => { const file = checked[n]; refuse(item.id, typeof file === 'string' ? file : register(item, folder, file)); });
        outcome = { loaded: true, refused: [...refused] };
        version++;
        for (const listener of listeners) listener();
      }));
      outcome = { loaded: true, refused: [...refused] };
    } catch (error) {
      outcome = { loaded: false, error: error instanceof Error ? error.message : 'The library index did not load.', refused: [...refused] };
    }
    return outcome;
  })();
  const settled = indexed.then(async () => {
    await files;
    if (refused.length) console.warn('Library items refused:', refused);
    return outcome!;
  });
  filesSettled = settled;
  return { indexed, settled };
}
