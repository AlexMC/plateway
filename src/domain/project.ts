import { CAR_GAUGES, type CarGauge } from './gauges';
import { FLEX_MAX_BEND, findPieceDefinition, registerUnavailableFamily } from './pieces';
import { migrateLegacyIds } from './legacy-ids';
export const PROJECT_VERSION = 5 as const;
export type TrackSystem = 'brick-v1' | 'custom-joiner-v1';
export const FIT_ADJUSTMENT_MIN = -0.15;
export const FIT_ADJUSTMENT_MAX = 0.15;

const RAIL_KEYS = ['railGauge', 'railInterfaceWidth', 'railBodyWidth', 'railBaseThickness', 'railHeight'] as const;
export const MEASUREMENT_KEYS = [...RAIL_KEYS, 'roomWidth', 'roomDepth', 'availableApproachRun'] as const;
/** Keys dropped from saved files: per-car dimensions replaced them. */
const RETIRED_MEASUREMENTS = ['trainHeight', 'trainWidth', 'locomotiveLength', 'longestWagonLength',
  'kallaxOpeningWidth', 'kallaxOpeningHeight', 'behindShelfDepth'];
export const CARS_NEEDED_MESSAGE = 'Add your cars in Setup to check overpass clearance.';

/** IKEA dimension drawing (mm): https://www.ikea.com/gb/en/images/products/kallax-shelving-unit-white__1215326_pe911966_s5.jpg?f=xl
 * The 38 mm outer panel is illustrative, not a measured specification; the inner divider
 * follows from the nominal opening: (1820 - 2 × 38 - 5 × 335) / 4 = 17.25 mm.
 */
export const KALLAX_5X5 = {
  width: 1820, depth: 390, height: 1820, opening: 335, outer: 38, inner: 17.25
} as const;

/** x/y are floor-plan centre coordinates; rotation is about the upright axis. `family` names a furniture type
 * (src/domain/furniture.ts); one this browser does not know opens as a placeholder and is kept as it is. */
export interface Furniture {
  id: string;
  family: string;
  x: number;
  y: number;
  quarterTurns: 0 | 1 | 2 | 3;
}

export type MeasurementKey = typeof MEASUREMENT_KEYS[number];
type Measurement =
  | { value: number; source: string; measuredAt: string; status?: 'measured' }
  | { value: number; source: string; status: 'estimate'; measuredAt?: never }
  | { value: null; source: 'unknown'; measuredAt?: never; status?: 'unknown' };

export interface Point3 { id: string; x: number; y: number; z: number }
/** Authored tiles are a route's source of truth; points mirror their end ports for older consumers. */
export interface RoutePiece {
  id: string;
  /** A registered piece family (`src/domain/pieces`). */
  family: string;
  x: number; y: number; z: number; heading: number;
  /** Signed arc sweep in radians; only curve tiles use this. */
  sweep?: number;
  /** Height gained across a transition; only ramp tiles use this. */
  rise?: number;
  bend?: number;
  /** Values of the family's `ParamSpec`s, in their declared units; absent keys take the default. */
  params?: Record<string, number>;
  /** One of the family's `StateSpec` ids; absent = the first state. */
  state?: string;
  /** Printed pieces only: rails and connectors without brick ties or studs. Absent = full detail. */
  style?: 'fast';
}
/**
 * `base`: height of the ground under the route above the table, mm (absent = 0, the table). Negative lets a line dip
 * below the table into a lowered section; supports stand on it and track may not go below it.
 */
export interface Route { id: string; name: string; points: Point3[]; pieces: RoutePiece[]; base?: number }
/** Lowest a route's ground may sit, and highest, mm. */
export const ROUTE_BASE_RANGE = [-400, 400] as const;
export function routeBase(route: Pick<Route, 'base'> | undefined): number {
  return route?.base ?? 0;
}
/** A route that passes over itself has the same upper and lower route. */
interface Crossing { id: string; upperRouteId: string; lowerRouteId: string }
/** Example cars let Test drive play before the user adds a train; they never count as the user's train.
 * `gauge` is the track its wheels need (absent = standard); `cog` marks a cog-drive bogie for rack railways.
 * A car measured from an official set model (public/trains/index.json) names it in `model` and keeps its measured shape in
 * the car frame (mm, +x forward, +y left; origin midway between the outer bogie pivots): `bogies` pivot x positions,
 * `couplers` the x of each coupling face (front > 0 > rear) and `outline` its top-view silhouette. Without them a car is
 * symmetric: wheels ±wheelbase/2 and ends ±length/2 about its centre. */
export interface Car {
  id: string; name: string; length: number; width: number; height: number; wheelbase: number; couplerGap: number;
  loadDescription?: string; example?: true; gauge?: CarGauge; cog?: true;
  model?: CarModel; bogies?: number[]; couplers?: { front: number; rear: number }; outline?: [number, number][];
}
/** `asset`: the car's glTF under public/, e.g. "trains/60052-1/loco.glb", or a library train pinned to the digest of its
 * file, e.g. "library:community_shunter@<sha256>" (`libraryAsset`). */
export interface CarModel { set: string; car: string; asset: string }
/**
 * An item id in the community library index (src/domain/library.ts): the family of a community piece or furniture
 * type, the id of a community train. The prefix keeps it apart from every built-in family.
 */
export const LIBRARY_ID = /^community_[a-z0-9_]{1,60}$/;
/**
 * A community item's provenance, what every Community mark shows: its contributor's display name, its licence, and its
 * folder in the library's GitHub repository. Registered pieces, furniture types and trains carry it as `community`.
 */
export interface Community { credit: string; licence: string; folder: string }
/** Where a registered community item came from: its index entry's id, version and file digest, and its provenance (KTD9). */
export interface LibraryOrigin extends Community { id: string; version: number; digest: string; retired: boolean }
/** A library train's model reference: no URL, only its id and the sha256 of its file, resolved through the index. */
export const libraryAsset = (id: string, digest: string) => `library:${id}@${digest}`;
/**
 * Only the app's own bundled models, or a library train named by id and digest, load; a saved file can't point the
 * viewer elsewhere. A library reference loads only while the index lists that id with that digest (src/drive/train-models.ts).
 */
export const CAR_ASSET = new RegExp(`^(?:trains/[\\w-][\\w.-]*/[\\w-][\\w.-]*\\.glb|library:${LIBRARY_ID.source.slice(1, -1)}@[0-9a-f]{64})$`);
export const MAX_OUTLINE_POINTS = 40;
export interface PhysicalObservation {
  id: string;
  kind: 'fit' | 'grade' | 'over-run' | 'under-run';
  passed: boolean;
  partRevision?: string;
  layoutRevision?: string;
  material: string;
  printer: string;
  printProfile?: string;
  nozzleMm?: number;
  orientation: string;
  consistId: string;
  mounting?: 'reversible' | 'anchored';
  interference?: boolean;
  supportMovement?: boolean;
  slope?: number;
  notes: string;
  recordedAt: string;
}
/** Printed track style: full brick detail, or rails and connectors only for faster prints. */
export type TrackStyle = 'detailed' | 'fast';
interface PrintSettings {
  profile: string | null;
  nozzleMm: number | null;
  orientation: 'flat';
  /** Which style's process the connector sample prints at when a layout mixes both; absent = the style with more pieces. */
  calibrationStyle?: TrackStyle;
}
/** A gallery layout's credit (R15, R25): its id, title, and author's display name as they were when it was published. */
export interface LayoutCredit { id: string; title: string; author: string; licence: 'CC-BY-4.0' }
export type PrintSetup = Pick<WorkshopProject, 'printer' | 'material' | 'printSettings'>;

export interface WorkshopProject {
  version: typeof PROJECT_VERSION;
  id: string;
  revision: string;
  layoutRevision: string;
  name: string;
  trackSystem: TrackSystem;
  connectorFit: { adjustmentMm: number; settingsKey: string | null; calibrationId: string | null };
  measurements: Record<MeasurementKey, Measurement>;
  routes: Route[];
  crossings: Crossing[];
  furniture: Furniture[];
  /** Owned brick pieces keyed by route piece family. */
  inventory: Record<string, number>;
  /** User-chosen CAD design dimensions in millimetres. */
  partDesign: Record<string, number>;
  cars: Car[];
  printer: 'X1 Carbon' | 'A1 mini';
  material: string | null;
  mounting: 'reversible' | 'anchored';
  printSettings: PrintSettings;
  observations: PhysicalObservation[];
  /** Whose work this copy is (R6): the account it was saved to or opened from; null while it is a visitor's. */
  provenance: { account: string | null };
  /** The saved revision this copy derives from (KTD2): the one it was opened as or last saved as; null until first saved.
   * A save names it, and the service refuses it when a newer revision was saved since. */
  parentRevision: string | null;
  /** The gallery layouts this one remixes, nearest first (R15); absent for original work. */
  ancestors?: LayoutCredit[];
}

export function createProject(name: string): WorkshopProject {
  const measurements = Object.fromEntries(MEASUREMENT_KEYS.map(key => [key, { value: null, source: 'unknown' }])) as Record<MeasurementKey, Measurement>;
  const revision = crypto.randomUUID();
  return {
    version: PROJECT_VERSION,
    id: crypto.randomUUID(), revision, layoutRevision: revision, name,
    trackSystem: 'brick-v1', connectorFit: { adjustmentMm: 0, settingsKey: null, calibrationId: null },
    measurements, routes: [], crossings: [], furniture: [], inventory: {}, cars: [], partDesign: {},
    printer: 'X1 Carbon', material: null, mounting: 'reversible', observations: [],
    printSettings: { profile: null, nozzleMm: null, orientation: 'flat' },
    provenance: { account: null }, parentRevision: null
  };
}

/** Only these fields change generated parts or plates; other edits keep the layout revision. */
function layoutSnapshot(project: WorkshopProject): string {
  return JSON.stringify([project.routes, project.crossings, project.mounting, project.printer, project.material,
    project.printSettings, project.partDesign, project.connectorFit, project.trackSystem,
    RAIL_KEYS.map(key => project.measurements[key])]);
}

export function changeProject(project: WorkshopProject, update: (draft: WorkshopProject) => void): WorkshopProject {
  const draft = structuredClone(project);
  update(draft);
  draft.revision = crypto.randomUUID();
  if (layoutSnapshot(draft) !== layoutSnapshot(project)) draft.layoutRevision = draft.revision;
  validateProject(draft);
  return draft;
}

/** A typed value is the user's own measurement; null clears it. */
export function setMeasurement(project: WorkshopProject, key: MeasurementKey, value: number | null): WorkshopProject {
  if (value !== null && (!Number.isFinite(value) || value <= 0)) throw new Error('Measurement must be positive millimetres');
  return changeProject(project, draft => {
    draft.measurements[key] = value === null
      ? { value: null, source: 'unknown' }
      : { value, source: 'Entered in Setup', measuredAt: new Date().toISOString().slice(0, 10) };
  });
}

export function realCars(project: WorkshopProject): Car[] {
  return project.cars.filter(car => !car.example);
}

/** Largest body over the user's own cars; example cars never define clearance. */
export function trainEnvelope(project: WorkshopProject): { width: number; height: number; length: number } | null {
  const cars = realCars(project);
  return cars.length ? {
    width: Math.max(...cars.map(car => car.width)),
    height: Math.max(...cars.map(car => car.height)),
    length: Math.max(...cars.map(car => car.length))
  } : null;
}

export function carsNeededForClearance(project: WorkshopProject): boolean {
  return project.crossings.length > 0 && !realCars(project).length;
}

export function missingPrintMeasurements(project: WorkshopProject): MeasurementKey[] {
  if (project.trackSystem !== 'custom-joiner-v1') return [];
  return RAIL_KEYS.filter(key =>
    project.measurements[key].value === null || project.measurements[key].status === 'estimate');
}

export function serializeProject(project: WorkshopProject): string {
  validateProject(project);
  return JSON.stringify(project);
}

/** The copy a gallery publish shares (R26): no owned-brick inventory, test-drive observations, fit calibration, printer,
 * material, print settings, account or save history. The service strips them again from whatever it is sent. */
export function stripForPublish(project: WorkshopProject): WorkshopProject {
  const blank = createProject(project.name);
  return { ...structuredClone(project), inventory: {}, observations: [], connectorFit: blank.connectorFit,
    printer: blank.printer, material: blank.material, printSettings: blank.printSettings,
    provenance: blank.provenance, parentRevision: null };
}

/** A new project from a gallery layout (R15, R27): it credits `credits` (the layout itself first, then its ancestors),
 * takes the remixer's print `setup` and `account`, and carries none of the author's private data or fit. The remixer's
 * own calibration for that setup is applied afterwards (`withNewestFit` in src/gallery). */
export function remixOf(layout: WorkshopProject, credits: readonly LayoutCredit[], setup: PrintSetup, account: string | null): WorkshopProject {
  const revision = crypto.randomUUID();
  const remix: WorkshopProject = { ...stripForPublish(layout), id: crypto.randomUUID(), revision, layoutRevision: revision,
    printer: setup.printer, material: setup.material, printSettings: structuredClone(setup.printSettings),
    provenance: { account }, ancestors: structuredClone([...credits]) };
  validateProject(remix);
  return remix;
}

/** Pieces whose family this app does not have (KTD9); they open as "unavailable piece" placeholders. */
export function unavailablePieces(project: WorkshopProject): { id: string; family: string }[] {
  return project.routes.flatMap(route => route.pieces).filter(piece => !findPieceDefinition(piece.family))
    .map(piece => ({ id: piece.id, family: piece.family }));
}

export function parseProject(text: string): WorkshopProject {
  let value: unknown = JSON.parse(text);
  const legacy = isObject(value) && [1, 2, 3].includes(value.version as number);
  // Version 5 added the draft's owner and saved parent revision; older saves are a visitor's, never saved.
  const ownerless = isObject(value) && [1, 2, 3, 4].includes(value.version as number);
  if (isObject(value) && (value.version === 1 || value.version === 2)) {
    const measurements = value.measurements;
    const partDesign = isObject(value.partDesign) ? { ...value.partDesign } : value.partDesign;
    const shelfAbsent = isObject(partDesign) && partDesign.setup_shelf_crossing === 2;
    if (isObject(partDesign)) delete partDesign.setup_shelf_crossing;
    const roomWidth = isObject(measurements) && isObject(measurements.roomWidth) && validNumber(measurements.roomWidth.value)
      ? measurements.roomWidth.value : 2400;
    const roomDepth = isObject(measurements) && isObject(measurements.roomDepth) && validNumber(measurements.roomDepth.value)
      ? measurements.roomDepth.value : 2100;
    value = {
      ...value,
      version: PROJECT_VERSION,
      partDesign: value.version === 1 ? partDesign ?? {} : partDesign,
      furniture: shelfAbsent ? [] : [{
        id: 'kallax-5x5-legacy', family: 'kallax_5x5', x: roomWidth / 2, y: roomDepth / 2, quarterTurns: 0
      }]
    };
  }
  if (legacy && isObject(value)) value = {
    ...value, version: PROJECT_VERSION, trackSystem: 'custom-joiner-v1',
    connectorFit: { adjustmentMm: 0, settingsKey: null, calibrationId: null }
  };
  if (ownerless && isObject(value)) value = { ...value, version: PROJECT_VERSION, provenance: { account: null }, parentRevision: null };
  if (isObject(value)) value = dropRetiredFields(migrateLegacyIds(value));
  if (isObject(value) && Array.isArray(value.routes)) for (const route of value.routes) {
    if (!isObject(route) || !Array.isArray(route.pieces)) continue;
    for (const piece of route.pieces) if (isObject(piece) && validFamily(piece.family) && !findPieceDefinition(piece.family)) registerUnavailableFamily(piece.family);
  }
  validateProject(value);
  return value;
}

/** Removes settings and route kinds the app no longer offers, so older saves still open. */
function dropRetiredFields(saved: Record<string, unknown>): Record<string, unknown> {
  const value = { ...saved };
  delete value.railSource;
  delete value.trialTarget;
  const cleaned = (field: 'measurements', keys: readonly string[]) => {
    if (!isObject(value[field])) return;
    const copy = { ...value[field] as Record<string, unknown> };
    for (const key of keys) delete copy[key];
    value[field] = copy;
  };
  cleaned('measurements', RETIRED_MEASUREMENTS);
  const { trackStyle, ...printSettings } = isObject(value.printSettings) ? value.printSettings : {};
  value.printSettings = { profile: null, nozzleMm: null, ...printSettings, orientation: 'flat' };
  // A project-wide fast style (briefly offered in Print) became a per-piece choice.
  if (trackStyle === 'fast' && value.trackSystem === 'brick-v1' && Array.isArray(value.routes)) {
    value.routes = value.routes.map(route => isObject(route) && Array.isArray(route.pieces) ? { ...route, pieces: route.pieces.map(piece =>
      isObject(piece) && findPieceDefinition(String(piece.family))?.styles.includes('fast') ? { ...piece, style: 'fast' } : piece) } : route);
  }
  if (Array.isArray(value.routes)) value.routes = migratePieces(value.routes);
  if (Array.isArray(value.routes)) {
    // Waypoint-only routes predate authored pieces; the builder cannot edit them.
    const dropped = new Set(value.routes.filter(route => isObject(route) && route.pieces === undefined).map(route => route.id));
    if (dropped.size) {
      value.routes = value.routes.filter(route => !isObject(route) || !dropped.has(route.id));
      if (Array.isArray(value.crossings)) value.crossings = value.crossings.filter(crossing =>
        !isObject(crossing) || !dropped.has(crossing.upperRouteId) && !dropped.has(crossing.lowerRouteId));
    }
  }
  return value;
}

/** A plain JSON object (not null, not an array): the shape every saved or downloaded record is checked against. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A family name a saved piece may carry, known to this app or not (a library item may have been removed). */
function validFamily(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 120;
}

/** Saved pieces predate `state`: turnouts and crossovers stored `switchState`. */
function migratePieces(routes: unknown[]): unknown[] {
  return routes.map(route => isObject(route) && Array.isArray(route.pieces) ? { ...route, pieces: route.pieces.map(piece => {
    if (!isObject(piece) || piece.switchState === undefined) return piece;
    const { switchState, ...rest } = piece;
    return rest.state === undefined ? { ...rest, state: switchState } : rest;
  }) } : route);
}

function validPiece(piece: unknown): boolean {
  if (!isObject(piece) || !validId(piece.id) || ![piece.x, piece.y, piece.z, piece.heading].every(validNumber) || !validFamily(piece.family)) return false;
  const definition = findPieceDefinition(piece.family), legacy = definition?.legacy ?? {};
  const params = piece.params;
  // An unavailable piece keeps whatever its family stored; only the shape every piece shares is checked.
  if (!definition) return [piece.sweep, piece.rise, piece.bend].every(value => value === undefined || validNumber(value)) &&
    (params === undefined || isObject(params) && Object.values(params).every(validNumber)) &&
    (piece.state === undefined || typeof piece.state === 'string') && (piece.style === undefined || piece.style === 'fast');
  return (legacy.sweep === undefined ? piece.sweep === undefined :
      validNumber(piece.sweep) && Math.abs(piece.sweep) > 0 && Math.abs(piece.sweep) <= Math.PI / 2) &&
    (legacy.rise === undefined ? piece.rise === undefined : validNumber(piece.rise) && Math.abs(piece.rise) <= 90) &&
    (piece.bend === undefined || legacy.bend !== undefined && validNumber(piece.bend) && Math.abs(piece.bend) <= FLEX_MAX_BEND) &&
    (params === undefined || isObject(params) && Object.entries(params).every(([key, value]) => {
      const spec = definition.params.find(item => item.key === key);
      return spec !== undefined && validNumber(value) && value >= spec.min && value <= spec.max;
    })) &&
    (piece.state === undefined || definition.states?.some(state => state.id === piece.state) === true) &&
    (piece.style === undefined || piece.style === 'fast' && definition.styles.includes('fast'));
}

/** A measured car's model reference and shape; each is optional, but a present one must be whole. */
function validCarShape(car: Record<string, unknown>): boolean {
  const { model, bogies, couplers, outline } = car;
  return (model === undefined || isObject(model) && validId(model.set) && validId(model.car) &&
      typeof model.asset === 'string' && CAR_ASSET.test(model.asset)) &&
    (bogies === undefined || Array.isArray(bogies) && bogies.length > 0 && bogies.every(validNumber)) &&
    (couplers === undefined || isObject(couplers) && validNumber(couplers.front) && validNumber(couplers.rear) &&
      couplers.front > 0 && couplers.rear < 0) &&
    (outline === undefined || Array.isArray(outline) && outline.length >= 3 && outline.length <= MAX_OUTLINE_POINTS &&
      outline.every(point => Array.isArray(point) && point.length === 2 && point.every(validNumber)));
}

export function validateProject(value: unknown): asserts value is WorkshopProject {
  if (!isObject(value) || value.version !== PROJECT_VERSION) throw new Error('Unsupported project version');
  if (!validId(value.id) || !validId(value.revision) || !validId(value.layoutRevision) || typeof value.name !== 'string' || !isObject(value.measurements) ||
    !isObject(value.provenance) || !(value.provenance.account === null || validId(value.provenance.account)) ||
    !(value.parentRevision === null || validId(value.parentRevision))) {
    throw new Error('Invalid project identity or measurements');
  }
  const connectorFit = value.connectorFit;
  if (!['brick-v1', 'custom-joiner-v1'].includes(String(value.trackSystem)) ||
    !isObject(connectorFit) || !validNumber(connectorFit.adjustmentMm) ||
    connectorFit.adjustmentMm < FIT_ADJUSTMENT_MIN || connectorFit.adjustmentMm > FIT_ADJUSTMENT_MAX ||
    !['settingsKey', 'calibrationId'].every(key => connectorFit[key] === null || validId(connectorFit[key]))) {
    throw new Error('Invalid connector fit settings');
  }
  for (const key of MEASUREMENT_KEYS) {
    const item = value.measurements[key];
    if (!isObject(item) || typeof item.source !== 'string' ||
      (item.value !== null && (!validNumber(item.value) || item.value <= 0)) ||
      (item.value === null && item.source !== 'unknown') ||
      (item.value !== null && item.status !== 'estimate' && (!item.source || !validId(item.measuredAt)))) {
      throw new Error(`Invalid project measurement: ${key}`);
    }
  }
  if (!Array.isArray(value.routes) || !Array.isArray(value.crossings) || !Array.isArray(value.furniture) || !Array.isArray(value.cars) ||
    !Array.isArray(value.observations) || !isObject(value.inventory) || !isObject(value.partDesign)) throw new Error('Invalid project collections');
  const furnitureIds = new Set<string>();
  for (const item of value.furniture) {
    if (!isObject(item) || !validId(item.id) || furnitureIds.has(item.id) ||
      !validId(item.family) || !validNumber(item.x) || !validNumber(item.y) ||
      !Number.isInteger(item.quarterTurns) || (item.quarterTurns as number) < 0 || (item.quarterTurns as number) > 3) {
      throw new Error('Invalid project furniture');
    }
    furnitureIds.add(item.id);
  }
  const routeIds = new Set<string>();
  for (const route of value.routes) {
    if (!isObject(route) || !validId(route.id) || routeIds.has(route.id) || typeof route.name !== 'string' || !Array.isArray(route.points) ||
      (route.base !== undefined && (!validNumber(route.base) || route.base < ROUTE_BASE_RANGE[0] || route.base > ROUTE_BASE_RANGE[1]))) {
      throw new Error('Invalid project route');
    }
    routeIds.add(route.id);
    for (const point of route.points) {
      if (!isObject(point) || !validId(point.id) || !validNumber(point.x) || !validNumber(point.y) || !validNumber(point.z)) {
        throw new Error(`Invalid project point in ${route.id}`);
      }
    }
    if (!Array.isArray(route.pieces) || !route.pieces.every(validPiece)) {
      throw new Error(`Invalid authored pieces in ${route.id}`);
    }
    if (new Set(route.pieces.map(piece => piece.id)).size !== route.pieces.length ||
      route.points.length !== route.pieces.length + (route.pieces.length ? 1 : 0)) {
      throw new Error(`Invalid authored route topology in ${route.id}`);
    }
  }
  for (const crossing of value.crossings) {
    if (!isObject(crossing) || !validId(crossing.id) || !routeIds.has(String(crossing.upperRouteId)) ||
      !routeIds.has(String(crossing.lowerRouteId))) {
      throw new Error('Invalid project crossing');
    }
  }
  for (const count of Object.values(value.inventory)) {
    if (!Number.isInteger(count) || (count as number) < 0) throw new Error('Invalid project inventory');
  }
  for (const dimension of Object.values(value.partDesign)) {
    if (!validNumber(dimension) || dimension <= 0) throw new Error('Part design dimensions must be positive millimetres');
  }
  for (const car of value.cars) {
    if (!isObject(car) || !validId(car.id) || typeof car.name !== 'string' || (car.example !== undefined && car.example !== true) ||
      (car.gauge !== undefined && !CAR_GAUGES.some(item => item.id === car.gauge)) || (car.cog !== undefined && car.cog !== true) ||
      !['length', 'width', 'height', 'wheelbase', 'couplerGap'].every(key => validNumber(car[key]) && (car[key] as number) >= 0) ||
      !validCarShape(car)) {
      throw new Error('Invalid project car');
    }
  }
  if (!['X1 Carbon', 'A1 mini'].includes(String(value.printer)) ||
    (value.material !== null && typeof value.material !== 'string') ||
    !['reversible', 'anchored'].includes(String(value.mounting))) throw new Error('Invalid project settings');
  const printSettings = value.printSettings;
  if (!isObject(printSettings) || printSettings.orientation !== 'flat' ||
    (printSettings.profile !== null && typeof printSettings.profile !== 'string') ||
    (printSettings.nozzleMm !== null && (!validNumber(printSettings.nozzleMm) || printSettings.nozzleMm <= 0)) ||
    (printSettings.calibrationStyle !== undefined && !['detailed', 'fast'].includes(String(printSettings.calibrationStyle)))) {
    throw new Error('Invalid print settings');
  }
  for (const observation of value.observations) {
    if (!isObject(observation) || !validId(observation.id) || !['fit', 'grade', 'over-run', 'under-run'].includes(String(observation.kind)) ||
      typeof observation.passed !== 'boolean' || !validId(observation.recordedAt) || typeof observation.notes !== 'string' ||
      typeof observation.material !== 'string' || typeof observation.printer !== 'string' ||
      typeof observation.orientation !== 'string' || typeof observation.consistId !== 'string' ||
      (observation.printProfile !== undefined && typeof observation.printProfile !== 'string') ||
      (observation.nozzleMm !== undefined && (!validNumber(observation.nozzleMm) || observation.nozzleMm <= 0)) ||
      (observation.interference !== undefined && typeof observation.interference !== 'boolean') ||
      (observation.supportMovement !== undefined && typeof observation.supportMovement !== 'boolean') ||
      (observation.mounting !== undefined && !['reversible', 'anchored'].includes(String(observation.mounting)))) {
      throw new Error('Invalid project observation');
    }
  }
  if (value.ancestors !== undefined && (!Array.isArray(value.ancestors) || !value.ancestors.every(credit => isObject(credit) &&
    validId(credit.id) && typeof credit.title === 'string' && typeof credit.author === 'string' && credit.licence === 'CC-BY-4.0'))) {
    throw new Error('Invalid remix credit');
  }
}
