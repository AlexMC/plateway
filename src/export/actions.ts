import type { WorkshopProject } from '../domain/project';
import type { FitResult } from '../fitting/fit';
import { PRINTER_ENVELOPES, calibrationProcess, effectivePrint } from '../domain/printer';
import { calibrationParameters } from '../domain/calibration';

export interface TrialPart {
  id: string;
  family: 'connector_coupon' | 'brick_end_coupon' | 'vertical_transition' | 'connector_joiner';
  parameters: Record<string, number>;
  part_revision: string;
  layout_revision: string;
}
export interface PrintSelection {
  name: WorkshopProject['printer']; material: string; profile: string; nozzleMm: number;
  orientation: 'flat'; envelope: { x: number; y: number; z: number };
}
export interface TrialRequest {
  parts: TrialPart[];
  printer: PrintSelection;
}

export function printSelection(project: WorkshopProject): PrintSelection {
  const selection = effectivePrint(project);
  if (!selection.material.trim() || !selection.profile.trim()) throw new Error('Choose a material and printer process before preparing print files.');
  if (!Number.isFinite(selection.nozzleMm) || selection.nozzleMm <= 0) throw new Error('Choose a positive nozzle diameter.');
  return { ...selection, envelope: PRINTER_ENVELOPES[project.printer] };
}

/** The connector sample prints at the track's process, so fast-print fits are tried at their own layer height. */
export function couponTrial(project: WorkshopProject): TrialRequest {
  const brick = project.trackSystem === 'brick-v1';
  return { parts: [{
    id: brick ? 'brick-end-coupon' : 'connector-coupon',
    family: brick ? 'brick_end_coupon' : 'connector_coupon',
    parameters: calibrationParameters(project),
    part_revision: project.revision, layout_revision: project.layoutRevision
  }], printer: { ...printSelection(project), profile: calibrationProcess(project) } };
}

export function gradeTrial(project: WorkshopProject, fit: FitResult, routeId: string): TrialRequest {
  if (fit.layoutRevision !== project.layoutRevision) throw new Error('Route fit is stale; refit before preparing a grade trial.');
  const routeSections = fit.sections.filter(section => section.routeId === routeId);
  const sections = routeSections.filter(section => section.kind === 'transition');
  // The fitted ramp instances carry the print style, so the rig prints like the layout's ramp.
  const ramps = sections.map(section => fit.partInstances.find(instance => instance.sectionId === section.id && instance.interfaceKind === 'rail'));
  if (!sections.length || sections.some(section => section.family !== 'vertical_transition') || ramps.some(ramp => !ramp?.geometryAvailable)) {
    throw new Error('This route has no complete ramp to print as a grade rig.');
  }
  const joiners = project.trackSystem === 'brick-v1' ? [] : routeSections.flatMap((section, index) => {
    if (index === 0 || section.kind !== 'transition' || routeSections[index - 1].kind !== 'transition') return [];
    const joint = fit.partInstances.find(instance => instance.id === `${routeId}:joiner:${index}`);
    if (!joint || !joint.geometryAvailable) throw new Error('This ramp needs a joiner between its ramp pieces.');
    return [{ id: joint.id, family: 'connector_joiner' as const, parameters: { ...joint.parameters },
      part_revision: project.revision, layout_revision: project.layoutRevision }];
  });
  const printer = printSelection(project);
  return { parts: [...ramps.map((ramp, index) => ({
    id: `${routeId}:transition-${index + 1}`, family: 'vertical_transition' as const, parameters: { ...ramp!.parameters },
    part_revision: project.revision, layout_revision: project.layoutRevision
  })), ...joiners], printer };
}
