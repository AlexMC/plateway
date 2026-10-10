import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { WorkshopProject } from '../domain/project';
import { track } from '../net/telemetry';
import { START_EXAMPLES, exampleBase, exampleFacts, pickExample, type ExampleFacts, type StartExample } from './start-examples';
import './start-screen.css';

/** How placing works, for Build by hand and the empty table once the start screen is gone. */
export const BUILD_BY_HAND_TIP = 'Drag a tile onto the table, or click a tile then the table · R rotates · Esc stops';

function Facts({ facts }: { facts: ExampleFacts | undefined }) {
  if (!facts) return <span className="start-example-facts" aria-live="polite">Checking against your room…</span>;
  return <>
    <span className="start-example-facts">{facts.metres.toFixed(1)} m of track · <span className="start-owned">{facts.owned} owned</span> · <span className="start-printed">{facts.printed} to print</span></span>
    {facts.needsRoom ? <span className="start-example-fit is-warn"><b aria-hidden="true">!</b> Needs a bigger room — {facts.needsRoom === 'walls' ?
      'part of it would be outside your walls' : 'track would run into the shelf'}. You can still pick it.</span> :
      facts.problems ? <span className="start-example-fit is-warn"><b aria-hidden="true">!</b> {facts.problems} problem{facts.problems === 1 ? '' : 's'} with your setup</span> :
        <span className="start-example-fit"><b aria-hidden="true">✓</b> Fits this room</span>}
  </>;
}

function Thumbnail({ facts }: { facts: ExampleFacts | undefined }) {
  if (!facts) return <svg className="start-example-thumb" viewBox="0 0 1 1" aria-hidden="true"/>;
  const { viewBox, tracks, shelves } = facts.thumbnail;
  return <svg className="start-example-thumb" viewBox={viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    {shelves.map((shelf, index) => <rect key={index} className="start-thumb-shelf" {...shelf}/>)}
    {tracks.map((track, index) => <path key={index} className={track.owned ? 'start-thumb-owned' : 'start-thumb-printed'} d={track.d}/>)}
  </svg>;
}

/**
 * Build's first screen for a project without track: describe it, start from an example, or build by hand. It sits over
 * the table; Pieces and This build stay usable around it.
 */
export function StartScreen({ project, onDescribe, onPick, onBuildByHand }: {
  project: WorkshopProject;
  /** Opens Describe track with `text`; it asks for the user's Anthropic key first when it has none. */
  onDescribe: (text: string) => void;
  /** The example built onto the project: commit it as one change. */
  onPick: (next: WorkshopProject) => void;
  onBuildByHand: () => void;
}) {
  const id = useId();
  const section = useRef<HTMLElement>(null);
  const [text, setText] = useState('');
  const [facts, setFacts] = useState<Record<string, ExampleFacts>>({});
  const base = useMemo(() => exampleBase(project), [project]);
  // About 0.1 s per example: one per task, so the screen paints first and cards fill in.
  useEffect(() => {
    let index = 0, timer = 0;
    const next = () => {
      const example = START_EXAMPLES[index++];
      if (!example) return;
      const result = exampleFacts(example, base);
      setFacts(prior => ({ ...prior, [example.id]: result }));
      timer = window.setTimeout(next, 0);
    };
    timer = window.setTimeout(next, 0);
    return () => window.clearTimeout(timer);
  }, [base]);
  const hand = () => { track('start_hand'); onBuildByHand(); };
  const byHand = useRef(hand);
  byHand.current = hand;
  useEffect(() => {
    if (document.activeElement === document.body) section.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const focus = document.activeElement;
      if (focus === document.body || section.current?.contains(focus)) byHand.current();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  const describe = () => { if (text.trim()) { track('start_describe'); onDescribe(text.trim()); } };
  const pick = (example: StartExample) => { track('start_example'); onPick(pickExample(example, project)); };
  return <section ref={section} className="start-screen" aria-labelledby={`${id}-title`} tabIndex={-1}>
    <div className="start-screen-inner">
      <header className="start-screen-heading">
        <h2 id={`${id}-title`}>Start your layout</h2>
        <p>Three ways in. Whatever you pick stays editable, and Undo takes it back.</p>
      </header>
      <div className="start-choices">
        <section className="start-choice" aria-labelledby={`${id}-describe`}>
          <h3 id={`${id}-describe`}>Describe it</h3>
          <p>Say what you want in your own words. The app lays the track in your room and checks it, on your own Anthropic key.</p>
          <textarea aria-labelledby={`${id}-describe`} rows={4} value={text} placeholder="An oval with a siding that ends inside a KALLAX cubby"
            onChange={event => setText(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); describe(); } }}/>
          <button type="button" className="start-primary" disabled={!text.trim()} onClick={describe}>Generate</button>
        </section>
        <section className="start-choice" aria-labelledby={`${id}-examples`}>
          <h3 id={`${id}-examples`}>Start from an example</h3>
          <p>Ready-made layouts, measured against your room and the track you own.</p>
          <ul className="start-examples">{START_EXAMPLES.map(example => <li key={example.id}>
            <button type="button" className={`start-example ${facts[example.id]?.needsRoom ? 'is-warn' : ''}`} onClick={() => pick(example)}>
              <Thumbnail facts={facts[example.id]}/>
              <span className="start-example-text">
                <strong>{example.name}</strong>
                {example.description && <span className="start-example-description">{example.description}</span>}
                <Facts facts={facts[example.id]}/>
              </span>
            </button>
          </li>)}</ul>
          <div className="start-community">
            <h4>From the community</h4>
            <p>Layouts other people shared. Look around and test drive one, then remix it into your own.</p>
            <a href="#gallery">Browse shared layouts →</a>
            <a href="#contribute">Contribute a piece, train or furniture →</a>
          </div>
        </section>
        <section className="start-choice" aria-labelledby={`${id}-hand`}>
          <h3 id={`${id}-hand`}>Build by hand</h3>
          <p>Pick pieces from the Pieces list and lay them one by one.</p>
          <p className="start-tip">{BUILD_BY_HAND_TIP}</p>
          <button type="button" className="start-primary" onClick={hand}>Build by hand <kbd>Esc</kbd></button>
        </section>
      </div>
    </div>
  </section>;
}
