import { ELEVATION } from '../domain/elevation';
import { CAR_GAUGES, GAUGE_LABEL, gaugeCarries, type CarGauge } from '../domain/gauges';
import { findPieceDefinition } from '../domain/pieces';
import type { Car } from '../domain/project';
import type { Section } from '../domain/route';
import { routePath } from './traversal';

/** Why this train can't run these route sections, or null. Test drive blocks Play and Run all while any rule objects. */
export type CompatRule = (train: { cars: readonly Car[] }, sections: readonly Section[]) => string | null;

const TRAIN_GAUGE: Record<CarGauge, string> = { standard: 'standard gauge', narrow: 'narrow gauge', monorail: 'monorail' };

/** The track the consist needs: its first car's gauge (standard when absent). */
export function trainGauge(cars: readonly Car[]): CarGauge {
  return cars[0]?.gauge ?? 'standard';
}

export const COMPAT_RULES: CompatRule[] = [
  // Gauges: every car of a consist rides one gauge.
  ({ cars }) => {
    const gauges = [...new Set(cars.map(car => car.gauge ?? 'standard'))];
    return gauges.length > 1 ? `This train mixes ${gauges.map(gauge => TRAIN_GAUGE[gauge]).join(' and ')} cars; a train runs on one gauge.` : null;
  },
  // Gauges: the route's track must carry the train's gauge (dual track carries standard and narrow).
  ({ cars }, sections) => {
    const gauge = trainGauge(cars), track = sections.map(section => section.gauge ?? 'standard').find(item => !gaugeCarries(item, gauge));
    if (!cars.length || track === undefined) return null;
    const label = GAUGE_LABEL[track], pick = CAR_GAUGES.find(item => item.id === track)?.label;
    return `${label[0].toUpperCase()}${label.slice(1)} track: this train is ${TRAIN_GAUGE[gauge]}.${pick ? ` Pick ${pick} as its cars’ Track in Setup.` : ''}`;
  },
  // RackMono: above the adhesion limit a rack climbs only with a cog car (a funicular's cable hauls any car).
  ({ cars }, sections) => {
    if (!cars.length || cars.some(car => car.cog)) return null;
    const steepest = Math.max(0, ...sections.filter(section => section.rack && !section.cable)
      .flatMap(section => (section.pathPoints ?? [section.start.pose, section.end.pose]).map(pose => Math.abs(Math.tan(pose.pitch)))));
    return steepest > ELEVATION.maxGrade + 1e-6 ?
      `The rack climbs ${(steepest * 100).toFixed(1)}%: only a train with a cog car gets up it. Tick Cog drive on its loco in Setup.` : null;
  },
  // RackMono: the cog hangs below the rail tops, so a cog train can't cross the rails inside a turnout or crossing.
  ({ cars }, sections) => {
    if (!cars.some(car => car.cog)) return null;
    const junction = sections.map(section => section.family && findPieceDefinition(section.family)).find(definition => definition && definition.group === 'junction');
    return junction ? `A cog car's cog hangs below the rail tops and would hit the rails inside the ${junction.label.toLowerCase()}: keep cog trains on plain track and rack.` : null;
  }
];

/** The first rule that objects to this train on these sections. */
export function trainProblem(cars: readonly Car[], sections: readonly Section[]): string | null {
  for (const rule of COMPAT_RULES) {
    const problem = rule({ cars }, sections);
    if (problem !== null) return problem;
  }
  return null;
}

/** Why this train can't run a route at all (Run all skips it): a rule on its path, or its own chain going onto track of another gauge. */
export function routeProblem(sections: readonly Section[], routeId: string, cars: readonly Car[]): string | null {
  const path = routePath(sections, routeId, trainGauge(cars));
  return trainProblem(cars, path.sections) ?? (path.gap !== null && routePath(sections, routeId).gap === null ? path.gap : null);
}
