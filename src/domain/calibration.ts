import { FIT_ADJUSTMENT_MAX, FIT_ADJUSTMENT_MIN, changeProject, type TrackSystem, type WorkshopProject } from './project';
import { calibrationProcess, effectivePrint } from './printer';
import { CUSTOM_RAIL_DEFAULTS, BRICK_TRACK } from './track';
import type { ArtifactReceipt } from '../export/receipt';
import { apiJson } from '../net/api';

export const CALIBRATION_PROCESS_VERSION = 1;
export interface CalibrationConditions {
  printer: string; material: string; nozzleMm: number; printProfile: string; orientation: string;
}
export interface CalibrationProfile {
  id: string;
  settingsKey: string;
  trackSystem: TrackSystem;
  adjustmentMm: number;
  result: 'fits' | 'too-tight' | 'too-loose';
  notes: string;
  receiptId: string;
  recordedAt: string;
  conditions: CalibrationConditions;
}

/** The sample prints with the track's own process, so a fast-print fit is calibrated at its layer height. */
export function calibrationConditions(project: WorkshopProject): CalibrationConditions {
  const print = effectivePrint(project);
  return { printer: print.name, material: print.material, nozzleMm: print.nozzleMm,
    printProfile: calibrationProcess(project), orientation: print.orientation };
}

function customParameters(project: WorkshopProject, adjustment: number): Record<string, number> {
  const rail = (key: keyof typeof CUSTOM_RAIL_DEFAULTS) => {
    const measurement = project.measurements[key];
    return measurement.value !== null && measurement.status !== 'estimate' ? measurement.value : CUSTOM_RAIL_DEFAULTS[key];
  };
  const design = (key: string) => project.partDesign[key] ?? 0;
  const clearance = design('joint_clearance') + adjustment;
  return { body_length: design('coupon_body_length'), body_width: rail('railBodyWidth'),
    base_thickness: rail('railBaseThickness'), rail_gauge: rail('railGauge'),
    rail_width: rail('railInterfaceWidth'), rail_height: rail('railHeight'),
    tongue_length: design('joint_depth') - clearance, tongue_width: design('joint_width'),
    tongue_height: design('joint_height'), socket_clearance: clearance, socket_depth: design('joint_depth') };
}

/** No project identity, route revision or physical train/run observation enters this key. */
export function calibrationKey(project: WorkshopProject): string {
  const c = calibrationConditions(project);
  return JSON.stringify(['connector-fit', CALIBRATION_PROCESS_VERSION, project.trackSystem,
    project.trackSystem === 'brick-v1' ? BRICK_TRACK.version : 1,
    c.printer, c.material, c.nozzleMm, c.printProfile, c.orientation,
    project.trackSystem === 'custom-joiner-v1' ? Object.entries(customParameters(project, 0)).sort(([a], [b]) => a.localeCompare(b)) : null]);
}

export function effectiveFitAdjustment(project: WorkshopProject): number {
  return project.connectorFit.settingsKey === calibrationKey(project) ? project.connectorFit.adjustmentMm : 0;
}

export function calibrationParameters(project: WorkshopProject, adjustmentMm = effectiveFitAdjustment(project)): Record<string, number> {
  if (!Number.isFinite(adjustmentMm) || adjustmentMm < FIT_ADJUSTMENT_MIN || adjustmentMm > FIT_ADJUSTMENT_MAX) {
    throw new Error('Fit adjustment must be between -0.15 and +0.15 mm.');
  }
  const parameters = project.trackSystem === 'brick-v1'
    ? { body_length: BRICK_TRACK.sampleLength, connector_version: BRICK_TRACK.version, fit_adjustment: adjustmentMm }
    : customParameters(project, adjustmentMm);
  if (project.trackSystem === 'custom-joiner-v1' && Object.values(parameters).some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Choose positive custom connector dimensions and clearance before preparing this trial.');
  }
  return parameters;
}

export function setFitAdjustment(project: WorkshopProject, mm: number): WorkshopProject {
  if (!Number.isFinite(mm) || mm < FIT_ADJUSTMENT_MIN || mm > FIT_ADJUSTMENT_MAX) {
    throw new Error('Fit adjustment must be between -0.15 and +0.15 mm.');
  }
  return changeProject(project, draft => {
    draft.connectorFit = { adjustmentMm: mm, settingsKey: calibrationKey(project), calibrationId: null };
  });
}

export function applyCalibration(project: WorkshopProject, profile: CalibrationProfile): WorkshopProject {
  if (profile.result !== 'fits' || profile.trackSystem !== project.trackSystem || profile.settingsKey !== calibrationKey(project)) {
    throw new Error('Calibration does not match this connector and print setup.');
  }
  const next = setFitAdjustment(project, profile.adjustmentMm);
  next.connectorFit.calibrationId = profile.id;
  return next;
}

/** Saved results for this exact setup, newest first. Only the newest report per adjustment is applicable, so a later failure supersedes an earlier pass. */
export function savedCalibrations(project: WorkshopProject, profiles: readonly CalibrationProfile[]): Array<{ profile: CalibrationProfile; applicable: boolean }> {
  const key = calibrationKey(project);
  const seen = new Set<number>();
  return profiles.filter(profile => profile.settingsKey === key && profile.trackSystem === project.trackSystem)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id))
    .map(profile => {
      const newest = !seen.has(profile.adjustmentMm);
      seen.add(profile.adjustmentMm);
      return { profile, applicable: newest && profile.result === 'fits' };
    });
}

export async function loadCalibrations(): Promise<CalibrationProfile[]> {
  return await apiJson<CalibrationProfile[]>('calibrations', { fallback: 'Unable to access your calibrations.' });
}
export async function saveCalibration(project: WorkshopProject, receipt: ArtifactReceipt,
  result: CalibrationProfile['result'], notes: string): Promise<CalibrationProfile> {
  const conditions = calibrationConditions(project);
  const snapshot = { ...project, material: conditions.material, printSettings: {
    profile: conditions.printProfile, nozzleMm: conditions.nozzleMm, orientation: conditions.orientation
  } };
  return await apiJson<CalibrationProfile>('calibrations', { json: { project: snapshot, receiptId: receipt.id, result, notes },
    fallback: 'Unable to save the calibration.' });
}
