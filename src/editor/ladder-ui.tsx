import { memo, useMemo } from 'react';
import type { RoutePiece, WorkshopProject } from '../domain/project';
import { pieceDefinition, piecePaths } from '../domain/pieces';
import { NumberField } from './elevation-ui';
import { LADDER_PARAMS, ladderTurnouts, layLadder, type LadderOptions } from './ladder';

/** Palette key of the siding-ladder kit (not a piece family). */
export const LADDER_KEY = 'kit:ladder';
export const LADDER_INITIAL: Record<string, number> = { ...Object.fromEntries(LADDER_PARAMS.map(spec => [spec.key, spec.default])), turnout: 0 };

/** The kit options for the palette values, or the reason the kit cannot be laid (no turnout, bad spacing). */
function ladderOptions(project: WorkshopProject, values: Record<string, number>, fast: boolean): { options: LadderOptions | null; problem: string } {
  const turnouts = ladderTurnouts(project), turnout = turnouts[values.turnout] ?? turnouts[0];
  if (!turnout) return { options: null, problem: 'No turnout for a ladder on this track system.' };
  const options: LadderOptions = { turnout, sidings: values.sidings, spacing: values.spacing, length: values.length,
    hand: values.hand < 0 ? -1 : 1, buffers: values.buffers > 0, ...(fast ? { style: 'fast' as const } : {}) };
  try { layLadder(project, { x: 0, y: 0, z: 0, heading: 0 }, options); } catch (error) { return { options: null, problem: (error as Error).message }; }
  return { options, problem: '' };
}

/** Centrelines of the kit's pieces, framed like a palette tile. */
export const LadderMiniature = memo(function LadderMiniature({ project, pieces }: { project: WorkshopProject; pieces: readonly RoutePiece[] }) {
  const lines = pieces.flatMap(piece => piecePaths(piece, project).map(path => path.points));
  // Half the 64 mm bed plus a small margin.
  const xs = lines.flat().map(point => point.x), ys = lines.flat().map(point => point.y), pad = 38;
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  return <svg className="builder-tile-preview" viewBox={`${x0} ${y0} ${Math.max(...xs) - x0 + pad} ${Math.max(...ys) - y0 + pad}`} aria-hidden="true">
    <g className="builder-piece is-printed">{lines.map((points, index) => <path key={index} className="builder-piece-bed" strokeWidth={64}
      d={points.map((point, n) => `${n ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')}/>)}</g>
  </svg>;
});

/** The kit for the palette values: its options (or why it cannot be laid) and its pieces at the origin. */
export function useLadderKit(project: WorkshopProject, values: Record<string, number>, fast: boolean) {
  const { options, problem } = useMemo(() => ladderOptions(project, values, fast), [project, values, fast]);
  const pieces = useMemo(() => options ? layLadder(project, { x: 0, y: 0, z: 0, heading: 0 }, options) : [], [project, options]);
  return { options, problem, pieces };
}

/** The kit's one-line summary for its palette tile. */
export const ladderSummary = (values: Record<string, number>, pieces: readonly RoutePiece[]) =>
  `${values.sidings} tracks · ${values.spacing / 8} studs apart · ${pieces.filter(piece => pieceDefinition(piece.family).group === 'junction').length} turnouts`;

/** The kit's settings (each change re-arms it). */
export function LadderSettings({ project, values, problem, onChange }: {
  project: WorkshopProject; values: Record<string, number>; problem: string; onChange: (values: Record<string, number>) => void;
}) {
  const turnouts = ladderTurnouts(project);
  return <div className="builder-kind-editor">
    {turnouts.length > 1 && <label className="builder-param" htmlFor="ladder-turnout">Turnout
      <select id="ladder-turnout" value={values.turnout} onChange={event => onChange({ ...values, turnout: Number(event.target.value) })}>
        {turnouts.map((family, index) => <option key={family} value={index}>{pieceDefinition(family).label}</option>)}</select></label>}
    {LADDER_PARAMS.map(spec => spec.options ?
      <label key={spec.key} className="builder-param" htmlFor={`ladder-${spec.key}`}>{spec.label}
        <select id={`ladder-${spec.key}`} value={values[spec.key]} onChange={event => onChange({ ...values, [spec.key]: Number(event.target.value) })}>
          {spec.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> :
      <NumberField key={spec.key} id={`ladder-${spec.key}`} label={spec.label} unit={spec.unit} value={values[spec.key]} min={spec.min} max={spec.max} step={spec.step}
        onSet={value => onChange({ ...values, [spec.key]: value })}/>)}
    {problem && <small className="builder-kind-problem" role="alert">{problem}</small>}
  </div>;
}
