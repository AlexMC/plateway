import { CLIMB_FAMILY } from '../src/domain/pieces';
import { PRINTER_ENVELOPES } from '../src/domain/printer';
import type { WorkshopProject } from '../src/domain/project';
import { placePiece } from '../src/editor/operations';
import { createStandardProject } from '../src/editor/setup-defaults';
import { fitProject } from '../src/fitting/fit';

/** One bed-sized part of a fitted climb: its `composite_track` parameters and where its ends are (z mm, pitch rad). */
export interface ClimbFixturePart { id: string; parameters: Record<string, number>; start: { z: number; pitch: number }; end: { z: number; pitch: number } }
export interface ClimbFixtureCase { rise: number; printer: WorkshopProject['printer']; start: number; parts: ClimbFixturePart[] }

/** Climbs the CAD test builds and slices: up a cubby floor, up and down risers level. */
export const CLIMB_RISES = [38, 64, -64] as const;

/** Each climb at 4 % fitted for each printer: the printed parts fit cuts it into (detailed style; the CAD test adds fast). */
export function climbFixture(): ClimbFixtureCase[] {
  return CLIMB_RISES.flatMap(rise => (Object.keys(PRINTER_ENVELOPES) as WorkshopProject['printer'][]).map(printer => {
    const start = rise < 0 ? -rise : 0;
    const project = placePiece({ ...createStandardProject('Climb fixture'), printer }, CLIMB_FAMILY, { x: 200, y: 600, z: start, params: { rise, grade: 4 } })[0];
    const parts = fitProject(project).partInstances.flatMap(part => part.interfaceKind === 'rail' ? [{ id: part.id.split(':').at(-1)!, parameters: part.parameters,
      start: { z: part.startPort.pose.z, pitch: part.startPort.pose.pitch }, end: { z: part.endPort.pose.z, pitch: part.endPort.pose.pitch } }] : []);
    return { rise, printer, start, parts };
  }));
}
