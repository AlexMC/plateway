import type { SyntheticEvent } from 'react';
import { Icon, type IconName } from './icons';
import { ariaKeyShortcuts, bindingLabel, keyLabel, placementTip, shortcut, type ShortcutId } from './shortcuts';
import './placement-bar.css';

/** What F does to the armed piece: a curve's (or S-bend's) hand, a ramp's direction, or a mirrored family or shape. */
export type GhostFlip = 'bend' | 'rise' | 'mirror';

/** What the bar is about: the armed piece or furniture being placed, or the selected piece or furniture. */
export type BarContext =
  | { mode: 'placing'; name: string; flip: GhostFlip | null; bend: 1 | -1; sbend: boolean;
    /** The armed ramp's direction (Ramp up/down), or null when it is not a ramp. */
    rise: 1 | -1 | null;
    /** Tab's pick among the ways the ghost attaches where it is, when there is more than one. */
    attach: { index: number; count: number } | null;
    /** The ghost meets track that sets its direction (snapped or inserting): rotating does nothing. */
    held: boolean }
  | { mode: 'placing-furniture'; name: string }
  | { mode: 'selected'; name: string; flip: 'mirror' | 'turn' | null;
    /** Why the piece can't turn on its own (joined at both ends), or ''. */
    rotateBlocked: string }
  | { mode: 'selected-furniture'; name: string };

export interface BarHandlers {
  rotate: (direction: 1 | -1) => void;
  flip: () => void;
  ramp: () => void;
  attach: () => void;
  done: () => void;
  rotateRoute: () => void;
  options: () => void;
  remove: () => void;
}

export interface BarAction {
  id: string;
  icon: IconName;
  label: string;
  /** Accessible name when it differs from the visible label (an icon-only button). */
  name?: string;
  /** Its key, shown as a badge and in the tooltip. */
  shortcut?: ShortcutId;
  /** Tooltip and accessible description (the key is added). */
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

const HELD_REASON = 'The track it meets sets its direction: Tab picks another way';

/** The bar's buttons for `context`, in order; the same rules (and words) as the keys they mirror. */
export function barActions(context: BarContext, handlers: BarHandlers): BarAction[] {
  if (context.mode === 'placing-furniture') return [
    { id: 'rotate', icon: 'rotate', label: 'Rotate 90°', shortcut: 'rotate', title: `Turn the ${context.name} 90° (⇧R turns back)`, onClick: () => handlers.rotate(1) },
    { id: 'done', icon: 'done', label: 'Done', shortcut: 'escape', title: 'Stop placing', onClick: handlers.done }];
  if (context.mode === 'selected-furniture') return [
    { id: 'rotate', icon: 'rotate', label: 'Rotate 90°', shortcut: 'rotate', title: `Turn the ${context.name} 90°`, onClick: () => handlers.rotate(1) },
    { id: 'delete', icon: 'delete', label: 'Delete', shortcut: 'delete', title: `Delete the ${context.name}`, danger: true, onClick: handlers.remove }];
  const blocked = context.mode === 'placing' ? context.held ? HELD_REASON : '' : context.rotateBlocked;
  const what = context.mode === 'placing' ? 'the piece' : 'this piece about its joint';
  const rotate: BarAction[] = [
    { id: 'rotate-back', icon: 'rotate-back', label: '', name: 'Rotate back 22.5°', shortcut: 'rotate-back', title: blocked || `Rotate ${what} −22.5°`, disabled: Boolean(blocked), onClick: () => handlers.rotate(-1) },
    { id: 'rotate', icon: 'rotate', label: '', name: 'Rotate 22.5°', shortcut: 'rotate', title: blocked || `Rotate ${what} 22.5°`, disabled: Boolean(blocked), onClick: () => handlers.rotate(1) }];
  if (context.mode === 'selected') return [
    ...rotate,
    ...(context.flip ? [{ id: 'flip', icon: 'flip' as const, label: 'Flip', shortcut: 'flip' as const, onClick: handlers.flip,
      title: `${context.flip === 'mirror' ? 'Swap left and right' : 'Turn the other way'} in place` }] : []),
    { id: 'route', icon: 'rotate-route', label: 'Rotate route', title: 'Rotate the whole connected track 22.5° about this piece', onClick: handlers.rotateRoute },
    { id: 'options', icon: 'options', label: 'Options…', title: 'Go to this piece’s options in the panel beside the Pieces sidebar', onClick: handlers.options },
    { id: 'delete', icon: 'delete', label: 'Delete', shortcut: 'delete', title: 'Delete this piece', danger: true, onClick: handlers.remove }];
  const turn = context.bend === 1 ? 'left ↶' : 'right ↷';
  const ramp = (rise: 1 | -1): Pick<BarAction, 'icon' | 'label'> => ({ icon: rise === 1 ? 'ramp-up' : 'ramp-down', label: `Ramp ${rise === 1 ? 'up ↗' : 'down ↘'} · 8 mm` });
  const flip: BarAction | null = context.flip === 'bend' ? { id: 'flip', icon: 'flip', label: `${context.sbend ? 'Shift' : 'Curve'} ${turn}`, shortcut: 'flip',
    title: `Turn the other way · now ${context.bend === 1 ? 'left' : 'right'}`, onClick: handlers.flip } :
    context.flip === 'mirror' ? { id: 'flip', icon: 'flip', label: 'Swap hand', shortcut: 'flip', title: 'Swap left and right', onClick: handlers.flip } :
    context.flip === 'rise' && context.rise ? { id: 'flip', ...ramp(context.rise), shortcut: 'flip', title: 'Climb the other way', onClick: handlers.flip } : null;
  return [
    ...rotate,
    ...(flip ? [flip] : []),
    // A ramp whose F does something else (a curved ramp's hand) keeps its own Ramp up/down.
    ...(context.rise && context.flip !== 'rise' ? [{ id: 'ramp', ...ramp(context.rise), title: 'Climb the other way', onClick: handlers.ramp }] : []),
    ...(context.attach && context.attach.count > 1 ? [{ id: 'attach', icon: 'other-side' as const, label: `Other side ${context.attach.index + 1}/${context.attach.count}`,
      shortcut: 'attach-next' as const, title: 'Face the other way where it joins the track (F gives the other hand; or point where you want it to go)', onClick: handlers.attach }] : []),
    { id: 'done', icon: 'done', label: 'Done', shortcut: 'escape', title: 'Stop placing', onClick: handlers.done }];
}

/** The bar's visible note: why rotating is off (a disabled button shows no tooltip), or ''. */
export function barNote(context: BarContext): string {
  return context.mode === 'selected' ? context.rotateBlocked : context.mode === 'placing' && context.held ? HELD_REASON : '';
}

/**
 * The placement bar: fixed at the bottom centre of the canvas, it never moves. While a piece is armed it names it and offers
 * rotate, flip, other side and Done; for a selected piece its rotate, flip, route, options and delete. The editor freezes the
 * ghost while the pointer is over the bar (`.placement-bar-dock`), so its buttons, R, F and Tab change the ghost where it is.
 */
export function PlacementBar({ context, actions, note, tip, onDismissTip }: {
  context: BarContext; actions: readonly BarAction[];
  /** Shown beside the name: why a button is off. */
  note: string;
  /** The one-time first-placement tip is showing. */
  tip: boolean; onDismissTip: () => void;
}) {
  const placing = context.mode === 'placing' || context.mode === 'placing-furniture';
  const stop = (event: SyntheticEvent) => event.stopPropagation();
  return <div className="placement-bar-dock" onPointerDown={stop} onClick={stop}>
    {tip && <div className="placement-tip" role="note"><span>{placementTip()}</span>
      <button type="button" aria-label="Dismiss tip" title="Dismiss tip" onClick={onDismissTip}><Icon name="close" size={13}/></button></div>}
    <div className={`placement-bar ${placing ? 'is-placing' : 'is-selected'}`} role="toolbar"
      aria-label={placing ? `Placing ${context.name}` : `Selected: ${context.name}`}>
      <div className="placement-bar-head">
        <strong>{placing ? <><span className="placement-bar-mode">Placing:</span> {context.name}</> : context.name}</strong>
        {note && <small>{note}</small>}
      </div>
      <div className="placement-bar-actions">{actions.map(action => <BarButton key={action.id} action={action}/>)}</div>
    </div>
  </div>;
}

/** One action button, with its key as a badge and in the tooltip (the placement bar and the piece panel). */
export function BarButton({ action }: { action: BarAction }) {
  const key = action.shortcut && keyLabel(action.shortcut);
  return <button type="button" className={action.danger ? 'is-danger' : undefined} disabled={action.disabled}
    title={key ? `${action.title} (${key})` : action.title} aria-label={action.name ?? action.label}
    aria-keyshortcuts={action.shortcut && ariaKeyShortcuts(action.shortcut)} onClick={action.onClick}>
    <Icon name={action.icon}/>{action.label && <span>{action.label}</span>}
    {action.shortcut && <kbd aria-hidden="true">{bindingLabel(shortcut(action.shortcut).keys![0])}</kbd>}
  </button>;
}
