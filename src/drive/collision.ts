import { frontReach, rearReach } from '../domain/car-geometry';
import type { WorkshopProject } from '../domain/project';
import type { FitResult } from '../fitting/fit';
import type { TrainFrame } from './train';
import { railDimension } from '../domain/track';

export interface DriveInspection {
  collisions: string[];
}

/** A sampled column centre inside a car body is a definite conflict. Example cars are
 * not the user's train, so supports are checked only against real cars. */
export function inspectDrive(project: WorkshopProject, fit: FitResult, frame: TrainFrame): DriveInspection {
  const collisions = new Set<string>();
  for (const crossing of fit.crossings) {
    if (crossing.lowerRouteId !== frame.routeId && crossing.upperRouteId !== frame.routeId) continue;
    if (crossing.status === 'blocked') collisions.add('The bridge is too low or too close for your train.');
  }
  const railTop = (railDimension(project, 'railBaseThickness') ?? 0) + (railDimension(project, 'railHeight') ?? 0);
  for (const placed of frame.cars) {
    if (placed.car.example) continue;
    const front = frontReach(placed.car), rear = rearReach(placed.car);
    const dx = Math.cos(placed.pose.heading), dy = Math.sin(placed.pose.heading);
    const bodyBottom = placed.pose.z + railTop;
    const bodyTop = bodyBottom + placed.car.height;
    for (const support of fit.supports) {
      // Supports of the car's own route count only when they rise past the whole body: a route passing under itself.
      if (support.routeId === frame.routeId && support.pose.z < bodyTop) continue;
      const x = support.pose.x - placed.pose.x, y = support.pose.y - placed.pose.y;
      const along = x*dx + y*dy, across = -x*dy + y*dx;
      if (along <= front && along >= -rear && Math.abs(across) <= placed.car.width / 2 &&
        support.pose.z >= bodyBottom && bodyTop >= (support.ground ?? 0)) {
        collisions.add(`${placed.car.name} hits a bridge support.`);
      }
    }
  }
  return { collisions: [...collisions] };
}
