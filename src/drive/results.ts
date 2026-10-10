import { realCars, type WorkshopProject } from '../domain/project';
import type { FitResult } from '../fitting/fit';
import type { DriveInspection } from './collision';
import type { TrainFrame } from './train';
import type { RoutePath } from './traversal';

export interface DriveResult {
  title: string;
  detail: string;
  status: 'clear' | 'unknown' | 'blocked';
  /** Where the user fixes it, if anywhere. */
  action?: 'track' | 'setup';
}

/** Cubic Hermite slope is quadratic; its interior vertex may exceed both port slopes. */
export function sectionMaximumGrade(section: RoutePath['sections'][number]): number {
  const start = section.parameters.start_grade ?? 0, end = section.parameters.end_grade ?? 0;
  if (!section.run) return Math.max(Math.abs(start), Math.abs(end));
  const average = (section.parameters.rise ?? 0) / section.run;
  const quadratic = 3 * (start + end) - 6 * average;
  const linear = end - start - quadratic;
  const vertex = quadratic === 0 ? -1 : -linear / (2 * quadratic);
  return Math.max(Math.abs(start), Math.abs(end),
    vertex > 0 && vertex < 1 ? Math.abs((quadratic * vertex + linear) * vertex + start) : 0);
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Only the checks that apply to this route; a clean run is all green. `problem`: why this train can't run the route (drive/compat). */
export function driveResults(project: WorkshopProject, fit: FitResult, path: RoutePath,
  frame: TrainFrame, inspection: DriveInspection, problem: string | null = null): DriveResult[] {
  const results: DriveResult[] = [];
  const routeError = path.gap ?? fit.issues.find(issue => issue.routeId === path.routeId && issue.severity === 'error')?.message;
  if (routeError) results.push({ title: 'Track needs a fix', detail: routeError, status: 'blocked', action: 'track' });
  else if (!project.cars.length) results.push({ title: 'Add your train', detail: 'Add your locomotive and wagons to drive this route.', status: 'unknown', action: 'setup' });
  else if (frame.warning && !frame.cars.length) results.push({ title: 'Train can’t start', detail: frame.warning, status: 'blocked', action: 'track' });
  else if (problem) results.push({ title: 'Train can’t run here', detail: problem, status: 'blocked', action: 'setup' });
  else results.push({ title: 'Train runs the route', detail: `${(path.length / 1000).toFixed(1)} m of track · ${plural(project.cars.length, 'car')}.`, status: 'clear' });
  const halts = [...new Set([path.startHalt, path.endHalt].filter((halt): halt is string => halt !== undefined))];
  if (!routeError && halts.length) results.push({ title: 'Route ends at a moving piece', detail: `${halts.join(' ')} Change its setting below to drive on.`, status: 'unknown' });

  const crossing = fit.crossings.filter(item => item.lowerRouteId === path.routeId || item.upperRouteId === path.routeId);
  const declared = project.crossings.filter(item => item.lowerRouteId === path.routeId || item.upperRouteId === path.routeId);
  const unfitted = fit.issues.some(issue => issue.code === 'crossing-unfitted' && declared.some(item => item.id === issue.crossingId));
  const blocked = crossing.filter(item => item.status === 'blocked').length;
  if (unfitted) results.push({ title: 'Bridge needs a fix', detail: 'One of the routes at this crossing isn’t complete.', status: 'blocked', action: 'track' });
  else if (blocked) results.push({ title: 'Train hits the bridge', detail: `${plural(blocked, 'crossing')} too low for your tallest car. Raise the bridge.`, status: 'blocked', action: 'track' });
  else if (declared.length && !realCars(project).length) results.push({ title: 'Bridge height not checked', detail: 'Add your cars in Setup to check it.', status: 'unknown', action: 'setup' });
  else if (crossing.some(item => item.status === 'unknown')) results.push({ title: 'Bridge height not checked', detail: 'The clearance under this bridge couldn’t be worked out.', status: 'unknown' });
  else if (crossing.length) results.push({ title: 'Clears the bridge', detail: `Your tallest car fits under ${plural(crossing.length, 'crossing')}.`, status: 'clear' });

  const gradeIssues = fit.issues.filter(issue => issue.routeId === path.routeId && issue.code.includes('grade'));
  const failedGrade = gradeIssues.find(issue => issue.severity === 'error');
  const climb = path.sections.filter(section => section.kind === 'transition');
  if (failedGrade) results.push({ title: 'Ramp needs a change', detail: failedGrade.message, status: 'blocked', action: 'track' });
  else if (gradeIssues.length) results.push({ title: 'Steep ramp', detail: gradeIssues[0].message, status: 'unknown', action: 'track' });
  else if (climb.length) results.push({ title: 'Ramp fits', detail: `Steepest point ${(Math.max(...climb.map(sectionMaximumGrade)) * 100).toFixed(1)}%.`, status: 'clear' });

  if (inspection.collisions.length) results.push({ title: 'Something touches', detail: inspection.collisions.join(' '), status: 'blocked', action: 'track' });
  return results;
}
