import { realCars, validateProject, type PhysicalObservation, type WorkshopProject } from './project';
import { effectivePrint } from './printer';

export type CheckKind = Exclude<PhysicalObservation['kind'], 'fit'>;

export function consistIdentity(project: WorkshopProject): string {
  return JSON.stringify(realCars(project).map(car => [
    car.id, car.length, car.width, car.height, car.wheelbase, car.couplerGap, car.loadDescription ?? ''
  ]));
}

/** Observations never change the layout, so current plates stay current. */
export function appendObservation(project: WorkshopProject, observation: PhysicalObservation): WorkshopProject {
  if (project.observations.some(existing => existing.id === observation.id)) throw new Error('Observation ID already recorded');
  const next = structuredClone(project);
  next.observations.push(structuredClone(observation));
  next.revision = crypto.randomUUID();
  validateProject(next);
  return next;
}

/** The latest firsthand report on this layout wins; a changed layout starts unchecked again. */
export function checkStatus(project: WorkshopProject, kind: CheckKind): 'pending' | 'worked' | 'failed' {
  const latest = project.observations.filter(item => item.kind === kind && item.layoutRevision === project.layoutRevision).at(-1);
  return !latest ? 'pending' : latest.passed ? 'worked' : 'failed';
}

export function recordCheck(project: WorkshopProject, kind: CheckKind, worked: boolean, notes: string, confirmed: boolean): WorkshopProject {
  if (!confirmed) throw new Error('Confirm that you printed and tested this yourself.');
  const print = effectivePrint(project);
  return appendObservation(project, {
    id: crypto.randomUUID(), kind, passed: worked, layoutRevision: project.layoutRevision,
    material: print.material, printer: print.name, printProfile: print.profile, nozzleMm: print.nozzleMm,
    orientation: print.orientation, consistId: consistIdentity(project), mounting: project.mounting,
    notes: notes.trim(), recordedAt: new Date().toISOString()
  });
}
