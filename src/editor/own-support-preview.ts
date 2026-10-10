import * as THREE from 'three';
import type { PartInstance } from '../domain/route';
import { bracketKnee, HELIX_COLUMN } from '../fitting/own-supports';

/** Plain shapes of helix column tubes and wall/shelf brackets for the 3D views (cad/models/helix_column, track_bracket). */
export function ownSupportGeometries(parts: readonly PartInstance[]): THREE.BufferGeometry[] {
  const geometries: THREE.BufferGeometry[] = [];
  for (const part of parts) {
    const { x, y, z, heading } = part.pose, p = part.parameters;
    if (part.family === 'helix_column') {
      const tube = new THREE.CylinderGeometry(HELIX_COLUMN.diameter / 2, HELIX_COLUMN.diameter / 2, p.height, 20);
      tube.rotateX(Math.PI / 2);
      tube.translate(x, y, z + p.height / 2);
      geometries.push(tube);
      if (p.foot) {
        const foot = new THREE.BoxGeometry(44, 44, 3);
        foot.translate(x, y, z + 1.5);
        geometries.push(foot);
      }
    } else if (part.family === 'track_bracket') {
      // Profile in (across to the wall, up) extruded along the track, seat top at the pose.
      const reach = p.reach, half = 16;
      const outline = p.mount === 1 ?
        [[-half, 0], [reach, 0], [reach, -bracketKnee(reach)], [reach - 5, -bracketKnee(reach)], [-half, -8]] :
        [[-half, 0], [half, 0], [half, -p.height + 4], [reach, -p.height + 4], [reach, -p.height], [-half, -p.height]];
      const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(outline.map(([u, v]) => new THREE.Vector2(u, v))), { depth: 15.2, bevelEnabled: false });
      geometry.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, -7.6, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
      geometry.rotateZ(heading);
      geometry.translate(x, y, z);
      geometries.push(geometry);
    }
  }
  return geometries;
}
