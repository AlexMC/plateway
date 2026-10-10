import { automationDevices, type AutomationDevice } from '../domain/automation';
import { furnitureType } from '../domain/furniture';
import { findPieceDefinition } from '../domain/pieces';
import { CLIMB_FAMILY, CLIMB_RISE } from '../domain/pieces/families/climb';
import { CARS_NEEDED_MESSAGE, carsNeededForClearance, missingPrintMeasurements, realCars, type RoutePiece, type WorkshopProject } from '../domain/project';
import { printSelection } from './actions';
import { pieceLabel } from './hardware';
import type { PartInstance } from '../domain/route';
import type { FitResult } from '../fitting/fit';
import { roomSize } from '../fitting/room';

type FrozenInstance = PartInstance & { quantity: 1 };
export interface FrozenManifest {
  version: 1;
  units: 'mm';
  project: { id: string; revision: string; layoutRevision: string; name: string };
  printer: { name: WorkshopProject['printer']; material: string; profile: string; nozzleMm: number;
    orientation: string; envelope: { x: number; y: number; z: number } };
  mounting: WorkshopProject['mounting'];
  routes: WorkshopProject['routes'];
  crossings: WorkshopProject['crossings'];
  cars: WorkshopProject['cars'];
  instances: FrozenInstance[];
  requiredPrintedInstanceIds: string[];
  billOfMaterials: { family: string; source: 'owned' | 'printed'; count: number; instanceIds: string[] }[];
  mountingSiteChecks: string[];
  warnings: string[];
  /** Controllable devices for automation (servo points, powered mechanisms, servo uncouplers, colour markers). */
  devices: AutomationDevice[];
  /** The room for the assembly guide's overview drawing: its size and each furniture outline, room frame (mm). */
  room: { width: number; depth: number;
    furniture: { label: string; height: number; outline: { x: number; y: number }[] }[] };
  /** Each layout piece's name for the assembly guide, plates and slicer ("Climb +40 mm", "Curve R40"), by piece id. */
  pieceNames: Record<string, string>;
  /**
   * The community pieces the layout uses (KTD9), once each: the library item's id (the instances' family), version and
   * the sha256 of the mesh the app loaded. The service prints that mesh as uploaded (R20) after checking the digest.
   * Absent when the layout has none.
   */
  library?: { id: string; version: number; digest: string }[];
}

/** A layout piece as the guide names it: a climb by its height change, a curve by its radius, else its kind. */
export function printedPieceName(piece: RoutePiece): string {
  if (piece.family === CLIMB_FAMILY) {
    const rise = piece.params?.rise ?? CLIMB_RISE;
    return `Climb ${rise < 0 ? '−' : '+'}${Math.abs(rise)} mm`;
  }
  // A community piece is named as its library item is, whatever its id ends in.
  const radius = findPieceDefinition(piece.family)?.community ? undefined : /_r(\d+)$/.exec(piece.family)?.[1];
  return radius ? `${pieceLabel(piece)} R${radius}` : pieceLabel(piece);
}

/** Floor-plan outline of each furniture item, turned and placed as the room plan draws it. */
function roomOutline(project: WorkshopProject): FrozenManifest['room'] {
  const { width, depth } = roomSize(project);
  return { width, depth, furniture: project.furniture.map(item => {
    const type = furnitureType(item.family), angle = item.quarterTurns * Math.PI / 2, c = Math.cos(angle), s = Math.sin(angle);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => ({ x: u * type.width / 2, y: v * type.depth / 2 }));
    return { label: type.label, height: type.height,
      outline: corners.map(point => ({ x: item.x + c * point.x - s * point.y, y: item.y + s * point.x + c * point.y })) };
  }) };
}

export function freezeManifest(project: WorkshopProject, fit: FitResult): FrozenManifest {
  if (fit.layoutRevision !== project.layoutRevision) throw new Error('The layout changed; try again.');
  if (missingPrintMeasurements(project).length) throw new Error('Measure your rail profile in Setup first.');
  if (carsNeededForClearance(project)) throw new Error(CARS_NEEDED_MESSAGE);
  const printer = printSelection(project);
  const errors = [...new Set(fit.issues.filter(issue => issue.severity === 'error').map(issue => issue.message))];
  if (!fit.geometryFeasible) throw new Error(`Fix the track first: ${errors.join(' ')}`);
  if (!fit.partInstances.length) throw new Error('Add track pieces first.');
  const unbuilt = new Set(fit.partInstances.filter(instance => instance.source === 'printed' && !instance.geometryAvailable)
    .map(part => part.family.replaceAll('_', ' ')));
  if (unbuilt.size) throw new Error(`These printed parts are missing dimensions: ${[...unbuilt].join(', ')}.`);
  const ids = new Set<string>();
  for (const part of fit.partInstances) {
    if (ids.has(part.id)) throw new Error(`Duplicate part identity: ${part.id}`);
    ids.add(part.id);
  }
  const instanceList = fit.partInstances.map(instance => ({ ...structuredClone(instance), quantity: 1 as const }));
  const library = new Map(fit.partInstances.flatMap(part => {
    const origin = findPieceDefinition(part.family)?.community;
    return origin ? [[origin.id, { id: origin.id, version: origin.version, digest: origin.digest }] as const] : [];
  }));
  const groups = new Map<string, FrozenManifest['billOfMaterials'][number]>();
  for (const instance of instanceList) {
    const key = `${instance.source}:${instance.family}`;
    const group = groups.get(key) ?? { family: instance.family, source: instance.source, count: 0, instanceIds: [] };
    group.count++;
    group.instanceIds.push(instance.id);
    groups.set(key, group);
  }
  return {
    version: 1, units: 'mm',
    project: { id: project.id, revision: project.revision, layoutRevision: project.layoutRevision, name: project.name },
    printer,
    mounting: project.mounting,
    routes: structuredClone(project.routes), crossings: structuredClone(project.crossings), cars: structuredClone(realCars(project)),
    instances: instanceList,
    requiredPrintedInstanceIds: instanceList.filter(instance => instance.source === 'printed').map(instance => instance.id),
    billOfMaterials: [...groups.values()], mountingSiteChecks: [...fit.mounting.siteChecks],
    warnings: [...new Set(fit.issues.filter(issue => issue.severity === 'warning').map(issue => issue.message))],
    devices: automationDevices(project, fit),
    room: roomOutline(project),
    pieceNames: Object.fromEntries(project.routes.flatMap(route => route.pieces.map(piece => [piece.id, printedPieceName(piece)]))),
    ...(library.size ? { library: [...library.values()] } : {})
  };
}
