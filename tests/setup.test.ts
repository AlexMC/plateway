import { describe, expect, it } from 'vitest';
import { missingPrintMeasurements, parseProject, serializeProject } from '../src/domain/project';
import { MEASUREMENT_DEFAULTS, createStandardProject, inventoryMatches, setSetupCars, setSetupInventory, setSetupInventoryPreset, setSetupMeasurement, setSetupPrinter } from '../src/editor/setup-defaults';
import { railDimension } from '../src/domain/track';

const actualCar = { id: 'loco', name: 'Cargo locomotive', length: 180, width: 64, height: 118, wheelbase: 115, couplerGap: 8, loadDescription: 'Ballasted, crane lowered' };

describe('planning setup', () => {
  it('starts with library geometry, a starter set of track, default room size and an example train, without inventing measurements', () => {
    const project = createStandardProject('Fresh workspace');
    expect(railDimension(project, 'railGauge')).toBe(40);
    expect(project.measurements.railGauge.value).toBeNull();
    expect(project.measurements.roomWidth).toMatchObject({ value: MEASUREMENT_DEFAULTS.roomWidth, status: 'estimate' });
    expect(missingPrintMeasurements(project)).toEqual([]);
    expect(project.cars.length).toBeGreaterThan(1);
    expect(project.cars.every(car => car.example && car.wheelbase <= car.length)).toBe(true);
    expect(project.observations).toEqual([]);
    expect(project.connectorFit.calibrationId).toBeNull();
    expect(parseProject(serializeProject(project)).cars.every(car => car.example)).toBe(true);
    expect(Object.entries(project.inventory).filter(([, count]) => count > 0)).toEqual([['brick_straight_nominal', 8], ['brick_curve_r40', 16]]);
  });

  it('treats a typed value as measured and restores the default when it is cleared', () => {
    const project = createStandardProject('Room');
    const typed = setSetupMeasurement(project, 'roomWidth', 1800);
    expect(typed.measurements.roomWidth.value).toBe(1800);
    expect(typed.measurements.roomWidth.status).not.toBe('estimate');
    expect(setSetupMeasurement(typed, 'roomWidth', null).measurements.roomWidth)
      .toMatchObject({ value: MEASUREMENT_DEFAULTS.roomWidth, status: 'estimate' });
    const ramp = setSetupMeasurement(project, 'availableApproachRun', 600);
    expect(setSetupMeasurement(ramp, 'availableApproachRun', null).measurements.availableApproachRun.value).toBeNull();
    const custom = { ...project, trackSystem: 'custom-joiner-v1' as const };
    expect(missingPrintMeasurements(setSetupMeasurement(custom, 'railGauge', 40))).not.toContain('railGauge');
  });

  it('switches to a compatible A1 mini process and nozzle while retaining a custom spool', () => {
    const initial = createStandardProject('Printer switch');
    const custom = { ...initial, material: 'Generic PLA', printSettings: { ...initial.printSettings, nozzleMm: 0.6 } };
    const switched = setSetupPrinter(custom, 'A1 mini');
    expect(switched.printer).toBe('A1 mini');
    expect(switched.material).toBe('Generic PLA');
    expect(switched.printSettings).toEqual({ profile: '0.20mm Standard @BBL A1M', nozzleMm: 0.4, orientation: 'flat' });
    expect(initial.printSettings.profile).toBe('0.20mm Standard @BBL X1C');
    expect(setSetupPrinter(switched, 'X1 Carbon').printSettings.profile).toBe('0.20mm Standard @BBL X1C');
  });

  it('replaces the example train with the first real car and keeps the order of later cars', () => {
    const initial = createStandardProject('Train');
    const originalInventory = structuredClone(initial.inventory);
    const inventory = setSetupInventory(initial, 'brick_curve_r40', 3);
    expect(inventory.inventory.brick_curve_r40).toBe(3);
    expect(initial.inventory).toEqual(originalInventory);
    expect(() => setSetupInventory(initial, 'brick_straight_nominal', 1.5)).toThrow();
    const cleared = setSetupInventoryPreset(inventory, 'none');
    expect(Object.values(cleared.inventory).every(count => count === 0)).toBe(true);
    expect([inventoryMatches(inventory, 'city'), inventoryMatches(cleared, 'none')]).toEqual([false, true]);
    expect(setSetupInventoryPreset(cleared, 'city').inventory).toEqual(initial.inventory);
    const loco = setSetupCars(inventory, actualCar);
    expect(loco.cars.map(car => car.id)).toEqual(['loco']);
    const wagon = setSetupCars(loco, { ...actualCar, id: 'wagon', name: 'Flatbed', length: 145, loadDescription: '' });
    const edited = setSetupCars(wagon, { ...actualCar, width: 68 });
    const restored = parseProject(serializeProject(edited));
    expect(restored.cars.map(car => [car.name, car.width, car.loadDescription, car.example])).toEqual([
      ['Cargo locomotive', 68, 'Ballasted, crane lowered', undefined], ['Flatbed', 64, undefined, undefined]
    ]);
    expect(() => setSetupCars(initial, { ...actualCar, wheelbase: 250 })).toThrow();
    expect(setSetupCars(initial, { ...actualCar, example: true }).cars.every(car => !car.example)).toBe(true);
  });
});
