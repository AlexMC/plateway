import { useMemo, useState } from 'react';
import * as THREE from 'three';
import { meshCentreline, meshEndsProblem, type MeshEnd } from '../domain/pieces/families/community';
import { centrelineInMesh, clearEnd, endFacesOut, flipEnd, placeEnd, snapEnd, type MarkedEnds, type StlMesh } from './ends';
import { ModelViewer } from './viewer';

const END_COLOURS = [0xb8e788, 0x8ac8ec] as const;
const ARROW = 22;

/** Why the marked ends can't make a piece yet, or null when they can. */
export function endsProblem(mesh: StlMesh, ends: MarkedEnds): string | null {
  const missing = ends.findIndex(end => !end);
  if (missing >= 0) return `Mark end ${missing + 1}: click an end face of the piece.`;
  const inward = ends.findIndex(end => !endFacesOut(mesh, end!));
  if (inward >= 0) return `End ${inward + 1} points into the piece or off its end face: flip its arrow or mark it again.`;
  return meshEndsProblem(ends as [MeshEnd, MeshEnd]);
}

/** What the marked track is: its shape and length, as the palette will describe it. */
function trackSummary(start: MeshEnd, end: MeshEnd): string {
  const points = meshCentreline(start, end);
  const run = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
  const degrees = Math.round(Math.abs(points.at(-1)!.heading) * 180 / Math.PI);
  return `${degrees === 0 ? 'Straight' : `${degrees}° curve`} · ${Math.round(run)} mm`;
}

function pieceObject(mesh: StlMesh): THREE.Object3D {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.faces, 1));
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  flat.computeVertexNormals();
  return new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ color: 0xefb77c, roughness: 0.7, metalness: 0.05 }));
}

function endsOverlay(ends: MarkedEnds, centreline: boolean): THREE.Object3D {
  const group = new THREE.Group();
  ends.forEach((end, index) => {
    if (!end) return;
    const at = new THREE.Vector3(end.x, end.y, end.z + 0.4);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 12), new THREE.MeshBasicMaterial({ color: END_COLOURS[index], depthTest: false }));
    marker.position.copy(at);
    marker.renderOrder = 2;
    group.add(marker);
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(Math.cos(end.heading), Math.sin(end.heading), 0), at, ARROW, END_COLOURS[index], 7, 5);
    arrow.traverse(part => { part.renderOrder = 2; });
    group.add(arrow);
  });
  if (centreline && ends[0] && ends[1]) {
    const points = centrelineInMesh(ends[0], ends[1]).map(point => new THREE.Vector3(point.x, point.y, point.z + 0.4));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
    line.renderOrder = 2;
    group.add(line);
  }
  return group;
}

/**
 * The mark-the-ends editor: a click on an end face places the next end, snapped to the connector grid, with an arrow
 * for its heading (from the face's normal) that Flip turns round; Clear removes only that end. Once both are marked the
 * centreline between them is drawn. `ends` without `onChange`: a read-only view (the quick look).
 */
export function EndsEditor({ mesh, ends, onChange }: { mesh: StlMesh; ends: MarkedEnds; onChange?: (ends: MarkedEnds) => void }) {
  const [hint, setHint] = useState('');
  const object = useMemo(() => pieceObject(mesh), [mesh]);
  const problem = useMemo(() => endsProblem(mesh, ends), [mesh, ends]);
  const overlay = useMemo(() => endsOverlay(ends, problem === null), [ends, problem]);
  function pick(hit: THREE.Intersection) {
    if (!onChange || hit.faceIndex == null) return;
    if (ends[0] && ends[1]) { setHint('Both ends are marked: clear one to mark it again.'); return; }
    const end = snapEnd(mesh, hit.faceIndex);
    if (typeof end === 'string') { setHint(end); return; }
    setHint('');
    onChange(placeEnd(ends, end));
  }
  return <div className="contribute-ends">
    <ModelViewer object={object} overlay={overlay} onPick={onChange ? pick : undefined}
      label={onChange ? 'The piece in 3D: click an end face to mark a track end' : 'The piece in 3D with its marked ends'} />
    <ol className="contribute-end-list">
      {([0, 1] as const).map(index => {
        const end = ends[index];
        return <li key={index} className={`contribute-end end-${index + 1}`}>
          <span className="contribute-end-swatch" aria-hidden="true" />
          <span className="contribute-end-text"><strong>End {index + 1}</strong> {end ?
            <>x {end.x}, y {end.y}, rail height {end.z} mm, facing {Math.round(end.heading * 180 / Math.PI)}°</> : <em>not marked</em>}</span>
          {onChange && end && <>
            <button type="button" className="quiet-button" onClick={() => onChange(flipEnd(ends, index))}>Flip arrow</button>
            <button type="button" className="quiet-button" onClick={() => onChange(clearEnd(ends, index))}>Clear</button>
          </>}
        </li>;
      })}
    </ol>
    {hint && <p className="account-error" role="alert">{hint}</p>}
    <p className={`contribute-status${problem ? ' is-warn' : ''}`} role="status">
      {problem ?? `Track: ${trackSummary(ends[0]!, ends[1]!)}. The white line is its centreline; check it runs along the rails.`}</p>
  </div>;
}
