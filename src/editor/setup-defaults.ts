import { changeProject, createProject, setMeasurement, type Car, type MeasurementKey, type WorkshopProject } from '../domain/project';
import { printerPreset } from '../domain/printer';
import { BRICK_TRACK } from '../domain/track';
import { OWNED_DEFINITIONS } from '../domain/pieces';
import { catalogueCar, type TrainSet } from '../domain/trains';
import exampleSet from './example-train.json';

export const MEASUREMENT_LABELS: Record<MeasurementKey, string> = {
  railGauge: 'Rail centre spacing', railInterfaceWidth: 'Rail interface width',
  railBodyWidth: 'Printed rail body width', railBaseThickness: 'Rail base thickness',
  railHeight: 'Rail top height', roomWidth: 'Room width', roomDepth: 'Room depth', availableApproachRun: 'Maximum ramp length'
};

/** Starting sizes shown as muted defaults; the fit ignores them until the user types a value. */
export const MEASUREMENT_DEFAULTS: Partial<Record<MeasurementKey, number>> = { roomWidth: 2400, roomDepth: 2100 };

/** Default gap between a custom car and the next, mm. */
export const TYPICAL_COUPLER_GAP = 8;
/** The example train, so Test drive plays before the user picks theirs: the 60052 Cargo Train, copied from the
 * catalogue entry in public/trains/index.json (tests keep the two equal). */
const EXAMPLE_SET = exampleSet as TrainSet;

const NO_TRACK: Record<string, number> = Object.fromEntries(OWNED_DEFINITIONS.map(definition => [definition.family, 0]));
/** Owned counts for every official shape. `city` is the track in a typical starter set (e.g. 60337: 16 curves, 8 straights). */
export type InventoryPreset = 'city' | 'none';
export const INVENTORY_PRESETS: Readonly<Record<InventoryPreset, Readonly<Record<string, number>>>> = {
  city: { ...NO_TRACK, brick_straight_nominal: 8, brick_curve_r40: 16 },
  none: NO_TRACK
};

export function inventoryMatches(project: WorkshopProject, preset: InventoryPreset): boolean {
  return OWNED_DEFINITIONS.every(({ family }) => (project.inventory[family] ?? 0) === INVENTORY_PRESETS[preset][family]);
}

export function setSetupInventoryPreset(project: WorkshopProject, preset: InventoryPreset): WorkshopProject {
  if (inventoryMatches(project, preset)) return project;
  return changeProject(project, draft => { Object.assign(draft.inventory, INVENTORY_PRESETS[preset]); });
}

const STARTING_PART_DESIGN: Record<string, number> = {
  deck_width: BRICK_TRACK.bodyWidth, deck_thickness: BRICK_TRACK.baseThickness,
  joint_width: 10, joint_depth: 8, joint_height: 3, joint_clearance: 0.25, joint_length: 12,
  foot_length: 40, foot_width: 28, foot_thickness: 4,
  stem_width: 8, stem_depth: 8, seat_width: 45, seat_depth: 24, seat_thickness: 4,
  reach: 40, plate_width: 24, plate_thickness: 5, arm_width: 8, arm_thickness: 8,
  hole_diameter: 5, hole_spacing: 35, coupon_body_length: 50
};

export function createStandardProject(name: string): WorkshopProject {
  const project = createProject(name);
  for (const [key, value] of Object.entries(MEASUREMENT_DEFAULTS) as [MeasurementKey, number][]) {
    project.measurements[key] = { value, source: 'Default', status: 'estimate' };
  }
  project.inventory = { ...INVENTORY_PRESETS.city };
  project.partDesign = { ...STARTING_PART_DESIGN };
  project.cars = EXAMPLE_SET.cars.map(car => ({ ...catalogueCar(EXAMPLE_SET, car), example: true }));
  const preset = printerPreset(project.printer);
  project.material = preset.material;
  project.printSettings = { profile: preset.profile, nozzleMm: preset.nozzleMm, orientation: 'flat' };
  return project;
}

/** Typing a value records it as the user's own; clearing it returns to the default, if any. */
export function setSetupMeasurement(project: WorkshopProject, key: MeasurementKey, value: number | null): WorkshopProject {
  const fallback = MEASUREMENT_DEFAULTS[key];
  if (value !== null || fallback === undefined) return setMeasurement(project, key, value);
  return changeProject(project, draft => { draft.measurements[key] = { value: fallback, source: 'Default', status: 'estimate' }; });
}

/** A new printer changes its process suggestion without replacing a chosen spool. */
export function setSetupPrinter(project: WorkshopProject, printer: WorkshopProject['printer']): WorkshopProject {
  if (project.printer === printer) return project;
  const preset = printerPreset(printer);
  return changeProject(project, draft => {
    draft.printer = printer;
    draft.material ??= preset.material;
    draft.printSettings.profile = preset.profile;
    draft.printSettings.nozzleMm = preset.nozzleMm;
    draft.printSettings.orientation = 'flat';
  });
}

export function setSetupInventory(project: WorkshopProject, family: string, count: number): WorkshopProject {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Enter a whole number of owned pieces.');
  return changeProject(project, draft => { draft.inventory[family] = count; });
}

/** Adds each car, or replaces the one with its id, in order; the first real car replaces the example train. */
export function setSetupCars(project: WorkshopProject, ...cars: Car[]): WorkshopProject {
  const real = cars.map(car => {
    if (!car.name.trim() || ![car.length, car.width, car.height, car.wheelbase].every(value => Number.isFinite(value) && value > 0) ||
      car.wheelbase > car.length || !Number.isFinite(car.couplerGap) || car.couplerGap < 0) {
      throw new Error('Enter a name, length, width and height, and a wheelbase no longer than the car.');
    }
    const copy: Car = { ...car };
    delete copy.example;
    if (!copy.loadDescription?.trim()) delete copy.loadDescription;
    return copy;
  });
  return changeProject(project, draft => {
    draft.cars = draft.cars.filter(item => !item.example);
    for (const car of real) {
      const index = draft.cars.findIndex(item => item.id === car.id);
      if (index < 0) draft.cars.push(car);
      else draft.cars[index] = car;
    }
  });
}
