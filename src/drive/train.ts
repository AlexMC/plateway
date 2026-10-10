import { frontReach, rearReach } from '../domain/car-geometry';
import type { Car } from '../domain/project';
import type { Pose3 } from '../domain/route';
import { offsetAlong, samplePath, type RoutePath } from './traversal';

export interface PlacedCar {
  car: Car;
  distance: number;
  pose: Pose3;
  frontWheel: Pose3;
  rearWheel: Pose3;
}
export interface TrainFrame {
  routeId: string;
  leadDistance: number;
  cars: PlacedCar[];
  stopped: boolean;
  warning: string | null;
}

/** Coupling face to coupling face over the whole consist, plus the gaps between cars, measured along the track. */
export function consistLength(cars: readonly Car[]): number {
  let length = 0;
  for (let index = 0; index < cars.length; index++) {
    length += frontReach(cars[index]) + rearReach(cars[index]);
    if (index) length += cars[index - 1].couplerGap;
  }
  return length;
}

/** Start with the entire consist on the selected route; no ghost wagon outside an open end. */
export function startingLeadDistance(cars: readonly Car[]): number {
  return consistLength(cars) - (cars[0] ? frontReach(cars[0]) : 0);
}

/** The lead car's origin when its front coupling face is at the far end of a path `length` long. */
export function finalLeadDistance(cars: readonly Car[], length: number): number {
  return length - (cars[0] ? frontReach(cars[0]) : 0);
}

/** A car body rests on its outer bogie pivots, `wheelbase` apart along the track, around its origin at `distance`. */
function carPose(path: RoutePath, car: Car, distance: number): { pose: Pose3; frontWheel: Pose3; rearWheel: Pose3 } | null {
  const frontWheel = samplePath(path, offsetAlong(path, distance, car.wheelbase/2));
  const rearWheel = samplePath(path, offsetAlong(path, distance, -car.wheelbase/2));
  if (!frontWheel || !rearWheel) return null;
  const center = samplePath(path, distance)!;
  // On banked track the car rolls with the rails.
  const roll = ((frontWheel.roll ?? 0) + (rearWheel.roll ?? 0))/2;
  return { frontWheel, rearWheel, pose: {
    x: (frontWheel.x + rearWheel.x)/2, y: (frontWheel.y + rearWheel.y)/2,
    z: (frontWheel.z + rearWheel.z)/2,
    heading: Math.atan2(frontWheel.y-rearWheel.y, frontWheel.x-rearWheel.x),
    pitch: Math.atan2(frontWheel.z-rearWheel.z,
      Math.hypot(frontWheel.x-rearWheel.x, frontWheel.y-rearWheel.y)) || center.pitch,
    ...(roll ? { roll } : {})
  } };
}

/** A point `along` mm ahead of a car's origin on its body axis. */
function bodyPoint(pose: Pose3, along: number): [number, number, number] {
  const level = Math.cos(pose.pitch) * along;
  return [pose.x + Math.cos(pose.heading) * level, pose.y + Math.sin(pose.heading) * level, pose.z + Math.sin(pose.pitch) * along];
}

/**
 * Where the next car's origin goes so its front coupling face sits `gap` behind `rear`, the car ahead's rear face,
 * along its own body axis: on a curve the faces meet across the chord, not around the arc. Newton steps from the
 * along-track spacing; moving the car 1 mm along the track moves its face about 1 mm along its axis.
 */
function coupledDistance(path: RoutePath, car: Car, guess: number, rear: [number, number, number], gap: number): number | null {
  let distance = guess;
  for (let step = 0; step < 8; step++) {
    const placed = carPose(path, car, distance);
    if (!placed) return null;
    const face = bodyPoint(placed.pose, frontReach(car)), axis = bodyPoint({ ...placed.pose, x: 0, y: 0, z: 0 }, 1);
    const error = (rear[0]-face[0])*axis[0] + (rear[1]-face[1])*axis[1] + (rear[2]-face[2])*axis[2] - gap;
    if (Math.abs(error) < 1e-3) break;
    distance = offsetAlong(path, distance, error);
  }
  return distance;
}

export function placeConsist(path: RoutePath, cars: readonly Car[], leadDistance: number): TrainFrame {
  const rejected = (warning: string): TrainFrame => ({ routeId: path.routeId, leadDistance, cars: [], stopped: true, warning });
  if (path.gap) return rejected(path.gap);
  if (!cars.length) return rejected('Add your train in Setup.');
  if (cars.some(car => !Number.isFinite(car.length) || !Number.isFinite(car.wheelbase) ||
    car.length <= 0 || car.wheelbase <= 0 || car.wheelbase > car.length || car.couplerGap < 0)) {
    return rejected('Check your car sizes in Setup: each wheelbase must fit inside its car.');
  }
  if (path.length < consistLength(cars)) return rejected('The track is shorter than your train.');
  if (leadDistance > finalLeadDistance(cars, path.length) || leadDistance - startingLeadDistance(cars) < -1e-8) {
    return rejected('The train is at the end of the track.');
  }
  const placed: PlacedCar[] = [];
  let distance = leadDistance;
  for (let index = 0; index < cars.length; index++) {
    const car = cars[index];
    if (index) {
      const ahead = cars[index-1], previous = placed[index-1];
      // Car lengths, coupler gaps and wheelbases are measured along the track, so a consist keeps its spacing on a slope.
      const guess = offsetAlong(path, distance, -(rearReach(ahead) + ahead.couplerGap + frontReach(car)));
      // Measured cars couple face to face across the chord of a curve.
      const coupled = ahead.couplers || car.couplers ?
        coupledDistance(path, car, guess, bodyPoint(previous.pose, -rearReach(ahead)), ahead.couplerGap) : guess;
      if (coupled === null) return rejected('The train is at the end of the track.');
      distance = coupled;
    }
    const pose = carPose(path, car, distance);
    if (!pose) return rejected('The train is at the end of the track.');
    placed.push({ car, distance, ...pose });
  }
  return { routeId: path.routeId, leadDistance, cars: placed, stopped: false, warning: null };
}

export function advanceConsist(path: RoutePath, cars: readonly Car[], leadDistance: number,
  speedMmPerSecond: number, seconds: number): TrainFrame {
  if (!Number.isFinite(speedMmPerSecond) || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error('Drive speed and elapsed time must be finite, with nonnegative elapsed time');
  }
  const desired = leadDistance + speedMmPerSecond*seconds;
  const minimum = startingLeadDistance(cars);
  const maximum = finalLeadDistance(cars, path.length);
  const clamped = Math.max(minimum, Math.min(maximum, desired));
  const frame = placeConsist(path, cars, clamped);
  if (desired !== clamped && frame.cars.length) {
    // A moving piece not lined up ends the route; say why the train stopped there.
    return { ...frame, stopped: true, warning: (desired > clamped ? path.endHalt : path.startHalt) ?? 'End of the track.' };
  }
  return frame;
}
