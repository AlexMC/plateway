import type { FitResult } from '../fitting/fit';
import { MARKER_INSERT_FAMILY, paramValue, pieceDefinition, pieceState, type PieceDefinition } from './pieces';
import { markerColour } from './pieces/families/track-options';
import { servoCount } from './pieces/families/turnout-geometry';
import type { RoutePiece, WorkshopProject } from './project';

/**
 * A controllable device of the layout for automation (a hub program, brickrail): servo-driven points, powered
 * mechanisms, servo uncouplers, and colour-marker sleepers the colour & distance sensor reads. `id` is the piece id
 * (the assembly's instance id in the assembly guide) or the marker insert's part id. Hand-worked pieces are not listed.
 */
export interface AutomationDevice {
  id: string;
  kind: 'turnout' | 'mechanism' | 'uncoupler' | 'colour-marker';
  family: string;
  label: string;
  /** What drives or reads it: 'SG90 servo', '2 × SG90 servo', the mechanism's drive option, or the sensor. */
  control: string;
  states: { id: string; label: string }[];
  /** The authored state; null for markers. */
  state: string | null;
  routeId: string;
  /** Piece origin (or marker sleeper centre), mm. */
  x: number;
  y: number;
  /** Colour & distance sensor (88007) colour id of a marker; null otherwise. */
  colourId: number | null;
}

function states(definition: PieceDefinition, piece: RoutePiece): AutomationDevice['states'] {
  return (definition.pieceStates?.(piece) ?? definition.states ?? []).map(({ id, label }) => ({ id, label }));
}

/** The drive a mechanism's `drive` option names when it is a motor or servo; null when hand-worked (a crank too). */
function mechanismControl(definition: PieceDefinition, piece: RoutePiece): string | null {
  const drive = definition.params.find(spec => spec.key === 'drive');
  if (!drive) return null;
  const value = paramValue(definition, piece, 'drive');
  const label = drive.options?.find(option => option.value === value)?.label ?? '';
  return /motor|servo/i.test(label) ? label : null;
}

export function automationDevices(project: WorkshopProject, fit: FitResult): AutomationDevice[] {
  const devices: AutomationDevice[] = [];
  for (const route of project.routes) {
    for (const piece of route.pieces) {
      const definition = pieceDefinition(piece.family);
      const common = { id: piece.id, family: piece.family, label: definition.label, states: states(definition, piece),
        state: pieceState(piece) ?? null, routeId: route.id, x: piece.x, y: piece.y, colourId: null };
      const servos = servoCount(definition, piece);
      if (servos) {
        devices.push({ ...common, kind: 'turnout', control: servos > 1 ? `${servos} × SG90 servo` : 'SG90 servo' });
      } else if (definition.group === 'mechanism' || definition.group === 'experimental') {
        const control = mechanismControl(definition, piece);
        if (control) devices.push({ ...common, kind: piece.family === 'uncoupler_track' ? 'uncoupler' : 'mechanism', control });
      }
    }
  }
  for (const part of fit.partInstances) {
    if (part.family !== MARKER_INSERT_FAMILY || !part.pose) continue;
    const colour = part.parameters.marker;
    devices.push({ id: part.id, kind: 'colour-marker', family: part.family, label: `${markerColour(colour)} marker`,
      control: 'Colour & distance sensor (88007)', states: [], state: null, routeId: part.routeId,
      x: part.pose.x, y: part.pose.y, colourId: colour });
  }
  return devices;
}
