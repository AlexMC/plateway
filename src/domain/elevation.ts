/**
 * Community rules for brick-train elevation (diesel-dave.com/lego/train_depot/inclines.htm, Eurobricks 77522,
 * TrixBrix incline supports): at most 2 plates of rise per 16-stud track (5 %), grade changing by at most one
 * plate per track (a vertical curve of about 5.1 m), no junction on a slope with level track before it,
 * and 118 mm from rail top to the underside of anything crossing above.
 */
export const ELEVATION = {
  /** Steepest grade the editor accepts. */
  maxGrade: 0.05,
  /** Above this, long or heavy trains may stall. */
  cautionGrade: 0.04,
  /** Recommended vertical-curve radius, mm: one plate of grade change per 128 mm track. */
  verticalRadius: 5120,
  /** Tightest vertical curve a ramp piece is built with (the CAD's `vcurve`), mm. */
  minVerticalRadius: 2560,
  /** Rail top to the underside of a crossing deck, mm. */
  clearance: 118,
  /** Level track between a junction and a slope, mm (one 16-stud track). */
  levelGap: 128,
  /** One brick plate, mm. */
  plate: 3.2
} as const;
/** Ramp grade presets, percent. */
export const RAMP_GRADES: readonly number[] = [2, 3, 4, 5];
/** Longest single ramp piece (composite_track limit); fit still splits each piece to the printer bed. */
export const RAMP_MAX_PIECE = 2000;

const studUp = (mm: number) => Math.ceil(mm / 8 - 1e-9) * 8;

/** Length of a level↔grade easement at `radius`, rounded up to whole studs. */
export function transitionLength(grade: number, radius: number = ELEVATION.verticalRadius): number {
  return Math.max(24, studUp(radius * Math.abs(grade)));
}

/** Ramp pieces in run order: `part` 0 eases level→grade, 1 is constant grade, 2 eases grade→level. `grade` is signed, percent. */
export interface RampPiecePlan { part: 0 | 1 | 2; grade: number; length: number }
export interface RampPlan { pieces: RampPiecePlan[]; run: number; rise: number; grade: number; transition: number }

/**
 * The shortest whole-stud ramp that changes height by `rise` (mm, signed) at no more than `grade` (fraction) with
 * vertical curves no tighter than `radius`: eased start, constant slope (split into pieces of at most RAMP_MAX_PIECE),
 * eased end. The run is rounded up to whole studs and the grade eased off to land exactly on the height.
 */
export function planRamp(rise: number, grade: number = ELEVATION.cautionGrade, radius: number = ELEVATION.verticalRadius): RampPlan | null {
  const height = Math.abs(rise), sign = Math.sign(rise);
  if (!(height >= 0.5) || !(grade > 0) || !(radius > 0)) return null;
  let transition = transitionLength(grade, radius), run = studUp(height / grade + transition), actual: number;
  if (run >= 2 * transition) actual = height / (run - transition);
  else {
    // Too low for a constant stretch: two easements meeting in the middle, each at least radius × grade long.
    transition = Math.max(24, studUp(Math.sqrt(radius * height)));
    run = 2 * transition;
    actual = height / transition;
  }
  const slope = run - 2 * transition, chunks = slope > 1e-9 ? Math.ceil(slope / RAMP_MAX_PIECE - 1e-9) : 0;
  const percent = sign * actual * 100;
  return { run, rise, grade: actual, transition, pieces: [
    { part: 0, grade: percent, length: transition },
    ...Array.from({ length: chunks }, () => ({ part: 1 as const, grade: percent, length: slope / chunks })),
    { part: 2, grade: percent, length: transition }
  ] };
}
