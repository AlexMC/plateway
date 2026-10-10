import { ELEVATION } from '../domain/elevation';
import { counterpartFamily, pieceDefinition, piecePaths } from '../domain/pieces';
import { realCars, type WorkshopProject } from '../domain/project';
import { pointPiece, sectionPiece, type FitIssue } from '../domain/route';
import type { CrossingClearance } from '../fitting/crossing';
import { POWER_GAP, REVERSING_LOOP } from '../fitting/electrical';
import { sectionGrade } from '../fitting/elevation';
import { fitProject, type FitResult } from '../fitting/fit';
import { TRAIN_CLEARANCE } from '../fitting/own-supports';
import { ROOM_CODES } from '../fitting/room';
import { gapOptions, nearestGap, type OpenEnd } from './gap-closer';
import { explainGap, loopGaps } from './gap-explain';
import { canSetHelixRise, laidHelices, planHelix, setHelixRise } from './helix';
import { addLevelBeforeSlope, setPieceSource, tileFits, unoccupiedPiecePorts } from './operations';

export type CheckSeverity = 'error' | 'warning' | 'info';
export interface CheckPoint { x: number; y: number; z: number }
/** What a check is about: the pieces to outline, fit supports and world points to mark. */
export interface CheckTargets { pieceIds: string[]; supportIds?: string[]; points?: CheckPoint[] }
export interface Check {
  /** Stable while the problem lasts, so a selected check stays selected across edits elsewhere. */
  id: string;
  severity: CheckSeverity;
  title: string;
  detail?: string;
  targets: CheckTargets;
  /** One undoable change that clears the check; `note` says what it uses (owned stock, printed pieces) and any error it leads to. */
  fix?: { label: string; note?: string; apply: (project: WorkshopProject) => WorkshopProject };
  /** A step the editor takes for the user: offer the gap closer, open Setup at the cars, or at the room size. */
  action?: 'close-gap' | 'add-cars' | 'room-size';
  /** The two open ends the `close-gap` action joins (`gapOptions`: owned pieces where they fit, a made-to-measure piece). */
  gap?: [OpenEnd, OpenEnd];
  /** Any error the `close-gap` action's preselected way (`gapOptions`) leads to, said before it is taken. */
  actionNote?: string;
}
export interface CheckBounds { min: CheckPoint; max: CheckPoint }

/** The box around a check's targets in the world: its pieces' paths, its points, and its supports from their ground up. */
export function targetBounds(project: WorkshopProject, fit: FitResult, targets: CheckTargets): CheckBounds | null {
  const ids = new Set(targets.pieceIds), supports = new Set(targets.supportIds ?? []);
  const points = [...project.routes.flatMap(route => route.pieces.filter(piece => ids.has(piece.id)))
    .flatMap(piece => piecePaths(piece, project).flatMap(path => path.points)), ...targets.points ?? [],
    ...fit.supports.filter(support => supports.has(support.id)).flatMap(support => [support.pose, { ...support.pose, z: support.ground ?? 0 }])];
  if (!points.length) return null;
  const axis = (key: 'x' | 'y' | 'z', pick: (...values: number[]) => number) => pick(...points.map(point => point[key]));
  return { min: { x: axis('x', Math.min), y: axis('y', Math.min), z: axis('z', Math.min) },
    max: { x: axis('x', Math.max), y: axis('y', Math.max), z: axis('z', Math.max) } };
}

const SEVERITY_ORDER: Record<CheckSeverity, number> = { error: 0, warning: 1, info: 2 };
const GRADE_CODES = ['grade-steep', 'grade-too-steep', 'rack-cog-only'];
/** Advice shown as its own row besides every error; the rest of fit's warnings belong to Print (design, profile) or fold into rows below. */
const SHOWN_WARNINGS = ['vertical-curve', REVERSING_LOOP, POWER_GAP];
const percent = (grade: number) => (grade * 100).toFixed(1);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Build's Checks: one row per underlying problem, each pointing at the pieces, supports or points it is about. Each fix (and
 * the gap closer) is tried on a copy first: an error it would add is said in its note ("Then track runs into K1."), and a fix
 * that adds an error of the same kind as the one it clears is not offered.
 */
export function buildChecks(project: WorkshopProject, fit: FitResult): Check[] {
  const rows = checkRows(project, fit), errors = rows.filter(row => row.severity === 'error');
  return rows.map(row => {
    const next = { ...row };
    if (row.fix) {
      const { fix } = row, added = addedErrors(project, errors, `${row.id}|${fix.label}`, fix.apply);
      if (!added || added.some(error => category(error.id) === category(row.id))) delete next.fix;
      else if (added.length) next.fix = { ...fix, note: [fix.note, consequence(added)].filter(Boolean).join(' · ') };
    }
    const [option] = row.gap ? gapOptions(project, ...row.gap) : [];
    if (option) {
      const added = addedErrors(project, errors, `${row.id}|gap:${option.label}`, () => option.next);
      if (added?.length) next.actionNote = `${option.label}: ${consequence(added)}`;
    }
    return next;
  });
}

/** A row's kind of problem: fit's code family for issue rows (both junction codes are "junction"), else its id's first part. */
const category = (id: string) => id.startsWith('issue:') ? id.split(':')[2].split('-')[0] : id.split(':')[0];
/**
 * Error rows a change adds, per project (each check's change is tried once): new rows, or rows now outlining more pieces;
 * null when the change can't be made.
 */
const tried = new WeakMap<WorkshopProject, Map<string, Check[] | null>>();
function addedErrors(project: WorkshopProject, before: readonly Check[], key: string, change: (project: WorkshopProject) => WorkshopProject): Check[] | null {
  const cache = tried.get(project) ?? new Map<string, Check[] | null>();
  tried.set(project, cache);
  if (cache.has(key)) return cache.get(key)!;
  let next: WorkshopProject;
  try { next = change(project); } catch { cache.set(key, null); return null; }
  const added = checkRows(next, fitProject(next)).filter(row => {
    const old = before.find(item => item.id === row.id);
    return row.severity === 'error' && (!old || row.targets.pieceIds.some(id => !old.targets.pieceIds.includes(id)));
  });
  cache.set(key, added);
  return added;
}
/** "Then track leaves the room, 102 mm past the wall at x = 0 and track runs into K1." */
function consequence(errors: readonly Check[]): string {
  return `Then ${errors.map(error => {
    const lead = /^[A-Z][a-z]/.test(error.title) ? error.title.charAt(0).toLowerCase() + error.title.slice(1) : error.title;
    const past = error.id === 'room' ? error.detail?.match(/(\d+ mm) past ([xy] = -?\d+)/) : null;
    return past ? `${lead}, ${past[1]} past the wall at ${past[2]}` : lead;
  }).join(' and ')}.`;
}

/**
 * The rows: same-message issues merge into one row over all their pieces; a crossing's issues fold into its row; the
 * steepest ramp and the grade warning for it are one row.
 */
function checkRows(project: WorkshopProject, fit: FitResult): Check[] {
  const checks: Check[] = [];
  const pieceIds = new Set(project.routes.flatMap(route => route.pieces.map(piece => piece.id)));
  const routePieces = (routeId: string) => project.routes.find(route => route.id === routeId)?.pieces.map(piece => piece.id) ?? [];
  const crossingOf = (id: string | undefined) => fit.crossings.find(crossing => crossing.crossingId === id);
  /** The issue's pieces, supports and points; an issue naming only its route (or crossing) points at all of that track. */
  const targetsOf = (issue: FitIssue): CheckTargets => {
    const crossing = crossingOf(issue.crossingId), declared = project.crossings.find(item => item.id === issue.crossingId);
    let ids = [...issue.pieceIds ?? [], ...(issue.span ?? []).map(pointPiece), ...issue.shortfall?.pieceIds ?? [],
      ...(crossing ? [crossing.upperPieceId, crossing.lowerPieceId] : [])].filter((id): id is string => id !== undefined && pieceIds.has(id));
    if (!ids.length && issue.routeId) ids = routePieces(issue.routeId);
    if (!ids.length && declared) ids = [...routePieces(declared.upperRouteId), ...routePieces(declared.lowerRouteId)];
    const points = [...issue.points ?? [], ...(crossing ? [crossing.upperPoint, crossing.lowerPoint] : [])];
    return { pieceIds: [...new Set(ids)], ...(issue.supportIds ? { supportIds: issue.supportIds } : {}), ...(points.length ? { points } : {}) };
  };
  const merge = (targets: readonly CheckTargets[]): CheckTargets => {
    const supports = targets.flatMap(target => target.supportIds ?? []), points = targets.flatMap(target => target.points ?? []);
    return { pieceIds: [...new Set(targets.flatMap(target => target.pieceIds))],
      ...(supports.length ? { supportIds: [...new Set(supports)] } : {}), ...(points.length ? { points } : {}) };
  };

  for (const issue of fit.issues) {
    if (issue.code !== 'owned-piece-unavailable' || !issue.shortfall) continue;
    const { family, used, owned, pieceIds: extras } = issue.shortfall, extra = used - owned, label = pieceDefinition(family).label;
    const printable = tileFits(project, counterpartFamily(family, 'printed') ?? family) && extras.length > 0;
    checks.push({ id: `shortfall:${family}`, severity: 'warning', title: `${extra} more ${label}${extra === 1 ? '' : 's'} than you own`,
      detail: `Using ${used}, Setup lists ${owned}.`, targets: targetsOf(issue),
      ...(printable ? { fix: { label: `Switch ${extras.length === 1 ? 'extra' : 'extras'} to printed`, apply: next => setPieceSource(next, extras, 'printed') } } : {}) });
  }

  // Ramps: the steepest grade (as Build always showed it) and fit's grade advice, merged where they are the same ramp.
  const standard = fit.sections.filter(section => section.kind !== 'unresolved' && !section.rack && !section.cable && section.gauge !== 'monorail');
  const grades = new Map<string, number>();
  for (const section of standard) {
    const id = sectionPiece(section);
    grades.set(id, Math.max(grades.get(id) ?? 0, sectionGrade(section)));
  }
  for (const piece of project.routes.flatMap(route => route.pieces)) {
    const definition = pieceDefinition(piece.family);
    if (definition.legacy?.rise !== undefined) grades.set(piece.id, Math.max(grades.get(piece.id) ?? 0, Math.abs(piece.rise ?? 0) * 1.5 / definition.run(piece, project)));
  }
  const steepest = Math.max(0, ...grades.values());
  let steepestShown = false;
  const gradeGroups = groupBy(fit.issues.filter(issue => GRADE_CODES.includes(issue.code)), issue => `${issue.code}:${issue.message}`);
  for (const [key, group] of gradeGroups) {
    const [{ code, message, severity }] = group, shown = message.match(/^[\d.]+/)?.[0] ?? '';
    const isSteepest = code !== 'rack-cog-only' && shown === percent(steepest);
    steepestShown ||= isSteepest;
    const rest = message.slice(message.indexOf(': ') + 2);
    checks.push({ id: `grade:${key}`, severity, targets: merge(group.map(targetsOf)),
      title: isSteepest ? `Steepest ramp ${shown}%` : code === 'rack-cog-only' ? `${shown}% on rack` : `${shown}% grade`,
      detail: `${code === 'grade-too-steep' ? `Too steep: ${rest}` : capital(rest)}${group.length > 1 ? ` On ${plural(group.length, 'piece')}.` : ''}` });
  }
  if (steepest > 1e-6 && !steepestShown) {
    checks.push({ id: 'steepest', severity: steepest > ELEVATION.cautionGrade + 1e-6 ? 'warning' : 'info', title: `Steepest ramp ${percent(steepest)}%`,
      detail: 'Keep ramps at 5% or less; 4% for long trains.',
      targets: { pieceIds: [...grades].filter(([, grade]) => grade >= steepest - 1e-6).map(([id]) => id).filter(id => pieceIds.has(id)) } });
  }

  const helixRows = new Map<string | undefined, Check>();
  for (const issue of fit.issues.filter(item => item.code === 'helix-clearance')) {
    const fix = helixFix(project, issue);
    const check: Check = { id: `helix:${issue.routeId}`, severity: issue.severity, title: 'Too little room between helix turns',
      detail: issue.message, targets: targetsOf(issue), ...(fix ? { fix } : {}) };
    helixRows.set(issue.routeId, check);
    checks.push(check);
  }

  for (const crossing of fit.crossings) {
    const issues = fit.issues.filter(issue => issue.crossingId === crossing.crossingId), check = crossingCheck(project, crossing, issues);
    // Blocked by nothing but the helix turn above it (measured as the helix's clearance): the helix row's problem.
    const helix = crossing.status === 'blocked' && !issues.some(issue => issue.severity === 'error') ?
      helixRows.get(crossing.upperRouteId) ?? helixRows.get(crossing.lowerRouteId) : undefined;
    if (!helix) { checks.push(check); continue; }
    helix.targets = merge([helix.targets, check.targets]);
    helix.detail += ' The crossing under the helix is blocked by the same turn.';
  }

  // The room: track (and supports) past a wall as one row, and one row per shelf track runs into.
  const ofCode = (...codes: string[]) => fit.issues.filter(issue => codes.includes(issue.code));
  const room = ofCode('track-outside-room'), walls = ofCode('track-outside-room', 'piece-outside-room', 'assembly-envelope-outside-room');
  if (walls.length) checks.push({ id: 'room', severity: 'error', title: 'Track leaves the room',
    detail: room[0]?.message ?? 'Outside the room — move it or enlarge the room in Setup.', targets: merge(walls.map(targetsOf)), action: 'room-size' });
  const shelfRows: Check[] = ofCode('track-into-shelf').map(issue => {
    const name = issue.message.match(/runs into (.+)'s panels/)?.[1] ?? 'a shelf';
    return { id: `shelf:${name}`, severity: 'error', title: `Track runs into ${name}`, detail: issue.message, targets: targetsOf(issue) };
  });
  // An assembly's travel into a shelf joins the row of the shelf its track runs into, else a row of its own.
  const travel = ofCode('assembly-furniture-collision').filter(issue => !shelfRows.some(row => targetsOf(issue).pieceIds.every(id => row.targets.pieceIds.includes(id))));
  if (travel.length) shelfRows.push({ id: 'shelf', severity: 'error', title: 'Track runs into a shelf',
    detail: 'Track body or full mechanism travel intersects a shelf panel.', targets: merge(travel.map(targetsOf)) });
  checks.push(...shelfRows);

  const folded = [...ROOM_CODES, 'piece-outside-room', 'assembly-envelope-outside-room', 'assembly-furniture-collision'];
  const others = fit.issues.filter(issue => !crossingOf(issue.crossingId) && issue.code !== 'owned-piece-unavailable' && !GRADE_CODES.includes(issue.code) &&
    issue.code !== 'helix-clearance' && !folded.includes(issue.code) && (issue.severity === 'error' || SHOWN_WARNINGS.includes(issue.code)));
  // Footprint messages lead with the piece ids; the row outlines those pieces instead.
  const titleOf = (issue: FitIssue) => issue.pieceIds?.length && issue.message.startsWith(issue.pieceIds[0]) ?
    capital(issue.message.slice(issue.message.indexOf(': ') + 2)) : issue.message;
  for (const [key, group] of groupBy(others, issue => `${issue.severity}:${issue.code}:${titleOf(issue)}`)) {
    const targets = merge(group.map(targetsOf)), fix = levelFix(project, group);
    checks.push({ id: `issue:${key}`, severity: group[0].severity, title: titleOf(group[0]), targets,
      ...(group.length > 1 ? { detail: `On ${plural(targets.pieceIds.length, 'piece')}.` } : {}), ...(fix ? { fix } : {}) });
  }

  // A route that runs nearly round a loop without closing: why its ends miss, the whole pieces that close it, then the
  // made-to-measure closer when some plain path can join the ends.
  const loopEnds = new Set<string>();
  for (const [a, b] of loopGaps(project)) {
    const why = explainGap(project, a, b), closer = nearestGap(project, Infinity, [a, b]);
    [a, b].forEach(end => loopEnds.add(`${end.pieceId}:${end.portId}`));
    checks.push({ id: `loop:${b.pieceId}`, severity: 'warning', title: 'Loop doesn\'t close', detail: why.text, action: 'close-gap',
      targets: { pieceIds: why.pieceIds, points: [a, b].map(({ port }) => ({ x: port.x, y: port.y, z: port.z })) },
      ...(why.fix ? { fix: why.fix } : {}), ...(closer ? { gap: closer } : {}) });
  }
  const ends = unoccupiedPiecePorts(project).filter(({ part, port }) => !loopEnds.has(`${part.id}:${port.id}`));
  const pair = nearestGap(project, undefined, ends.map(({ part, port }) => ({ pieceId: part.id, portId: port.id, port })));
  if (ends.length) checks.push({ id: 'open-ends', severity: 'info', title: plural(ends.length, 'open end'),
    detail: 'Trains stop at open ends. Join them to make a loop.', action: 'close-gap', ...(pair ? { gap: pair } : {}),
    targets: { pieceIds: [...new Set(ends.map(({ part }) => part.id))], points: ends.map(({ port }) => ({ x: port.x, y: port.y, z: port.z })) } });

  return checks.map((check, index) => ({ check, index }))
    .sort((a, b) => SEVERITY_ORDER[a.check.severity] - SEVERITY_ORDER[b.check.severity] || a.index - b.index).map(({ check }) => check);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...groups.get(key(item)) ?? [], item]);
  return groups;
}

/**
 * Slopes too close to junctions: the level each needs, in one change — a climb's own lead (or run-out) grows, any other slope
 * gets a printed level straight between it and the junction (its side of the track moves along).
 */
function levelFix(project: WorkshopProject, issues: readonly FitIssue[]): Check['fix'] {
  const levels = issues.map(issue => issue.level);
  if (!levels.length || levels.some(level => !level || !level.set && level.port !== 'in' && level.port !== 'out')) return undefined;
  const [first] = levels as NonNullable<FitIssue['level']>[];
  const slope = project.routes.flatMap(route => route.pieces).find(piece => piece.id === first.slopeId);
  const spec = first.set && slope && pieceDefinition(slope.family).params.find(item => item.key === first.set!.key);
  return { label: spec ? `${spec.label}: ${first.set!.value} mm` : `Add ${first.missing} mm of level straight`,
    apply: next => levels.reduce((project, level) => addLevelBeforeSlope(project, level!), next) };
}

/** One crossing: blocked, clear (measured against the tallest car) or not checked, saying what is missing. */
function crossingCheck(project: WorkshopProject, crossing: CrossingClearance, issues: readonly FitIssue[]): Check {
  const targets: CheckTargets = { pieceIds: [...new Set([crossing.upperPieceId, crossing.lowerPieceId].filter((id): id is string => id !== undefined))],
    points: [crossing.upperPoint, crossing.lowerPoint] };
  const id = `crossing:${crossing.crossingId}`, mm = (value: number) => `${Math.max(0, value).toFixed(0)} mm`;
  const measured = crossing.clearance !== undefined && crossing.needed !== undefined;
  const said = (codes: readonly string[]) => issues.filter(issue => codes.includes(issue.code)).map(issue => issue.message).join(' ');
  if (crossing.status === 'blocked') {
    const low = measured && crossing.clearance! < crossing.needed!;
    const why = said(['crossing-no-intersection', 'crossing-clearance', 'swept-envelope-collision']);
    return { id, severity: 'error', targets, title: low ? `Crossing too low: ${mm(crossing.clearance!)} clear, needs ${crossing.needed} mm` : 'Crossing blocked',
      ...(why ? { detail: why } : {}) };
  }
  if (crossing.status === 'digitally-clear') {
    const advice = said(['crossing-standard-clearance']);
    return { id, severity: advice ? 'warning' : 'info', targets, ...(advice ? { detail: advice } : {}),
      title: measured ? `Crossing clear: ${mm(crossing.clearance!)}, needs ${crossing.needed} mm` : 'Crossing clear' };
  }
  if (!realCars(project).length) return { id, severity: 'warning', targets, action: 'add-cars', title: 'Crossing not checked: no cars',
    detail: `Add your cars in Setup: the clearance under the upper track is checked against your tallest car${crossing.clearance === undefined ? '' : ` (${mm(crossing.clearance)} measured)`}.` };
  return { id, severity: 'warning', targets, title: 'Crossing not checked: no bridge deck',
    detail: said(['deck-clearance-unknown', 'crossing-standard-clearance']) || 'The clearance under the upper track couldn’t be measured.' };
}

/**
 * Raise a kit helix's rise per turn to the least (in 0.5 mm steps, at most the 5% grade) that clears the check: room for
 * every catalogue train if the grade allows, else for the tallest car. Fit's measured gap grows at least as fast as the kit's
 * planned clearance, so the planned gain is a safe estimate.
 */
function helixFix(project: WorkshopProject, issue: FitIssue): Check['fix'] {
  const helices = laidHelices(project).filter(helix => helix.routeId === issue.routeId);
  if (!helices.length || !issue.clearance || !issue.routeId) return undefined;
  const routeId = issue.routeId, { measured, needed } = issue.clearance;
  const tightest = helices.reduce((low, helix) => helix.options.rise < low.options.rise ? helix : low);
  const planned = planHelix(tightest.options).clearance;
  const steepest = Math.min(...helices.map(helix => ELEVATION.maxGrade * 2 * Math.PI * helix.options.radius));
  for (const target of [...new Set([Math.max(needed, TRAIN_CLEARANCE), needed])]) {
    for (let rise = Math.ceil(tightest.options.rise * 2) / 2; rise <= steepest; rise += 0.5) {
      if (measured + planHelix({ ...tightest.options, rise }).clearance - planned < target) continue;
      if (!canSetHelixRise(project, routeId, rise)) break;
      return { label: `Raise helix to ${rise} mm per turn`, apply: next => setHelixRise(next, routeId, rise) ?? next };
    }
  }
  return undefined;
}
