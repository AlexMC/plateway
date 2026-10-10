/**
 * Bundles the three.js pieces the landing site uses into site/js/vendor/three-site.js, one ES module shared by the
 * live hero (site/js/hero3d.js) and the community library previews (site/js/library-preview.js, used by library.html
 * and the landing page's library strip), so a page that shows both loads three.js once.
 *
 *   cd site/tools && npm install
 *   node build-vendor.mjs
 *
 * three.js comes from the repository's own node_modules, the version the app ships. Add an export here when either
 * script needs another piece.
 */
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(site, 'js', 'vendor', 'three-site.js');
await build({
  stdin: {
    contents: `export { Box3, BoxGeometry, DirectionalLight, GridHelper, Group, HemisphereLight, Mesh, MeshStandardMaterial,
  PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, Scene, ShadowMaterial, Vector3, WebGLRenderer } from 'three';
export { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
export { STLLoader } from 'three/addons/loaders/STLLoader.js';
export { OrbitControls } from 'three/addons/controls/OrbitControls.js';
export { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';`,
    resolveDir: join(site, '..'), loader: 'js'
  },
  bundle: true, format: 'esm', minify: true, outfile, legalComments: 'eof'
});
console.log('js/vendor/three-site.js', Math.round(statSync(outfile).size / 1024), 'KB');
