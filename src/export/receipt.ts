import type { WorkshopProject } from '../domain/project';
import type { Pose3 } from '../domain/route';
import type { FitResult } from '../fitting/fit';
import type { InspectionMesh } from '../drive/scene';
import { apiUrl } from '../net/api';
import { couponTrial, gradeTrial, printSelection, type PrintSelection } from './actions';

export interface ArtifactReceipt {
  id: string;
  partRevision: string;
  layoutRevision: string;
  cadSourceCurrent?: boolean;
  printer: { name: string; material: string; profile: string; nozzleMm: number; orientation: string };
  parts: Array<{
    instanceId: string; family: string; parameters: Record<string, number>;
    assemblyInstanceId?: string; assemblyFamily?: string; componentRole?: string;
    assemblyParameters?: Record<string, number>;
    partRevision: string; layoutRevision: string; assemblyPose: Pose3 | null;
    digest: string; requestDigest: string; mesh: string; step?: string | null; source: string;
    request?: string; sourceDependencies?: string[];
    plate: number; plateLabel: string; printMesh?: string;
    /** `code`: the short label the guide, the plate lists and the slicer's object list use ("3B", "7", "S2");
     * `name`: e.g. "Climb +40 mm · part 3 of 14". Absent from packages prepared before codes existed. */
    code?: string; piece?: string; pieceName?: string; name?: string;
    /** A community piece (KTD9): its library item and credit; its `digest` is the uploaded mesh's, printed unchanged. */
    library?: { id: string; version: number; digest: string; name: string; licence: string; credit: string };
  }>;
  /** `filamentColour`: a plate printed in its own filament (colour marker inserts; 'Clear' LED track in `filament`);
   * `filaments`: the AMS slots of a multi-material plate in order (flexible track: the project PLA, then TPU).
   * `model`: the plain core 3MF any slicer opens (absent from packages prepared before it existed);
   * `project` and `gcode`: the Bambu Studio project with painted supports and its G-code for the chosen Bambu printer. */
  plates: Array<{ plate: number; model?: string; project: string; gcode: string; thumbnail?: string;
    objects: Array<{ instanceId: string; label: string }>; gcodeSha256: string;
    slice: { warning_message?: string }; supportsEnabled?: boolean; processOverride?: string | null; process?: string;
    filamentColour?: string; filament?: string; filaments?: string[] }>;
  /** The markdown guide; the printable PDF comes from /api/packages/<id>/assembly-guide.pdf for every package. */
  assemblyGuide: string;
  assemblies?: Array<{ instanceId: string; family: string; componentIds: string[];
    hardware: Array<{ name: string; quantity: number }>; instructions: string[] }>;
  manifest?: string;
  /** A layout prepared in parts: each part's plates (numbered on across parts) and pieces, combined into this one package. */
  layoutParts?: Array<{ index: number; plates: number[]; pieces: string[] }>;
  /** What to know about how the parts were made: community pieces print as uploaded, without print style or fit adjustment (R20). */
  notes?: string[];
  /** Files are kept for 7 days (R12); the receipt stays and its prepare can run again. */
  expired?: boolean;
  expiresAt?: string;
}

const FAMILY_NAMES: Record<string, string> = {
  printed_straight: 'Straight', printed_curve: 'Curve', vertical_transition: 'Ramp',
  bridge_deck: 'Bridge deck', bridge_joint: 'Bridge joint', connector_joiner: 'Joiner',
  reversible_column: 'Support column', anchored_bracket: 'Wall bracket', reversible_foot: 'Support foot', layout_riser: 'Riser block',
  brick_end_coupon: 'Calibration sample', connector_coupon: 'Calibration sample',
  printed_flex: 'Flex track', printed_switch_left: 'Left turnout', printed_switch_right: 'Right turnout',
  printed_crossing90: '90° crossing', printed_double_crossover: 'Double crossover', composite_track: 'Printed track',
  track_diamond: 'Diamond crossing', track_diamond_curve: 'Curve crossing', track_gauntlet: 'Gauntlet track'
};
const ROLE_NAMES: Array<[RegExp, string]> = [
  [/^keyed-base-/, 'base'], [/^selector-lock-/, 'lock pin'], [/^selector-/, 'selector'], [/^keeper-/, 'keeper'],
  [/^pivot-leaf$/, 'fixed leaf'], [/^articulating-leaf$/, 'moving leaf'], [/^crossing-base(-\d+)?$/, 'base']
];

export function familyName(family: string): string {
  return FAMILY_NAMES[family] ?? family.replaceAll('_', ' ');
}

/** e.g. "Left turnout · base 2 of 7"; numbered only when an assembly has several parts of that kind. Packages name
 * their parts themselves; older ones are named from their family and role. */
export function partName(part: ArtifactReceipt['parts'][number], parts: ArtifactReceipt['parts']): string {
  if (part.name) return part.name;
  if (!part.assemblyFamily || !part.componentRole) return familyName(part.family);
  const roleName = (role: string) => ROLE_NAMES.find(([pattern]) => pattern.test(role))?.[1] ?? role.replaceAll('-', ' ');
  const role = roleName(part.componentRole);
  const siblings = parts.filter(item => item.assemblyInstanceId === part.assemblyInstanceId && item.componentRole &&
    roleName(item.componentRole) === role).map(item => item.componentRole!).sort();
  const index = siblings.indexOf(part.componentRole) + 1;
  return `${familyName(part.assemblyFamily)} · ${role}${siblings.length > 1 ? ` ${index} of ${siblings.length}` : ''}`;
}

function sameParameters(a: Record<string, number>, b: Record<string, number>): boolean {
  return Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([key, value]) => b[key] === value);
}

function samePrint(receipt: ArtifactReceipt, printer: PrintSelection): boolean {
  return receipt.printer.name === printer.name && receipt.printer.material === printer.material &&
    receipt.printer.profile === printer.profile && receipt.printer.nozzleMm === printer.nozzleMm;
}

export function matchingCoupon(project: WorkshopProject, receipt: ArtifactReceipt): boolean {
  if (receipt.manifest || receipt.cadSourceCurrent !== true) return false;
  try {
    const trial = couponTrial(project), part = trial.parts[0];
    return samePrint(receipt, trial.printer) && receipt.parts.length === 1 && receipt.parts[0].instanceId === part.id &&
      receipt.parts[0].family === part.family && sameParameters(receipt.parts[0].parameters, part.parameters);
  } catch { return false; }
}

/** A rig receipt identifies a route's whole fitted rise, not an arbitrary single transition; returns that route's id. */
export function matchingGrade(project: WorkshopProject, fit: FitResult, receipt: ArtifactReceipt): string | null {
  if (receipt.layoutRevision !== project.layoutRevision || receipt.manifest || receipt.cadSourceCurrent !== true) return null;
  try { if (!samePrint(receipt, printSelection(project))) return null; } catch { return null; }
  for (const route of project.routes) {
    try {
      const expected = gradeTrial(project, fit, route.id).parts;
      if (expected.length === receipt.parts.length && expected.every((part, index) =>
        receipt.parts[index].instanceId === part.id && receipt.parts[index].family === part.family &&
        sameParameters(receipt.parts[index].parameters, part.parameters))) return route.id;
    } catch { /* Not a fitted route with a complete grade rig. */ }
  }
  return null;
}

export function artifactUrl(receipt: ArtifactReceipt, path: string): string {
  return apiUrl(`packages/${encodeURIComponent(receipt.id)}/files/${path.split('/').map(encodeURIComponent).join('/')}`);
}

/** The package's files are gone (R12): its receipt says so, or its expiry passed while the page was open. */
export function filesExpired(receipt: ArtifactReceipt, now = Date.now()): boolean {
  return !!receipt.expired || !!receipt.expiresAt && Date.parse(receipt.expiresAt) <= now;
}

/** Only the current layout package supplies CAD meshes; stale CAD is never drawn over a newer route. */
export function inspectionMeshes(receipt: ArtifactReceipt, fit: FitResult): InspectionMesh[] {
  if (!receipt.manifest || receipt.layoutRevision !== fit.layoutRevision || receipt.cadSourceCurrent === false) return [];
  return receipt.parts.flatMap(part => {
    const instance = fit.partInstances.find(item => item.id === (part.assemblyInstanceId ?? part.instanceId));
    return instance && part.assemblyPose ? [{ sectionId: instance.sectionId,
      interfaceKind: instance.interfaceKind, layoutRevision: part.layoutRevision,
      assemblyParameters: part.assemblyParameters, componentRole: part.componentRole,
      parameters: part.parameters, pose: part.assemblyPose,
      digest: part.digest, requestDigest: part.requestDigest, url: artifactUrl(receipt, part.mesh) }] : [];
  });
}
