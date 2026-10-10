import type { Car } from './project';

/** How far a car reaches ahead of its origin (midway between its outer bogie pivots) to its front coupling face, mm. */
export function frontReach(car: Car): number {
  return car.couplers?.front ?? car.length / 2;
}

/** How far a car reaches behind its origin to its rear coupling face, mm. */
export function rearReach(car: Car): number {
  return car.couplers ? -car.couplers.rear : car.length / 2;
}

/**
 * How far past its half width a car's body swings on a curve of `radius` (track centreline, mm), on either side.
 * A measured car hangs between its bogie pivots: its middle cuts inside the curve by the pivot chord's sagitta and its
 * corners swing outside by their end overhang. A car without bogie and coupler positions is treated as one rigid
 * body spanning its whole length, as before.
 */
export function carCurveSweep(car: Car, radius: number): number {
  const pivot = car.wheelbase / 2;
  if (!car.bogies && !car.couplers || radius <= pivot) {
    const half = car.bogies || car.couplers ? Math.max(frontReach(car), rearReach(car)) : car.length / 2;
    return radius > half ? radius - Math.sqrt(radius ** 2 - half ** 2) : half;
  }
  const chord = Math.sqrt(radius ** 2 - pivot ** 2), half = car.width / 2;
  const end = Math.max(frontReach(car), rearReach(car));
  return Math.max(0, radius - chord, Math.hypot(chord + half, end) - radius - half);
}

/** The largest swing of any of `cars` on a curve of `radius`. */
export function trainCurveSweep(cars: readonly Car[], radius: number): number {
  return cars.reduce((sweep, car) => Math.max(sweep, carCurveSweep(car, radius)), 0);
}
