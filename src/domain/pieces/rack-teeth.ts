import type { CompositeTrack } from './types';

/**
 * Rack railway numbers shared by the editor, fit and the CAD (cad/models/rack.py): brick gear-rack pitch
 * (3743: 10 teeth per 32 mm), the steepest rack grade, the tightest vertical curve the cog bogie meshes on, and the
 * entry taper over which the teeth rise to full height.
 */
export const RACK = {
  pitch: 3.2,
  /** Steepest grade on rack (cog trains only above the 5 % adhesion limit). */
  maxGrade: 0.2,
  /** Tightest vertical curve, mm: on a 1280 mm crest the cog still keeps 0.1 mm tip clearance (rack.probe_vertical_curve). */
  minVerticalRadius: 1280,
  /** Vertical curve an automatic Entry/Exit eases over, mm. */
  autoVerticalRadius: 1600,
  /** Entry taper length, mm. */
  taper: 48
} as const;
/** `composite_track` rack option keys (C2 options; rack.OPTIONS). */
export const RACK_OPTION_KEYS: readonly string[] = ['rack', 'rack_pitch', 'rack_phase', 'rack_in', 'rack_out'];

/** 3D distance along a composite's Hermite height profile at each plan station (0.5 mm trapezoid steps). */
export function arc3d(track: Pick<CompositeTrack, 'segments' | 'z0' | 'z1' | 'grade0' | 'grade1'>, stations: readonly number[]): number[] {
  const length = track.segments.reduce((sum, segment) => sum + segment.len, 0);
  const rise = track.z1 - track.z0;
  const slope = (s: number) => {
    const t = s / length;
    return (3*t*t - 4*t + 1) * track.grade0 + (-6*t*t + 6*t) * rise / length + (3*t*t - 2*t) * track.grade1;
  };
  const count = Math.max(2, Math.ceil(length / 0.5));
  const grid: number[] = [0], cumulative: number[] = [0];
  for (let i = 1; i <= count; i++) {
    const a = length * (i - 1) / count, b = length * i / count;
    const speed = (s: number) => Math.hypot(1, slope(s));
    grid.push(b);
    cumulative.push(cumulative[i - 1] + (speed(a) + speed(b)) / 2 * (b - a));
  }
  return stations.map(station => {
    const s = Math.min(Math.max(station, 0), length), index = Math.min(count - 1, Math.floor(s / length * count));
    const u = (s - grid[index]) / (grid[index + 1] - grid[index]);
    return cumulative[index] + (cumulative[index + 1] - cumulative[index]) * u;
  });
}

/**
 * The rack options of a whole rack piece: whole teeth with the spacing nearest the brick pitch, the first and last half
 * a tooth from the ports (so spacing stays continuous across joints), and a taper at the start (`taperIn`) and/or end.
 */
export function rackOptions(track: CompositeTrack, taperIn: boolean, taperOut: boolean): Record<string, number> {
  const length = track.segments.reduce((sum, segment) => sum + segment.len, 0);
  const [run] = arc3d(track, [length]);
  const pitch = run / Math.max(1, Math.round(run / RACK.pitch));
  return { rack: 1, rack_pitch: pitch, rack_phase: pitch / 2, rack_in: taperIn ? RACK.taper : 0, rack_out: taperOut ? RACK.taper : 0 };
}

/** Rack options of each bed-sized slice between plan-station `cuts` (first 0, last the length): phase and tapers carried over. */
export function sliceRackOptions(options: Record<string, number>, track: CompositeTrack, cuts: readonly number[]): Record<string, number>[] {
  const distances = arc3d(track, cuts), run = distances.at(-1)!, pitch = options.rack_pitch;
  return cuts.slice(1).map((_, index) => {
    const start = distances[index], end = distances[index + 1];
    let phase = ((options.rack_phase - start) % pitch + pitch) % pitch;
    if (phase > pitch - 1e-9) phase = 0;
    return { rack: 1, rack_pitch: pitch, rack_phase: phase,
      rack_in: Math.max(0, (options.rack_in ?? 0) - start), rack_out: Math.max(0, (options.rack_out ?? 0) - (run - end)) };
  });
}
