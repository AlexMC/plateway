import type { RoutePiece, TrackStyle, WorkshopProject } from './project';
import { pieceDefinition } from './pieces';

export const PRINTER_ENVELOPES = {
  'X1 Carbon': { x: 256, y: 256, z: 250 },
  'A1 mini': { x: 180, y: 180, z: 180 }
} as const;

/** Suggested starting settings, not a detected spool, installed nozzle or verified process. */
const PRINTER_PRESETS = {
  'X1 Carbon': { material: 'Bambu PLA Basic', profile: '0.20mm Standard @BBL X1C', nozzleMm: 0.4 },
  'A1 mini': { material: 'Bambu PLA Basic', profile: '0.20mm Standard @BBL A1M', nozzleMm: 0.4 }
} as const;

export function printerPreset(printer: keyof typeof PRINTER_ENVELOPES): (typeof PRINTER_PRESETS)[typeof printer] {
  return PRINTER_PRESETS[printer];
}

/** The project's chosen settings, falling back to the printer's suggested preset. Parts always print flat. */
export function effectivePrint(project: WorkshopProject): { name: WorkshopProject['printer']; material: string; profile: string; nozzleMm: number; orientation: 'flat' } {
  const preset = printerPreset(project.printer);
  return { name: project.printer, material: project.material ?? preset.material,
    profile: project.printSettings.profile ?? preset.profile,
    nozzleMm: project.printSettings.nozzleMm ?? preset.nozzleMm, orientation: 'flat' };
}

/** Fast-print track slices at the largest bundled layer height ≤ 0.28 mm for the printer and nozzle,
 * mirroring the local slicer's choice (GET /api/print-presets `fastProcess`). */
const FAST_PROCESSES: Record<WorkshopProject['printer'], Record<string, string>> = {
  'X1 Carbon': { '0.4': '0.28mm Extra Draft @BBL X1C' },
  'A1 mini': { '0.4': '0.28mm Extra Draft @BBL A1M', '0.6': '0.24mm Optimal @BBL A1M 0.6 nozzle',
    '0.8': '0.24mm Fine @BBL A1M 0.8 nozzle' }
};

/** The fast-print process for the chosen printer and nozzle; the chosen process when none is bundled. */
export function fastProcess(project: WorkshopProject): string {
  const print = effectivePrint(project);
  return FAST_PROCESSES[print.name][String(print.nozzleMm)] ?? print.profile;
}

/** Fast print applies to printed brick pieces; owned brick track and the legacy custom joiner never use it. */
export function pieceIsFast(project: WorkshopProject, piece: Pick<RoutePiece, 'family' | 'style'>): boolean {
  return piece.style === 'fast' && project.trackSystem === 'brick-v1' && pieceDefinition(piece.family).styles.includes('fast');
}

/** Printed track pieces by style. */
export function styleCounts(project: WorkshopProject): Record<TrackStyle, number> {
  const printed = project.routes.flatMap(route => route.pieces).filter(piece => pieceDefinition(piece.family).source === 'printed');
  const fast = printed.filter(piece => pieceIsFast(project, piece)).length;
  return { detailed: printed.length - fast, fast };
}

/** The connector sample prints like the track: fast when every printed piece is fast; in a mix, the
 * user's choice, else the style with more pieces. */
export function calibrationStyle(project: WorkshopProject): TrackStyle {
  const counts = styleCounts(project);
  if (!counts.fast) return 'detailed';
  if (!counts.detailed) return 'fast';
  return project.printSettings.calibrationStyle ?? (counts.fast > counts.detailed ? 'fast' : 'detailed');
}

export function calibrationProcess(project: WorkshopProject): string {
  return calibrationStyle(project) === 'fast' ? fastProcess(project) : effectivePrint(project).profile;
}

/** "0.28mm Extra Draft @BBL X1C" → "0.28 mm"; null for a process name without a leading layer height. */
export function layerHeight(process: string): string | null {
  const layer = /^(\d+(?:\.\d+)?)mm\b/.exec(process)?.[1];
  return layer ? `${layer} mm` : null;
}

// The local Bambu plate packer reserves this margin on every edge for skirts.
export const PLATE_EDGE_MARGIN_MM = 7;
