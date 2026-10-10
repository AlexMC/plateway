import type { ChainTurn } from './chain-turn';
import { Icon, type IconName } from './icons';
import './canvas-tools.css';

/** A top-toolbar button: icon and short label (the label hides on a narrow canvas, a `minor` one first; the name and tooltip stay). */
export function ToolButton({ icon, label, name = label, title = name, pressed, disabled, minor = false, onClick }: {
  icon: IconName; label: string; name?: string; title?: string; pressed?: boolean; disabled?: boolean; minor?: boolean; onClick: () => void;
}) {
  return <button type="button" className={`builder-tool${minor ? ' is-minor' : ''}`} aria-label={name} title={title} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
    <Icon name={icon}/><span className="builder-tool-label">{label}</span>
  </button>;
}

/** Always-visible zoom in the canvas corner (the toolbar keeps its own); scroll still zooms. `?` opens Keyboard shortcuts. */
export function ZoomCluster({ onZoomIn, onZoomOut, onFit, fitLabel, onHelp }: {
  onZoomIn: () => void; onZoomOut: () => void; onFit: () => void; fitLabel: string; onHelp: () => void;
}) {
  return <div className="builder-zoom-cluster" role="group" aria-label="Zoom controls">
    <button type="button" onClick={onZoomIn} aria-label="Zoom in" title="Zoom in">+</button>
    <button type="button" onClick={onZoomOut} aria-label="Zoom out" title="Zoom out">−</button>
    <button type="button" onClick={onFit} aria-label={fitLabel} title={fitLabel}>⤢</button>
    <button type="button" onClick={onHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" aria-keyshortcuts="?">?</button>
  </div>;
}

/**
 * Beside a chain end (top view, plan millimetres): how far round the chain has turned, whether the end is parallel to the
 * start, and a faint guide along the start direction. `size`: label size in millimetres at the current zoom.
 */
export function TurnIndicator({ chain, words, size }: { chain: ChainTurn; words: readonly string[]; size: number }) {
  const { start, end } = chain, reach = 6000;
  const cos = Math.cos(start.heading), sin = Math.sin(start.heading);
  // Text sits ahead of the end, centred on its heading (further out when the heading runs along the text), clear of the
  // track; lines stack downwards on screen (plan +y is up).
  const ahead = size * (2 + 5 * Math.abs(Math.cos(end.heading)) + Math.max(0, Math.sin(end.heading)) * (words.length - 1) * 1.25);
  // A level end's label also rises above the track, clear of the next piece laid along it.
  const x = end.x + Math.cos(end.heading) * ahead, y = end.y + Math.sin(end.heading) * ahead + Math.abs(Math.cos(end.heading)) * size * 2.2;
  const state = chain.closed ? 'is-closed' : chain.parallel ? 'is-parallel' : '';
  return <g className={`builder-turn ${state}`} aria-label={words.join(' · ')}>
    <line className="builder-turn-guide" x1={start.x - cos * reach} y1={start.y - sin * reach} x2={start.x + cos * reach} y2={start.y + sin * reach}/>
    {chain.parallel && <line className="builder-turn-guide is-end" x1={end.x - cos * reach} y1={end.y - sin * reach} x2={end.x + cos * reach} y2={end.y + sin * reach}/>}
    <circle className="builder-turn-start" cx={start.x} cy={start.y} r={size * 0.45}/>
    {words.map((line, index) => <text key={line} className={index ? 'builder-turn-note' : 'builder-turn-total'} x={x} y={y - index * size * 1.25}
      fontSize={index ? size * 0.85 : size} textAnchor="middle">{line}</text>)}
  </g>;
}
