import { useEffect, useMemo, useRef, useState } from 'react';
import { paramValue, pieceDefinition, pieceState, pieceStates, stepState } from '../domain/pieces';
import { frontReach, rearReach } from '../domain/car-geometry';
import { realCars, type WorkshopProject } from '../domain/project';
import type { FitResult } from '../fitting/fit';
import { inspectDrive } from './collision';
import { routeProblem, trainGauge, trainProblem } from './compat';
import { driveResults } from './results';
import { DriveScene, type InspectionMesh } from './scene';
import { advanceConsist, finalLeadDistance, placeConsist, startingLeadDistance, type TrainFrame } from './train';
import { routePath, samplePath, type RoutePath } from './traversal';
import './drive.css';

function TopView({ fit, path, frame }: { fit: FitResult; path: RoutePath; frame: TrainFrame }) {
  const scene = useMemo(() => {
    const paths: { id: string; routeId: string; points: string }[] = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const section of fit.sections) {
      if (section.kind === 'unresolved' || section.moving && section.enabled === false) continue;
      const fitted = {routeId:section.routeId,sections:[section],length:section.run,gap:null};
      const steps = Math.max(2, Math.ceil(section.run / 16));
      let points = '';
      for (let index = 0; index <= steps; index++) {
        const point = samplePath(fitted, section.run * index / steps)!;
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
        points += `${point.x},${point.y} `;
      }
      paths.push({ id: section.id, routeId: section.routeId, points });
    }
    if (!paths.length) { minX = minY = 0; maxX = 600; maxY = 400; }
    const pad = Math.max(60, Math.max(maxX - minX, maxY - minY) * 0.08);
    return { paths, stroke: Math.max(12, Math.min(45, (maxX - minX) * 0.025)),
      viewBox: `${minX - pad} ${minY - pad} ${Math.max(300, maxX - minX + pad * 2)} ${Math.max(250, maxY - minY + pad * 2)}` };
  }, [fit]);
  return <svg className="drive-top-view" viewBox={scene.viewBox} role="img" aria-label="Top view of actual fitted track and full train">
    {scene.paths.map(item => <polyline key={item.id} points={item.points}
      className={item.routeId === path.routeId ? 'drive-track-active' : 'drive-track-other'} fill="none" strokeWidth={scene.stroke} strokeLinecap="round" strokeLinejoin="round" />)}
    {frame.cars.map((placed, index) => <g key={placed.car.id} transform={`translate(${placed.pose.x} ${placed.pose.y}) rotate(${placed.pose.heading * 180 / Math.PI})`}
      className={index === 0 ? 'drive-top-loco' : 'drive-top-wagon'}>
      {/* A measured car's silhouette; otherwise its body from rear to front coupling face. */}
      {placed.car.outline ? <polygon points={placed.car.outline.map(([x, y]) => `${x},${y}`).join(' ')} /> :
        <rect x={-rearReach(placed.car)} y={-placed.car.width / 2} width={frontReach(placed.car) + rearReach(placed.car)} height={placed.car.width} rx="6" />}
    </g>)}
  </svg>;
}

export function DrivePanel({ project, fit, meshes = [], onEditTrack, onGoToPrint, onOpenSetup, onDriven, onSetState }: {
  project: WorkshopProject; fit: FitResult; meshes?: readonly InspectionMesh[];
  onEditTrack?: () => void; onGoToPrint?: () => void; onOpenSetup?: () => void;
  /** Sets a junction's state; the fitted routes follow it. */
  onSetState?: (pieceId: string, state: string) => void;
  /** Called when the train reaches the end of a route. */
  onDriven?: () => void;
}) {
  const [routeId, setRouteId] = useState(project.routes[0]?.id ?? '');
  const [leadDistance, setLeadDistance] = useState(() => startingLeadDistance(project.cars));
  const [speed, setSpeed] = useState(80);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [view, setView] = useState<'top' | '3d'>('3d');
  const [playing, setPlaying] = useState(false);
  const [remainingRoutes, setRemainingRoutes] = useState<string[]>([]);
  const [routeFinished, setRouteFinished] = useState(false);
  const [status, setStatus] = useState('');
  const gauge = trainGauge(project.cars);
  const path = useMemo(() => routePath(fit.sections, routeId, gauge), [fit, routeId, gauge]);
  const frame = placeConsist(path, project.cars, leadDistance);
  const inspection = inspectDrive(project, fit, frame);
  const problem = trainProblem(project.cars, path.sections);
  const results = driveResults(project, fit, path, frame, inspection, problem);
  const canDrive = frame.cars.length === project.cars.length && project.cars.length > 0 && !frame.warning && !problem;
  const exampleTrain = project.cars.length > 0 && project.cars.every(car => car.example);
  const carsKey = JSON.stringify(project.cars);
  const sequenceActive = useRef(false);
  const driven = useRef(onDriven);
  driven.current = onDriven;
  const current = useRef({ distance: leadDistance, speed, direction, path, cars: project.cars, remaining: remainingRoutes.length });
  current.current = { distance: leadDistance, speed, direction, path, cars: project.cars, remaining: remainingRoutes.length };

  useEffect(() => {
    setPlaying(false);
    setRemainingRoutes([]);
    setRouteFinished(false);
    sequenceActive.current = false;
    setLeadDistance(startingLeadDistance(project.cars));
    setStatus('');
  }, [project.layoutRevision, carsKey]);
  useEffect(() => {
    if (!project.routes.some(route => route.id === routeId)) setRouteId(project.routes[0]?.id ?? '');
  }, [project.routes, routeId]);
  useEffect(() => {
    if (!playing) return;
    let animation = 0, previous = performance.now();
    const tick = (now: number) => {
      const state = current.current;
      const next = advanceConsist(state.path, state.cars, state.distance, state.speed * state.direction,
        Math.max(0, Math.min((now - previous) / 1000, 0.1)));
      previous = now;
      setLeadDistance(next.leadDistance);
      if (next.stopped) {
        setPlaying(false);
        setRouteFinished(true);
        if (next.cars.length) driven.current?.();
        setStatus(sequenceActive.current && state.remaining === 0 ? 'All routes driven.' : next.warning ?? 'The train stopped.');
        if (state.remaining === 0) sequenceActive.current = false;
      } else animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing]);
  useEffect(() => {
    if (playing || !routeFinished || !remainingRoutes.length) return;
    const [nextId, ...rest] = remainingRoutes;
    setRouteFinished(false);
    setRemainingRoutes(rest);
    setRouteId(nextId);
    const nextPath = routePath(fit.sections, nextId, gauge);
    setLeadDistance(direction === 1 ? startingLeadDistance(project.cars) : finalLeadDistance(project.cars, nextPath.length));
    setStatus(`Now driving ${project.routes.find(route => route.id === nextId)?.name ?? 'the next route'}.`);
    setPlaying(true);
  }, [playing, routeFinished, remainingRoutes, fit, project.cars, project.routes, direction, gauge]);

  const orderedRoutes = useMemo(() => {
    const first = fit.crossings[0];
    const ids = [first?.upperRouteId, first?.lowerRouteId, ...project.routes.map(route => route.id)];
    return [...new Set(ids.filter((id): id is string => !!id && project.routes.some(route => route.id === id)))];
  }, [fit.crossings, project.routes]);
  // Run all skips routes this train can't run (another gauge) and says so; the rest must all be drivable.
  const runnable = useMemo(() => orderedRoutes.filter(id => routeProblem(fit.sections, id, project.cars) === null), [orderedRoutes, fit.sections, project.cars]);
  const skipped = orderedRoutes.filter(id => !runnable.includes(id)).map(id => project.routes.find(route => route.id === id)?.name ?? id);
  const allReady = useMemo(() => runnable.length > 1 && project.cars.length > 0 && runnable.every(id => {
    const candidate = routePath(fit.sections, id, gauge);
    return !candidate.gap && placeConsist(candidate, project.cars,
      direction === 1 ? startingLeadDistance(project.cars) : finalLeadDistance(project.cars, candidate.length)).cars.length === project.cars.length;
  }), [runnable, fit.sections, project.cars, direction, gauge]);
  const minimum = startingLeadDistance(project.cars);
  const maximum = Math.max(minimum, finalLeadDistance(project.cars, path.length));
  const progress = maximum > minimum ? Math.min(100, Math.max(0, (leadDistance - minimum) / (maximum - minimum) * 100)) : 0;
  let walked = 0;
  const activeSection = path.sections.find(section => { walked += section.run; return leadDistance <= walked; });
  const segment = activeSection?.kind === 'transition' ? 'Climbing the ramp' : activeSection?.kind === 'curve' ? 'Around the curve' : 'On the track';
  const addTrain = onOpenSetup && <button type="button" onClick={onOpenSetup}>Add your train</button>;
  const settable = project.routes.flatMap(route => route.pieces ?? []).filter(piece => pieceStates(piece)?.length);
  // Moving pieces (turntables, transfer tables, bridges, elevators) are operated; junctions are thrown.
  const switches = settable.filter(piece => !pieceDefinition(piece.family).halt);
  const mechanisms = settable.filter(piece => pieceDefinition(piece.family).halt);

  function chooseDirection(next: 1 | -1) {
    setDirection(next);
    setRemainingRoutes([]);
    setRouteFinished(false);
    sequenceActive.current = false;
    if (next === -1 && leadDistance <= minimum) setLeadDistance(maximum);
    if (next === 1 && leadDistance >= maximum) setLeadDistance(minimum);
  }
  function runAll() {
    if (!allReady || playing) return;
    const [first, ...rest] = runnable;
    const firstPath = routePath(fit.sections, first, gauge);
    setRouteId(first);
    setRemainingRoutes(rest);
    setRouteFinished(false);
    sequenceActive.current = true;
    setLeadDistance(direction === 1 ? startingLeadDistance(project.cars) : finalLeadDistance(project.cars, firstPath.length));
    setStatus(skipped.length ? `Skipping ${skipped.join(', ')}: this train can’t run there.` : '');
    setPlaying(true);
  }

  return <section className="drive-panel" aria-label="Test drive">
    <div className="drive-stage">
      <div className="drive-scene-area">
        <div className="drive-overlay drive-overlay-left"><div className="drive-segmented" role="group" aria-label="View">
          <button type="button" className={view === 'top' ? 'active' : ''} aria-pressed={view === 'top'} onClick={() => setView('top')}>Top view</button>
          <button type="button" className={view === '3d' ? 'active' : ''} aria-pressed={view === '3d'} onClick={() => setView('3d')}>3D</button>
        </div>{view === '3d' && <span className="drive-hint">Drag to orbit · scroll to zoom</span>}</div>
        {project.routes.length > 1 && <div className="drive-overlay drive-overlay-right"><div className="drive-segmented drive-route-toggle" role="group" aria-label="Drive route">
          {project.routes.map(route => <button type="button" key={route.id} disabled={playing} className={routeId === route.id ? 'active' : ''} aria-pressed={routeId === route.id} onClick={() => {
            sequenceActive.current = false; setRouteId(route.id); setRemainingRoutes([]); setRouteFinished(false); setLeadDistance(direction === 1 ? startingLeadDistance(project.cars) : finalLeadDistance(project.cars, routePath(fit.sections, route.id, gauge).length));
            setStatus('');
          }}>{route.name}</button>)}
        </div></div>}
        {view === '3d' ? <DriveScene fit={fit} frame={frame} meshes={meshes} standardTrack={project.trackSystem === 'brick-v1'} project={project} /> : <TopView fit={fit} path={path} frame={frame} />}
        {!project.routes.length ? <div className="drive-empty">No track to drive yet.{onEditTrack && <button type="button" onClick={onEditTrack}>Build track first</button>}</div> :
          !project.cars.length && <div className="drive-empty">Add your train to drive this route.{addTrain}</div>}
        <div className="drive-transport">
          <button type="button" className={direction === -1 ? 'drive-direction selected' : 'drive-direction'} aria-label="Reverse" aria-pressed={direction === -1} onClick={() => chooseDirection(-1)}>◀</button>
          <button type="button" className="drive-play" aria-label={playing ? 'Pause train' : 'Drive train'} disabled={!playing && !canDrive} onClick={() => {
            if (!playing && direction === 1 && leadDistance >= maximum) setLeadDistance(minimum);
            if (!playing && direction === -1 && leadDistance <= minimum) setLeadDistance(maximum);
            setPlaying(value => !value); setStatus('');
          }}>{playing ? 'Ⅱ' : '▶'}</button>
          <button type="button" className={direction === 1 ? 'drive-direction selected' : 'drive-direction'} aria-label="Forward" aria-pressed={direction === 1} onClick={() => chooseDirection(1)}>▶</button>
          <div className="drive-transport-divider" />
          <div className="drive-progress"><div><span>{segment} · {(leadDistance / 1000).toFixed(1)} of {(path.length / 1000).toFixed(1)} m</span><label className="drive-speed">speed <input aria-label="Drive speed" type="range" min="20" max="240" step="10" value={speed} onChange={event => setSpeed(Number(event.target.value))} /><output>{speed} mm/s</output></label></div>
            <div role="progressbar" aria-label="Route progress" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100} className="drive-progress-track"><span style={{ width: `${progress}%` }} /></div></div>
          {orderedRoutes.length > 1 && <><div className="drive-transport-divider" />
            <button type="button" className="drive-both" disabled={!allReady || playing} onClick={runAll}
              title={skipped.length ? `Skips ${skipped.join(', ')}: this train can’t run there.` : undefined}>Run all<br />routes</button></>}
        </div>
        <p className="drive-caveat">Preview only — run your real train after printing.</p>
      </div>
      <aside className="drive-side"><header><h2>RESULTS</h2></header>
        <div className="drive-result-list">{results.map(result => <article className={`drive-result drive-result-${result.status}`} key={result.title}>
          <span className="drive-result-icon" aria-hidden="true">{result.status === 'clear' ? '✓' : result.status === 'blocked' ? '!' : '?'}</span><div><h3>{result.title}</h3><p>{result.detail}</p>
            {result.action === 'track' && onEditTrack && <button type="button" onClick={onEditTrack}>Edit track →</button>}
            {result.action === 'setup' && onOpenSetup && <button type="button" onClick={onOpenSetup}>{realCars(project).length ? 'Edit your train →' : 'Add your train →'}</button>}</div>
        </article>)}</div>
        {status && <p className="drive-status" role="status">{status}</p>}
        {switches.length > 0 && onSetState && <><h2 className="drive-train-heading">SWITCHES</h2>
          <div className="drive-switches">{switches.map((piece, index) => {
            const definition = pieceDefinition(piece.family);
            const sprung = definition.params.some(spec => spec.key === 'sprung') && paramValue(definition, piece, 'sprung') === 1;
            return <label className="drive-switch" key={piece.id}><span>{definition.label} {index + 1}{sprung && <em title="Trains trail through from the other route; the points spring back"> · sprung</em>}</span>
              <select aria-label={`${definition.label} ${index + 1} setting`} value={pieceState(piece)} disabled={playing}
                onChange={event => onSetState(piece.id, event.target.value)}>
                {pieceStates(piece)!.map(state => <option key={state.id} value={state.id}>{state.label}</option>)}
              </select></label>;
          })}</div></>}
        {mechanisms.length > 0 && onSetState && <><h2 className="drive-train-heading">MECHANISMS</h2>
          <div className="drive-switches">{mechanisms.map((piece, index) => {
            const definition = pieceDefinition(piece.family), name = `${definition.label} ${index + 1}`;
            return <div className="drive-switch drive-mechanism" key={piece.id}><span>{name}</span>
              <span className="drive-mechanism-controls">
                <button type="button" aria-label={`${name}: previous setting`} disabled={playing} onClick={() => onSetState(piece.id, stepState(piece, -1))}>◀</button>
                <select aria-label={`${name} setting`} value={pieceState(piece)} disabled={playing}
                  onChange={event => onSetState(piece.id, event.target.value)}>
                  {pieceStates(piece)!.map(state => <option key={state.id} value={state.id}>{state.label}</option>)}
                </select>
                <button type="button" aria-label={`${name}: next setting`} disabled={playing} onClick={() => onSetState(piece.id, stepState(piece, 1))}>▶</button>
              </span></div>;
          })}</div></>}
        <h2 className="drive-train-heading">TRAIN</h2>
        <div className="drive-train-chips">{project.cars.map((car, index) => <span className="drive-train-chip" key={car.id}>{index === 0 && <i aria-hidden="true" />}{car.name}</span>)}
          {!project.cars.length && <p className="drive-train-note">No cars yet. {addTrain}</p>}</div>
        {exampleTrain && <p className="drive-train-note">Example train. {addTrain}</p>}
        <div className="drive-side-actions"><button type="button" className="drive-next" onClick={onGoToPrint} disabled={!onGoToPrint}>Print →</button><button type="button" className="drive-back" onClick={onEditTrack} disabled={!onEditTrack}>Edit track</button></div>
      </aside>
    </div>
  </section>;
}
