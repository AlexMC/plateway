import { ELEVATION } from '../domain/elevation';
import { pieceDefinition, piecePaths, piecePorts, pieceRun, portsMate, type ShapePort } from '../domain/pieces';
import { MONORAIL_MAX_GRADE } from '../domain/pieces/families/monorail';
import { RACK } from '../domain/pieces/rack-teeth';
import type { RoutePiece, WorkshopProject } from '../domain/project';
import type { FitIssue, Section } from '../domain/route';
import { sectionMaximumGrade } from '../drive/results';

const percent = (grade: number) => `${(grade * 100).toFixed(1)}%`;
const metres = (mm: number) => `${(mm / 1000).toFixed(1)} m`;
/** The legacy 6 % ramp keeps its own catalogue checks (grade-unfitted) and fitted output unchanged. */
const LEGACY_RAMP = 'vertical_transition';

/** Steepest grade along a fitted section (rise per run). */
export function sectionGrade(section: Section): number {
  if (section.kind === 'transition') return sectionMaximumGrade(section);
  const points = section.pathPoints ?? [section.start.pose, section.end.pose];
  return Math.max(...points.map(point => Math.abs(Math.tan(point.pitch))));
}
/** Tightest vertical curve along a fitted section's path points, mm (Infinity on constant grade). */
export function sectionVerticalRadius(section: Section): number {
  const points = section.pathPoints ?? [];
  let radius = Infinity;
  for (let i = 1; i < points.length; i++) {
    const run = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    const change = Math.abs(Math.tan(points[i].pitch) - Math.tan(points[i - 1].pitch));
    if (change > 1e-9) radius = Math.min(radius, run / change);
  }
  return radius;
}

/** A piece that climbs or falls anywhere along it. */
function sloped(piece: RoutePiece, project: WorkshopProject): boolean {
  return piecePaths(piece, project).some(path => path.points.some(point =>
    Math.abs(point.pitch ?? 0) > 1e-9 || Math.abs(point.z - path.points[0].z) > 1e-6));
}

/**
 * Elevation rules over the fitted layout: grade (≤ 5 %, advice above 4 %), vertical curves (≥ 5.1 m advised),
 * abrupt grade breaks at joints, and no turnout or crossing on or right next to a slope. Experimental track has its own
 * limits: rack up to 20 % (cog trains above 5 %) with vertical curves of at least 1.28 m, brick monorail ramps up to
 * 37.5 %, and a funicular (cable) any grade.
 */
export function checkElevation(project: WorkshopProject, sections: readonly Section[]): FitIssue[] {
  const issues: FitIssue[] = [], reported = new Set<string>();
  const report = (key: string, issue: FitIssue) => {
    if (reported.has(key)) return;
    reported.add(key);issues.push(issue);
  };
  for (const section of sections) {
    if (section.kind === 'unresolved' || section.family === LEGACY_RAMP) continue;
    const span: [string, string] = [section.fromPointId, section.toPointId];
    const grade = sectionGrade(section), radius = sectionVerticalRadius(section);
    if (section.cable) continue;
    if (section.gauge === 'monorail') {
      if (grade > MONORAIL_MAX_GRADE + 1e-3) report(`grade:${span[0]}`, { code: 'grade-too-steep', severity: 'error', routeId: section.routeId, span,
        message: `${percent(grade)} is too steep for a monorail: classic brick monorail ramps climb at most ${percent(MONORAIL_MAX_GRADE)}.` });
      continue;
    }
    if (section.rack) {
      if (grade > RACK.maxGrade + 1e-6) report(`grade:${span[0]}`, { code: 'grade-too-steep', severity: 'error', routeId: section.routeId, span,
        message: `${percent(grade)} is too steep: rack track climbs at most ${percent(RACK.maxGrade)}.` });
      else if (grade > ELEVATION.maxGrade + 1e-6) report(`grade:${span[0]}`, { code: 'rack-cog-only', severity: 'warning', routeId: section.routeId, span,
        message: `${percent(grade)} on rack: only trains with a cog car climb it (Setup → cars → Cog drive).` });
      if (radius < RACK.minVerticalRadius - 1e-6) report(`curve:${span[0]}`, { code: 'vertical-curve-tight', severity: 'error', routeId: section.routeId, span,
        message: `The grade changes too fast for the cog (vertical curve ${metres(radius)}); ease it over at least ${metres(RACK.minVerticalRadius)}.` });
      continue;
    }
    if (grade > ELEVATION.maxGrade + 1e-6) report(`grade:${span[0]}`, { code: 'grade-too-steep', severity: 'error', routeId: section.routeId, span,
      message: `${percent(grade)} is too steep: brick trains climb at most 5% (two plates per 16-stud track). Make the ramp longer.` });
    else if (grade > ELEVATION.cautionGrade + 1e-6) report(`grade:${span[0]}`, { code: 'grade-steep', severity: 'warning', routeId: section.routeId, span,
      message: `${percent(grade)} grade: long or heavy trains may stall; 4% or less is safer.` });
    if (radius < ELEVATION.minVerticalRadius - 1e-6) report(`curve:${span[0]}`, { code: 'vertical-curve-tight', severity: 'error', routeId: section.routeId, span,
      message: `The grade changes too fast here (vertical curve ${metres(radius)}); ease it over at least ${metres(ELEVATION.minVerticalRadius)}.` });
    else if (radius < ELEVATION.verticalRadius - 1e-6) report(`curve:${span[0]}`, { code: 'vertical-curve', severity: 'warning', routeId: section.routeId, span,
      message: `Vertical curve ${metres(radius)}: long cars can uncouple or scrape. Ease grade changes over 5.1 m (one plate per 16-stud track).` });
  }
  for (const route of project.routes) {
    const chain = sections.filter(section => section.routeId === route.id && (!section.pathId || section.pathId === 'main'));
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1].end.pose, b = chain[i].start.pose;
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= 0.01 && Math.abs(Math.tan(a.pitch) - Math.tan(b.pitch)) > 1e-3)
        issues.push({ code: 'grade-break', severity: 'error', routeId: route.id, span: [chain[i - 1].toPointId, chain[i].fromPointId],
          message: `The grade jumps from ${percent(Math.tan(a.pitch))} to ${percent(Math.tan(b.pitch))} here; join level track and slopes with a ramp Start or End.` });
    }
  }
  issues.push(...checkJunctionLevels(project));
  return issues;
}

/** Level a slope still needs after `level` mm from a junction: the rest of ELEVATION.levelGap in whole 8 mm, at least a 24 mm part. */
const missingLevel = (level: number) => Math.max(24, Math.ceil((ELEVATION.levelGap - level) / 8 - 1e-9) * 8);

/** Every piece's ports, and the piece and port mated with a given one. */
function joints(project: WorkshopProject) {
  const pieces = project.routes.flatMap(route => route.pieces.map(piece => ({ piece, route })));
  const ports = pieces.map(({ piece }) => piecePorts(piece, project));
  const mate = (index: number, port: ShapePort) => {
    for (let other = 0; other < pieces.length; other++) {
      if (other === index) continue;
      const found = ports[other].find(candidate => portsMate(port, candidate, 0.5, 0.01));
      if (found) return { index: other, port: found };
    }
    return null;
  };
  return { pieces, ports, mate };
}

/** The level run (mm) from end `portId` of a sloped piece to where its path first climbs or falls, and whether it then climbs. */
function levelInto(piece: RoutePiece, project: WorkshopProject, portId: string): { level: number; up: boolean } {
  const path = piecePaths(piece, project).find(item => item.from === portId || item.to === portId);
  if (!path) return { level: 0, up: true };
  const points = path.from === portId ? path.points : [...path.points].reverse(), start = points[0];
  let level = 0;
  for (let i = 1; i < points.length && Math.abs(start.pitch ?? 0) <= 1e-9; i++) {
    if (Math.abs(points[i].z - start.z) > 1e-6 || Math.abs(points[i].pitch ?? 0) > 1e-9) break;
    level += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return { level, up: points.at(-1)!.z >= start.z };
}

/**
 * Level track a slope laid on the open end `end` (a piece's port, facing out of it) still needs before it starts: what is
 * missing of ELEVATION.levelGap between it and a turnout or crossing behind (whole 8 mm, at least a 24 mm part), else 0.
 */
export function levelLeadAt(project: WorkshopProject, end: Pick<ShapePort, 'x' | 'y' | 'z' | 'heading'>): number {
  const { pieces, ports, mate } = joints(project);
  const atEnd = (candidate: ShapePort) => Math.hypot(candidate.x - end.x, candidate.y - end.y, candidate.z - end.z) < 0.5 &&
    Math.abs(Math.atan2(Math.sin(candidate.heading - end.heading), Math.cos(candidate.heading - end.heading))) < 0.01;
  const owner = ports.findIndex(own => own.some(atEnd));
  let level = 0;
  const seen = new Set<number>();
  for (let step: { index: number; port: ShapePort } | null = owner < 0 ? null : { index: owner, port: ports[owner].find(atEnd)! };
    step && !seen.has(step.index); ) {
    const { index, port } = step, piece = pieces[index].piece;
    seen.add(index);
    if (pieceDefinition(piece.family).group === 'junction') return missingLevel(level);
    if (sloped(piece, project)) return 0;
    level += pieceRun(piece, project);
    if (level >= ELEVATION.levelGap - 1e-6) return 0;
    const exits = ports[index].filter(candidate => candidate.id !== port.id);
    step = exits.length === 1 ? mate(index, exits[0]) : null;
  }
  return 0;
}

/**
 * Turnouts and crossings sit on level track with at least one 16-stud track of level before any slope (a climb's own
 * level lead-in counts). Each issue names the junction and the slope and carries what a fix needs (`level`).
 */
function checkJunctionLevels(project: WorkshopProject): FitIssue[] {
  const { pieces, ports, mate } = joints(project);
  const issues: FitIssue[] = [];
  pieces.forEach(({ piece, route }, index) => {
    const own = pieceDefinition(piece.family), label = own.label.toLowerCase(), needs = own.states ? 'points need' : 'crossings need';
    if (own.group !== 'junction') return;
    for (const port of ports[index]) {
      let level = 0, at = mate(index, port);
      const seen = new Set([index]);
      while (at && !seen.has(at.index) && level < ELEVATION.levelGap) {
        seen.add(at.index);
        const next = pieces[at.index].piece, definition = pieceDefinition(next.family);
        if (sloped(next, project)) {
          const into = levelInto(next, project, at.port.id), flat = level + into.level, slope = into.up ? 'climb' : 'descent';
          // A piece with its own level stretch at this end (a climb's lead) takes all the level the junction still needs there.
          const key = definition.levelEnds?.[at.port.id];
          if (flat < ELEVATION.levelGap - 0.5) issues.push({ code: flat < 0.5 ? 'junction-on-slope' : 'junction-near-slope', severity: 'error',
            routeId: route.id, pieceIds: [piece.id, next.id],
            level: { junctionId: piece.id, slopeId: next.id, port: at.port.id, missing: missingLevel(flat), ...(key ? { set: { key, value: missingLevel(level) } } : {}) },
            message: flat < 0.5 ? `The ${slope} starts right at the ${label}; ${needs} ${ELEVATION.levelGap} mm of level track before a slope.` :
              `Only ${Math.round(flat)} mm of level track between the ${label} and the ${slope}; ${needs} ${ELEVATION.levelGap} mm before a slope.` });
          break;
        }
        if (definition.group === 'junction') break;
        level += pieceRun(next, project);
        const exits = ports[at.index].filter(candidate => candidate.id !== at!.port.id);
        at = exits.length === 1 ? mate(at.index, exits[0]) : null;
      }
    }
  });
  return issues;
}
