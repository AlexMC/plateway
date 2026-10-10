import { createProject, type Car, type WorkshopProject } from '../src/domain/project';
import { primaryEnd } from '../src/domain/pieces';
import { placePiece, type TileFamily } from '../src/editor/operations';

export const WAGON: Car = { id: 'wagon', name: 'Loaded wagon', length: 200, width: 62, height: 74, wheelbase: 120, couplerGap: 8 };

/** A brick-track overpass: a 90 mm ramp, a bridge (or `deck`) tile over a lower straight, and a ramp back down.
 * `underX` is the lower track's distance from the start of the bridge tile (0–160 mm). */
export function overpass({ deck = 'bridge_deck', underX = 80, cars = [WAGON] }:
  { deck?: TileFamily; underX?: number; cars?: Car[] } = {}): WorkshopProject {
  let project = placePiece(createProject('Overpass'), 'vertical_transition', { x: 100, y: 1000, rise: 90 })[0];
  const extend = (family: TileFamily, rise?: number) => {
    const end = primaryEnd(project.routes[0].pieces.at(-1)!, project);
    project = placePiece(project, family, { x: end.x, y: end.y, heading: end.heading, rise })[0];
    return end;
  };
  const deckStart = extend(deck);
  extend('vertical_transition', -90);
  project = placePiece(project, 'printed_brick_straight', { x: deckStart.x + underX, y: 1000 - 64, heading: Math.PI / 2 }, 0)[0];
  project.crossings = [{ id: 'overpass', upperRouteId: project.routes[0].id, lowerRouteId: project.routes[1].id }];
  project.cars = structuredClone(cars);
  return project;
}
