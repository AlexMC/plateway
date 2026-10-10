import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { WorkshopProject } from '../domain/project';
import { DEFAULT_MIN_RADIUS, LOWEST_MIN_RADIUS } from '../domain/solver/gap';
import { gapOptions, openEnds, planGap, type GapOption, type GapPlan, type OpenEnd } from './gap-closer';
import './gap-closer.css';

const RADIUS_CHOICES = [320, 288, 256, 224, 192] as const;
const endKey = (end: OpenEnd) => `${end.pieceId}:${end.portId}`;

/** Close gap state: picking two open ends (or taking the Checks offer), the ways to join them, the chosen one and the tightest bend. */
export interface GapCloserState {
  picking: boolean;
  /** First end picked, waiting for the second. */
  first: OpenEnd | null;
  pair: [OpenEnd, OpenEnd] | null;
  /** The made-to-measure piece alone, for why the ends can't be joined when nothing can. */
  plan: GapPlan | null;
  /** Up to three ways to join the pair (`gapOptions`), the preselected one first. */
  options: GapOption[];
  /** The chosen option: shown as ghosts and laid by Place. */
  option: GapOption | null;
  choose(index: number): void;
  minRadius: number;
  setMinRadius(radius: number): void;
  /** Picking or showing a solved piece. */
  active: boolean;
  cancel(): void;
  /** Toolbar toggle: start picking two ends, or stop. */
  toggle(): void;
  /** Show the ways to join two known ends (the Checks offer). */
  show(ends: [OpenEnd, OpenEnd]): void;
  pick(end: OpenEnd): void;
}
export function useGapCloser(project: WorkshopProject): GapCloserState {
  const [picking, setPicking] = useState(false);
  const [first, setFirst] = useState<OpenEnd | null>(null);
  const [pair, setPair] = useState<[OpenEnd, OpenEnd] | null>(null);
  const [minRadius, setMinRadius] = useState(DEFAULT_MIN_RADIUS);
  const [choice, setChoice] = useState(0);
  const plan = useMemo(() => pair ? planGap(project, pair[0], pair[1], minRadius) : null, [project, pair, minRadius]);
  const options = useMemo(() => pair ? gapOptions(project, pair[0], pair[1], minRadius) : [], [project, pair, minRadius]);
  // New options start on the preselected one.
  useEffect(() => setChoice(0), [options]);
  const cancel = () => { setPicking(false); setFirst(null); setPair(null); };
  // Any edit (including placing the closer or undo) ends the session: the picked ends may be gone.
  useEffect(cancel, [project]);
  return {
    picking, first, pair, plan, options, option: options[choice] ?? options[0] ?? null, choose: setChoice, minRadius, setMinRadius, cancel,
    active: picking || pair !== null,
    toggle: () => { if (picking || pair) cancel(); else { setPicking(true); setFirst(null); setPair(null); } },
    show: ends => { setPicking(false); setFirst(null); setPair(ends); },
    pick: end => {
      if (!first || endKey(first) === endKey(end)) { setFirst(first ? null : end); setPair(null); return; }
      setPair([first, end]); setFirst(null); setPicking(false);
    }
  };
}

/** Top-view overlay: clickable open-end rings while picking, and the chosen way with its pieces. */
export function GapOverlay({ project, gap, children }: { project: WorkshopProject; gap: GapCloserState; children?: ReactNode }) {
  const ends = gap.picking ? openEnds(project) : [];
  const label = gap.pair && gap.option ? { x: (gap.pair[0].port.x + gap.pair[1].port.x) / 2, y: (gap.pair[0].port.y + gap.pair[1].port.y) / 2 } : null;
  return <g className="gap-overlay">
    {children}
    {gap.pair && gap.pair.map(end => <circle key={endKey(end)} cx={end.port.x} cy={end.port.y} r="22" className="gap-end is-picked"/>)}
    {ends.map(end => <g key={endKey(end)} className={`gap-end-pick ${gap.first && endKey(gap.first) === endKey(end) ? 'is-picked' : ''}`}
      role="button" aria-label="Open end" onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); gap.pick(end); }}>
      <circle cx={end.port.x} cy={end.port.y} r="26" className="gap-end-hit"/>
      <circle cx={end.port.x} cy={end.port.y} r="18" className="gap-end"/>
    </g>)}
    {label && <text x={label.x} y={label.y + 80} className="gap-label" textAnchor="middle">{gap.option!.label}</text>}
  </g>;
}

/** "2 owned · 1 printed (80 mm)". */
function counts(option: GapOption): string {
  return [option.owned ? `${option.owned} owned` : '', option.printed ? `${option.printed} printed (${Math.round(option.printedLength)} mm)` : ''].filter(Boolean).join(' · ');
}

/**
 * The Close gap card: what to do next, the ways to join the ends (or why not), the tightest bend allowed while it matters
 * (a made-to-measure piece bends, or nothing joins at this limit), and Place.
 */
export function GapPanel({ gap, onPlace }: { gap: GapCloserState; onPlace: (next: WorkshopProject, id: string) => void }) {
  if (!gap.active) return null;
  const solution = gap.plan?.solution;
  const bends = gap.options.some(option => option.bent) || !gap.options.length && solution?.ok === false && solution.minRadius !== undefined;
  return <section className="gap-panel" aria-label="Close gap">
    <strong>CLOSE GAP</strong>
    {!gap.plan && <p>{gap.first ? 'Click the other open end.' : 'Click two open ends to join.'}</p>}
    {gap.options.length > 0 && <div className="gap-options" role="radiogroup" aria-label="Ways to join the ends">
      {gap.options.map((option, index) => <label key={option.label} className={`gap-option${option === gap.option ? ' is-chosen' : ''}`}>
        <input type="radio" name="gap-option" checked={option === gap.option} onChange={() => gap.choose(index)}/>
        <span><b>{option.label}</b><small>{counts(option)}</small></span>
      </label>)}
    </div>}
    {gap.plan && !gap.options.length && <p className="gap-reason" role="alert">{solution && !solution.ok ? solution.reason : 'These ends can’t be joined exactly.'}</p>}
    {bends && <>
      <label>Tightest bend allowed
        <select value={gap.minRadius} onChange={event => gap.setMinRadius(Number(event.target.value))}>
          {RADIUS_CHOICES.map(radius => <option key={radius} value={radius}>R{radius}{radius === DEFAULT_MIN_RADIUS ? ' · default' : radius === LOWEST_MIN_RADIUS ? ' · tightest' : ''}</option>)}
        </select></label>
      <small className="gap-help">Only matters when the ends aren’t lined up: the made-to-measure piece won’t curve tighter than this.</small>
    </>}
    <div className="gap-actions">
      <button type="button" className="gap-place" disabled={!gap.option} onClick={() => {
        if (gap.option) onPlace(gap.option.next, gap.option.pieces.at(-1)!.id);
      }}>Place</button>
      <button type="button" onClick={gap.cancel}>Cancel</button>
    </div>
  </section>;
}
