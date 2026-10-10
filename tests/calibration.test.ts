import { describe, expect, it } from 'vitest';
import { applyCalibration, calibrationConditions, calibrationKey, calibrationParameters, effectiveFitAdjustment, savedCalibrations, setFitAdjustment, type CalibrationProfile } from '../src/domain/calibration';
import { changeProject, createProject, missingPrintMeasurements, parseProject, serializeProject, type WorkshopProject } from '../src/domain/project';
import { placePiece } from '../src/editor/operations';

const applicable = (project: WorkshopProject, profiles: CalibrationProfile[]) =>
  savedCalibrations(project, profiles).filter(item => item.applicable).map(item => item.profile);

function profile(project = createProject('Sample'), adjustmentMm = 0.1, result: CalibrationProfile['result'] = 'fits', recordedAt = '2026-09-28T12:00:00Z'): CalibrationProfile {
  return { id: crypto.randomUUID(), settingsKey: calibrationKey(project), trackSystem: project.trackSystem,
    adjustmentMm, result, recordedAt, notes: 'Printed and tried by this user', receiptId: 'trial-local', conditions: calibrationConditions(project) };
}

describe('local connector calibration', () => {
  it('reuses an exact setup across projects and route edits without claiming run evidence', () => {
    const first = createProject('First');
    const saved = profile(first);
    const [second] = placePiece(createProject('Second'), 'printed_straight', { x: 100, y: 200 });
    expect(applicable(second, [saved])).toEqual([saved]);
    const applied = applyCalibration(second, saved);
    const edited = changeProject(applied, draft => { draft.routes[0].pieces[0].x += 500; });
    expect(effectiveFitAdjustment(edited)).toBe(0.1);
    expect(calibrationParameters(edited)).toEqual({ body_length: 24, connector_version: 1, fit_adjustment: 0.1 });
    expect(edited.observations).toEqual([]);
    expect(second.connectorFit.calibrationId).toBeNull();
  });

  it('invalidates every print and track dependency while preserving the saved snapshot', () => {
    const original = setFitAdjustment(createProject('Setup'), 0.1);
    const updates = [
      (p: typeof original) => { p.printer = 'A1 mini'; },
      (p: typeof original) => { p.material = 'Generic PLA'; },
      (p: typeof original) => { p.printSettings.nozzleMm = 0.6; },
      (p: typeof original) => { p.printSettings.profile = 'Another process'; },
      (p: typeof original) => { p.trackSystem = 'custom-joiner-v1'; }
    ];
    for (const update of updates) {
      const changed = changeProject(original, update);
      expect(effectiveFitAdjustment(changed)).toBe(0);
      expect(changed.connectorFit.adjustmentMm).toBe(0.1);
      expect(applicable(changed, [profile(original)])).toEqual([]);
    }
    const oldVersion = profile(original);
    const key = JSON.parse(oldVersion.settingsKey); key[3] = 0;
    oldVersion.settingsKey = JSON.stringify(key);
    expect(() => applyCalibration(original, oldVersion)).toThrow(/does not match/);
  });

  it('enforces both adjustment boundaries and rejects non-finite values', () => {
    const project = createProject('Boundaries');
    for (const mm of [-0.15, 0, 0.15]) expect(effectiveFitAdjustment(setFitAdjustment(project, mm))).toBe(mm);
    for (const mm of [-0.15001, 0.15001, NaN, Infinity]) {
      expect(() => setFitAdjustment(project, mm)).toThrow(/adjustment/);
      expect(() => serializeProject({ ...project, connectorFit: { ...project.connectorFit, adjustmentMm: mm } })).toThrow(/fit/);
    }
    expect(() => applyCalibration(project, profile(project, 0, 'too-tight'))).toThrow(/does not match/);
  });

  it('lets a later failure supersede a pass at the same adjustment, without erasing other working adjustments', () => {
    const project = createProject('Reports');
    const pass = profile(project, 0.1);
    const failed = profile(project, 0.1, 'too-loose', '2026-09-29T12:00:00Z');
    expect(applicable(project, [pass, failed])).toEqual([]);
    const other = profile(project, 0.05, 'fits', '2026-09-27T12:00:00Z');
    expect(applicable(project, [pass, failed, other])).toEqual([other]);
  });

  it('binds custom profiles to their dimensions, while brick track ignores arbitrary custom geometry', () => {
    const project = createProject('Custom');
    const brickKey = calibrationKey(project);
    project.partDesign = { joint_width: 10, joint_height: 3, joint_depth: 8, joint_clearance: 0.25, coupon_body_length: 50 };
    expect(calibrationKey(project)).toBe(brickKey);
    project.trackSystem = 'custom-joiner-v1';
    const custom = setFitAdjustment(project, 0.1);
    expect(calibrationParameters(custom).socket_clearance).toBe(0.35);
    expect(calibrationParameters(custom).tongue_length).toBe(7.65);
    const changed = changeProject(custom, draft => { draft.partDesign.joint_width = 11; });
    expect(effectiveFitAdjustment(changed)).toBe(0);
    expect(() => applyCalibration(changed, profile(custom))).toThrow(/does not match/);
  });

  it('migrates v1-v3 to custom without converting old observations into calibration', () => {
    const project = createProject('Historical');
    project.partDesign = { joint_width: 12 };
    project.observations = [{ id: 'old-fit', kind: 'fit', passed: true, material: 'PLA', printer: 'X1 Carbon',
      orientation: 'flat', consistId: '', notes: 'Old report', recordedAt: '2025-01-01' }];
    for (const version of [1, 2, 3]) {
      const migrated = parseProject(JSON.stringify({ ...project, version }));
      expect(migrated.trackSystem).toBe('custom-joiner-v1');
      expect(migrated.connectorFit).toEqual({ adjustmentMm: 0, settingsKey: null, calibrationId: null });
      expect(migrated.observations).toEqual(project.observations);
      expect(migrated.partDesign).toEqual(project.partDesign);
      expect(missingPrintMeasurements(migrated)).toContain('railGauge');
    }
    expect(missingPrintMeasurements(project)).toEqual([]);
  });
});
