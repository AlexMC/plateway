import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { fitProject, type FitResult } from '../src/fitting/fit';
import { inspectDrive } from '../src/drive/collision';
import { DrivePanel } from '../src/drive/panel';
import { driveResults } from '../src/drive/results';
import { placeConsist, startingLeadDistance } from '../src/drive/train';
import { placePiece } from '../src/editor/operations';
import { routePath } from '../src/drive/traversal';

const loco = { id: 'loco', name: 'Locomotive', length: 100, width: 60, height: 70, wheelbase: 75, couplerGap: 0 };

function straightRoute(): WorkshopProject {
  let project = createProject('Drive results');
  for (let index = 0; index < 3; index++) [project] = placePiece(project, 'brick_straight_nominal', { x: index * 128, y: 0 });
  return { ...project, cars: [loco] };
}

function evaluate(project: WorkshopProject, adjust: (fit: FitResult, routeId: string) => void = () => {}) {
  const fit = fitProject(project);
  const path = routePath(fit.sections, project.routes[0].id);
  adjust(fit, path.routeId);
  const frame = placeConsist(path, project.cars, startingLeadDistance(project.cars));
  return driveResults(project, fit, path, frame, inspectDrive(project, fit, frame));
}

const crossing = (lowerRouteId: string, status: 'blocked' | 'unknown' | 'digitally-clear') => ({
  crossingId: 'bridge', upperRouteId: 'upper', lowerRouteId,
  upperPoint: { id: 'u', x: 200, y: 0, z: 150 }, lowerPoint: { id: 'l', x: 200, y: 0, z: 0 }, status
});

describe('drive results', () => {
  it('shows only applicable checks, all green for a clean flat route', () => {
    const results = evaluate(straightRoute());
    expect(results.map(result => result.status)).toEqual(['clear']);
  });

  it('greens a clear bridge crossing alongside the train', () => {
    const results = evaluate(straightRoute(), (fit, routeId) => { fit.crossings = [crossing(routeId, 'digitally-clear')]; });
    expect(results).toHaveLength(2);
    expect(results.every(result => result.status === 'clear')).toBe(true);
  });

  it('sends the user to Setup when an overpass exists but only the example train is present', () => {
    const project = straightRoute();
    project.cars = [{ ...loco, example: true }];
    project.crossings = [{ id: 'bridge', upperRouteId: 'upper', lowerRouteId: project.routes[0].id }];
    const results = evaluate(project, (fit, routeId) => {
      fit.crossings = [crossing(routeId, 'unknown')];
      fit.issues = fit.issues.filter(issue => issue.code !== 'crossing-unfitted');
    });
    expect(results.find(result => result.action === 'setup')).toMatchObject({ status: 'unknown' });
  });

  it('reports blocked geometry with a track fix', () => {
    const results = evaluate(straightRoute(), (fit, routeId) => {
      fit.crossings = [crossing(routeId, 'blocked')];
      fit.issues.push({ code: 'grade-unfitted', severity: 'error', routeId, message: 'Climb cannot fit.' });
    });
    const blocked = results.filter(result => result.status === 'blocked');
    expect(blocked.length).toBeGreaterThanOrEqual(3);
    expect(blocked.every(result => result.action === 'track')).toBe(true);
  });

  it('does not hide a crossing whose routes could not be fitted', () => {
    const project = straightRoute();
    project.crossings = [{ id: 'bridge', upperRouteId: 'upper', lowerRouteId: project.routes[0].id }];
    const results = evaluate(project, fit => {
      fit.issues.push({ code: 'crossing-unfitted', severity: 'error', crossingId: 'bridge', message: 'No two fitted routes.' });
    });
    expect(results.some(result => result.status === 'blocked' && result.action === 'track')).toBe(true);
  });

  it('reports the interior Hermite ramp maximum rather than zero endpoint slopes', () => {
    const [project] = placePiece(createProject('Eased ramp'), 'vertical_transition', { x: 100, y: 100, rise: 8 });
    const grade = evaluate(project).find(result => /ramp/i.test(result.title));
    expect(grade?.detail).toMatch(/6\.0%/);
  });

  it('offers a way to add the train or build track instead of a dead end', () => {
    const project = straightRoute();
    project.cars = [];
    const noTrain = renderToStaticMarkup(createElement(DrivePanel, { project, fit: fitProject(project), onOpenSetup: () => {} }));
    expect(noTrain).toMatch(/Add your train<\/button>/);
    expect(noTrain).toMatch(/aria-label="Drive train" disabled=""/);
    const empty = createProject('Empty');
    const noTrack = renderToStaticMarkup(createElement(DrivePanel, { project: empty, fit: fitProject(empty), onEditTrack: () => {} }));
    expect(noTrack).toMatch(/Build track first<\/button>/);
  });
});
