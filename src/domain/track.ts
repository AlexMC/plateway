import profile from '../../cad/profiles/brick-v1.json';
import type { WorkshopProject } from './project';

/** Nominal stud-grid layout, not a replacement for the accepted mating surfaces.
 * LDraw 53401: end datums ±160 LDU; 53400: R800 LDU, 22.5° segment (0.4 mm/LDU).
 */
const STUD_PITCH = 8;
export const BRICK_LAYOUT = {
  studPitch: STUD_PITCH,
  straightLength: 16 * STUD_PITCH,
  curveRadius: 40 * STUD_PITCH,
  wideCurveRadius: 56 * STUD_PITCH,
  curveSweep: Math.PI / 8,
  printedStraightLength: 20 * STUD_PITCH
} as const;

/** Planning fallback only for the custom joiner; never treated as a measurement. */
export const CUSTOM_RAIL_DEFAULTS = {
  railGauge: 37.5, railBodyWidth: 60, railBaseThickness: 4,
  railHeight: 8, railInterfaceWidth: 4
} as const;
/** Catalogue geometry is a product definition, not a user's physical measurement. */
export const BRICK_TRACK = profile;
const RAIL_DIMENSIONS = {
  railGauge: profile.railGauge,
  railInterfaceWidth: profile.railInterfaceWidth,
  railBodyWidth: profile.bodyWidth,
  railBaseThickness: profile.baseThickness,
  railHeight: profile.railHeight
} as const;
type RailDimension = keyof typeof RAIL_DIMENSIONS;

export function railDimension(project: WorkshopProject, key: RailDimension): number | null {
  if (project.trackSystem === 'brick-v1') return RAIL_DIMENSIONS[key];
  const measurement = project.measurements[key];
  return measurement.value !== null && measurement.status !== 'estimate' ? measurement.value : null;
}
