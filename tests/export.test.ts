import { describe, expect, it } from 'vitest';
import { CARS_NEEDED_MESSAGE, changeProject, createProject, missingPrintMeasurements, MEASUREMENT_KEYS, setMeasurement, type Car, type WorkshopProject } from '../src/domain/project';
import { calibrationKey, effectiveFitAdjustment, setFitAdjustment } from '../src/domain/calibration';
import { calibrationProcess } from '../src/domain/printer';
import { freezeManifest, printedPieceName } from '../src/export/manifest';
import { couponTrial, gradeTrial, printSelection } from '../src/export/actions';
import { matchingCoupon, matchingGrade, type ArtifactReceipt } from '../src/export/receipt';
import { fitProject } from '../src/fitting/fit';
import { createStandardProject } from '../src/editor/setup-defaults';
import { placePiece, setPieceSource } from '../src/editor/operations';
import { overpass, WAGON } from './overpass';

/** Domain's shared overpass, with support dimensions so its columns and brackets are printable. */
function printableOverpass(cars?: Car[]): WorkshopProject {
  const project = overpass(cars ? { cars } : {});
  project.partDesign = { ...createStandardProject('Supports').partDesign };
  return project;
}

describe('layout export', () => {
  it.each(['printed_straight', 'printed_curve_r56', 'vertical_transition'] as const)(
    'exports a standard %s without any measurements', family => {
      const initial = createStandardProject('Optional measurements');
      for (const key of MEASUREMENT_KEYS) initial.measurements[key] = { value: null, source: 'unknown' };
      const [project] = placePiece(initial, family, { x: 500, y: 500, rise: 6, sweep: Math.PI / 8 });
      const fit = fitProject(project);
      const manifest = freezeManifest(project, fit);
      expect(missingPrintMeasurements(project)).toEqual([]);
      expect(manifest.routes).toEqual(project.routes);
      expect(manifest.requiredPrintedInstanceIds).toEqual(fit.partInstances.map(part => part.id));
      expect(manifest.instances.some(part => part.family === (family === 'printed_curve_r56' ? 'printed_curve' : family))).toBe(true);
    });

  it.each(['brick_straight_nominal', 'brick_curve_r40'] as const)(
    'keeps placed %s pieces and exports printed parts despite an inventory shortage', family => {
      for (const stock of [0, 1, 2]) {
        let project = createStandardProject('Advisory inventory');
        project.inventory[family] = stock;
        project = placePiece(project, family, { x: 100, y: 100 }, 0)[0];
        project = placePiece(project, family, { x: 500, y: 500 }, 0)[0];
        project = placePiece(project, 'printed_straight', { x: 1000, y: 1000 }, 0)[0];
        const fit = fitProject(project);
        expect(fit.geometryFeasible).toBe(true);
        const shortfalls = fit.issues.filter(issue => issue.code === 'owned-piece-unavailable');
        expect(shortfalls).toHaveLength(stock < 2 ? 1 : 0);
        expect(shortfalls.every(issue => issue.severity === 'warning')).toBe(true);
        const manifest = freezeManifest(project, fit);
        expect(manifest.instances.filter(part => part.source === 'owned').map(part => part.family)).toEqual([family, family]);
        const printed = manifest.instances.filter(part => part.source === 'printed');
        expect(printed.map(part => part.family)).toEqual(['printed_straight']);
        expect(manifest.requiredPrintedInstanceIds).toEqual([printed[0].id]);
        expect(project.inventory[family]).toBe(stock);
      }
    });

  it('names each layout piece for the guide, the plates and the slicer', () => {
    const climb = (rise: number) => printedPieceName({ id: 'c', family: 'track_climb', x: 0, y: 0, z: 0, heading: 0, params: { rise } });
    expect([climb(40), climb(-24)]).toEqual(['Climb +40 mm', 'Climb −24 mm']);
    const [project] = placePiece(createStandardProject('Names'), 'printed_curve_r56', { x: 500, y: 500, sweep: Math.PI / 8 });
    expect(freezeManifest(project, fitProject(project)).pieceNames).toEqual({ [project.routes[0].pieces[0].id]: 'Curve R56' });
  });

  it('rejects an empty layout and exports a single printed piece', () => {
    const project = createStandardProject('Single piece');
    expect(() => freezeManifest(project, fitProject(project))).toThrow();
    const [placed] = placePiece(project, 'printed_straight', { x: 500, y: 500 });
    expect(freezeManifest(placed, fitProject(placed)).instances.map(part => part.family)).toEqual(['printed_straight']);
  });

  it('requires the rail profile for a legacy custom-joiner layout', () => {
    const initial = createStandardProject('Custom rail');
    initial.trackSystem = 'custom-joiner-v1';
    let [project] = placePiece(initial, 'printed_straight', { x: 500, y: 500 });
    const profile = { railGauge: 38, railInterfaceWidth: 12, railBodyWidth: 60, railBaseThickness: 4, railHeight: 5 } as const;
    expect(missingPrintMeasurements(project)).toEqual(Object.keys(profile));
    expect(() => freezeManifest(project, fitProject(project))).toThrow();
    for (const key of Object.keys(profile) as (keyof typeof profile)[]) project = setMeasurement(project, key, profile[key]);
    expect(freezeManifest(project, fitProject(project)).instances[0].parameters).toMatchObject({ rail_gauge: 38, rail_interface_width: 12 });
  });

  it('asks for real cars before exporting an overpass, ignoring the example train', () => {
    const example = printableOverpass([{ ...WAGON, example: true }]);
    expect(() => freezeManifest(example, fitProject(example))).toThrow(CARS_NEEDED_MESSAGE);
    const measured = printableOverpass();
    const fit = fitProject(measured);
    const manifest = freezeManifest(measured, fit);
    expect(manifest.billOfMaterials.find(item => item.family === 'bridge_deck')?.count).toBe(1);
    expect(manifest.requiredPrintedInstanceIds).toEqual(fit.partInstances.filter(part => part.source === 'printed').map(part => part.id));
    expect(manifest.billOfMaterials.flatMap(item => item.instanceIds).sort()).toEqual(fit.partInstances.map(part => part.id).sort());
  });

  it('switches supports to brackets for anchored mounting', () => {
    const project = { ...printableOverpass(), mounting: 'anchored' as const };
    const manifest = freezeManifest(project, fitProject(project));
    expect(manifest.instances.some(part => part.family === 'anchored_bracket')).toBe(true);
    expect(manifest.instances.some(part => part.family === 'reversible_column')).toBe(false);
  });

  it('rejects a fit from another layout revision', () => {
    const [project] = placePiece(createStandardProject('Stale'), 'printed_straight', { x: 500, y: 500 });
    expect(() => freezeManifest({ ...project, layoutRevision: crypto.randomUUID() }, fitProject(project))).toThrow();
  });
});

describe('print selection and trial matching', () => {
  it('fills unset printer settings from the printer preset and rejects a blank process', () => {
    const project = createStandardProject('A1 selection');
    project.printer = 'A1 mini';
    project.material = 'Generic PLA';
    project.printSettings = { profile: null, nozzleMm: null, orientation: 'flat' };
    expect(printSelection(project)).toMatchObject({
      name: 'A1 mini', material: 'Generic PLA', profile: '0.20mm Standard @BBL A1M',
      nozzleMm: 0.4, orientation: 'flat', envelope: { x: 180, y: 180, z: 180 }
    });
    project.printSettings.profile = '';
    expect(() => printSelection(project)).toThrow();
  });

  it('matches a calibration sample to its interface and print settings, independently of layout', () => {
    const project = createStandardProject('Reusable calibration');
    const part = couponTrial(project).parts[0];
    const receipt: ArtifactReceipt = {
      id: 'candidate-trial', partRevision: project.revision, layoutRevision: project.layoutRevision,
      printer: printSelection(project), cadSourceCurrent: true, assemblyGuide: 'fit-coupon.md',
      parts: [{
        instanceId: part.id, family: part.family, parameters: part.parameters,
        partRevision: project.revision, layoutRevision: project.layoutRevision,
        assemblyPose: null, digest: 'a'.repeat(64), requestDigest: 'b'.repeat(64),
        mesh: 'coupon.stl', source: 'coupon.py', plate: 1, plateLabel: 'Calibration sample'
      }], plates: []
    };
    expect(matchingCoupon(project, receipt)).toBe(true);
    expect(matchingCoupon({ ...project, layoutRevision: crypto.randomUUID() }, receipt)).toBe(true);
    expect(matchingCoupon(project, { ...receipt, parts: [{ ...receipt.parts[0],
      parameters: { ...part.parameters, fit_adjustment: .1 } }] })).toBe(false);
    expect(matchingCoupon(project, { ...receipt, cadSourceCurrent: false })).toBe(false);
    expect(matchingCoupon(project, { ...receipt, manifest: 'layout.json' })).toBe(false);
    expect(matchingCoupon(project, { ...receipt, printer: { ...receipt.printer, material: 'Generic PLA' } })).toBe(false);
    const custom = { ...project, trackSystem: 'custom-joiner-v1' as const };
    expect(matchingCoupon(custom, receipt)).toBe(false);
  });

  it('uses each entered custom rail dimension in the calibration sample and nominal values for the rest', () => {
    const initial = createProject('Refine joiner');
    initial.trackSystem = 'custom-joiner-v1';
    initial.partDesign = { joint_width: 10, joint_depth: 8, joint_height: 3, joint_clearance: .25, coupon_body_length: 50 };
    const edited = setMeasurement(setMeasurement(initial, 'railGauge', 41), 'railHeight', 12);
    expect(couponTrial(edited).parts[0].parameters).toMatchObject({
      rail_gauge: 41, rail_height: 12, body_width: 60, rail_width: 4, base_thickness: 4
    });
  });

  it('does not confuse two same-shape grade rigs on different routes', () => {
    let project = createStandardProject('Two ramps');
    project = placePiece(project, 'vertical_transition', { x: 100, y: 100, rise: 20 }, 0)[0];
    project = placePiece(project, 'vertical_transition', { x: 100, y: 900, rise: 20 }, 0)[0];
    const [first, second] = project.routes.map(route => route.id);
    const fit = fitProject(project);
    const upper = gradeTrial(project, fit, first).parts;
    const lower = gradeTrial(project, fit, second).parts;
    expect(upper.map(part => part.parameters)).toEqual(lower.map(part => part.parameters));
    const receipt = { layoutRevision: project.layoutRevision, printer: printSelection(project), cadSourceCurrent: true,
      parts: lower.map(part => ({ instanceId: part.id, family: part.family, parameters: part.parameters }))
    } as unknown as ArtifactReceipt;
    expect(matchingGrade(project, fit, receipt)).toBe(second);
    receipt.parts[0].instanceId = upper[0].id;
    expect(matchingGrade(project, fit, receipt)).toBeNull();
    receipt.parts = upper.map(part => ({ instanceId: part.id, family: part.family, parameters: part.parameters })) as ArtifactReceipt['parts'];
    expect(matchingGrade(project, fit, receipt)).toBe(first);
    expect(matchingGrade(project, fit, { ...receipt, cadSourceCurrent: false })).toBeNull();
    expect(matchingGrade({ ...project, layoutRevision: crypto.randomUUID() }, fit, receipt)).toBeNull();
  });
});

describe('fast print pieces', () => {
  const printedIds = (project: WorkshopProject) => project.routes.flatMap(route => route.pieces)
    .filter(piece => !piece.family.startsWith('brick_')).map(piece => piece.id);
  const fast = (project: WorkshopProject, ids = printedIds(project)) => setPieceSource(project, ids, 'fast');

  it('marks only fast printed track pieces; owned track, supports and full-detail pieces keep their identity', () => {
    let project = printableOverpass();
    project.inventory.brick_straight_nominal = 1;
    project = placePiece(project, 'brick_straight_nominal', { x: 100, y: 100 }, 0)[0];
    project = placePiece(project, 'printed_switch_left', { x: 100, y: 1500 }, 0)[0];
    const detailed = fitProject(project).partInstances;
    const instances = fitProject(fast(project)).partInstances;
    expect(instances.map(part => part.id)).toEqual(detailed.map(part => part.id));
    const track = instances.filter(part => part.source === 'printed' && ['rail', 'track-assembly'].includes(part.interfaceKind));
    expect(new Set(track.map(part => part.family))).toEqual(new Set(['printed_straight', 'vertical_transition', 'bridge_deck', 'printed_switch_left']));
    for (const part of instances) {
      const before = detailed.find(item => item.id === part.id)!;
      expect(part.parameters).toEqual(track.includes(part) ? { ...before.parameters, lite: 1 } : before.parameters);
    }
    expect(instances.some(part => part.source === 'owned')).toBe(true);
    expect(instances.some(part => part.interfaceKind === 'mounting')).toBe(true);
    expect(detailed.every(part => !('lite' in part.parameters))).toBe(true);
    const switchId = project.routes.at(-1)!.pieces[0].id;
    const one = fitProject(fast(project, [switchId])).partInstances.filter(part => part.parameters.lite === 1);
    expect(one.map(part => part.id)).toEqual([switchId]);
  });

  it('prints the connector sample at the process of the style the layout uses', () => {
    let detailed = placePiece(createStandardProject('Fast sample'), 'vertical_transition', { x: 100, y: 100, rise: 20 }, 0)[0];
    const project = fast(detailed);
    const fit = fitProject(project);
    expect(freezeManifest(project, fit).printer.profile).toBe('0.20mm Standard @BBL X1C');
    expect(couponTrial(detailed).printer.profile).toBe('0.20mm Standard @BBL X1C');
    expect(couponTrial(project).printer.profile).toBe('0.28mm Extra Draft @BBL X1C');
    expect(couponTrial(project).parts[0].parameters).toEqual(couponTrial(detailed).parts[0].parameters);
    expect(gradeTrial(project, fit, project.routes[0].id).parts.every(part => part.parameters.lite === 1)).toBe(true);
    const a1 = fast(changeProject(detailed, draft => { draft.printer = 'A1 mini'; draft.printSettings.profile = '0.20mm Standard @BBL A1M'; }));
    expect(couponTrial(a1).printer.profile).toBe('0.28mm Extra Draft @BBL A1M');
    // A mix follows the style with more pieces until the user picks one.
    detailed = placePiece(detailed, 'printed_straight', { x: 900, y: 900 }, 0)[0];
    detailed = placePiece(detailed, 'printed_straight', { x: 1500, y: 1500 }, 0)[0];
    const [ramp, first, second] = printedIds(detailed);
    expect(calibrationProcess(fast(detailed, [ramp]))).toBe('0.20mm Standard @BBL X1C');
    const mostlyFast = fast(detailed, [ramp, first]);
    expect(calibrationProcess(mostlyFast)).toBe('0.28mm Extra Draft @BBL X1C');
    const chosen = changeProject(mostlyFast, draft => { draft.printSettings.calibrationStyle = 'detailed'; });
    expect(couponTrial(chosen).printer.profile).toBe('0.20mm Standard @BBL X1C');
    expect(couponTrial(fast(chosen, [second])).printer.profile).toBe('0.28mm Extra Draft @BBL X1C');
  });

  it('never reuses a full-detail calibration sample or fit for fast print', () => {
    const detailed = setFitAdjustment(placePiece(createStandardProject('Calibrated'), 'printed_straight', { x: 500, y: 500 })[0], .1);
    const project = fast(detailed);
    expect(calibrationKey(project)).not.toBe(calibrationKey(detailed));
    expect(effectiveFitAdjustment(project)).toBe(0);
    const trial = couponTrial(detailed), part = trial.parts[0];
    const receipt = {
      id: 'detailed-sample', layoutRevision: detailed.layoutRevision, printer: trial.printer, cadSourceCurrent: true,
      parts: [{ instanceId: part.id, family: part.family, parameters: part.parameters }], plates: []
    } as unknown as ArtifactReceipt;
    const calibrated = setFitAdjustment(project, .1);
    expect(matchingCoupon(detailed, receipt)).toBe(true);
    expect(matchingCoupon(calibrated, receipt)).toBe(false);
    expect(matchingCoupon(calibrated, { ...receipt, printer: couponTrial(calibrated).printer })).toBe(true);
  });

  it('does not apply to the legacy custom joiner', () => {
    const initial = createStandardProject('Custom fast');
    initial.trackSystem = 'custom-joiner-v1';
    const [project] = placePiece(initial, 'printed_straight', { x: 500, y: 500 });
    expect(() => fast(project)).toThrow('Fast print needs standard brick track.');
    project.routes[0].pieces[0].style = 'fast';
    expect(fitProject(project).partInstances[0].parameters).not.toHaveProperty('lite');
    expect(calibrationProcess(project)).toBe(printSelection(project).profile);
  });
});
