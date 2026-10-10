/**
 * Builds the landing page's live 3D hero from an export of the app's Test drive scene.
 *
 *   cd site/tools && npm install
 *   node build-hero.mjs <hero-raw.glb> <hero.json>
 *
 * hero-raw.glb and hero.json come from site/tools/export-hero/ (see the comment at the top of export-hero.tsx).
 * HERO_ERROR_MM (default 3) sets how far the layout's simplified surface may move from the app's geometry.
 * Camera keyframes: the `camera` block of site/tools/hero-scene.json, copied into hero.json.
 * Writes site/hero/hero.glb (layout + one node per car, meshopt-compressed) and site/hero/hero.json (route path and
 * car spacing). The three.js pieces site/js/hero3d.js imports are in the site's shared bundle (build-vendor.mjs).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, join as joinMeshes, prune, quantize, reorder, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const [input, meta] = process.argv.slice(2);
if (!input || !meta) throw new Error('Usage: node build-hero.mjs <hero-raw.glb> <hero.json>');
const site = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(site, 'hero'), { recursive: true });

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const document = await io.read(input);

// The hero is seen whole, so tie studs and connector detail are below a pixel. Every node is simplified to an
// absolute error in millimetres; on the layout, small disconnected parts (studs) are pruned outright. Each car stays
// its own node (the page moves them); meshes inside a node are joined by material.
const LAYOUT_ERROR_MM = Number(process.env.HERO_ERROR_MM ?? 3), CAR_ERROR_MM = 0.3;
const simplifyNodes = () => doc => {
  for (const group of doc.getRoot().listScenes()[0].listChildren()) {
    const layout = group.getName() === 'layout';
    for (const node of group.listChildren()) for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const indices = primitive.getIndices(), positions = primitive.getAttribute('POSITION');
      const [simplified] = MeshoptSimplifier.simplify(new Uint32Array(indices.getArray()), new Float32Array(positions.getArray()), 3, 0,
        layout ? LAYOUT_ERROR_MM : CAR_ERROR_MM, layout ? ['Prune', 'ErrorAbsolute'] : ['ErrorAbsolute']);
      indices.setArray(new Uint32Array(simplified));
      compactPrimitive(primitive);
    }
  }
};
await document.transform(
  dedup(),
  joinMeshes({ keepNamed: false }),
  weld(),
  simplifyNodes(),
  prune(),
  dedup(),
  reorder({ encoder: MeshoptEncoder }),
  quantize({ quantizePosition: 14, quantizeNormal: 8 })
);
document.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
await io.write(join(site, 'hero', 'hero.glb'), document);
// The page reads the camera keyframes from hero.json; they live with the scene in hero-scene.json.
const scene = JSON.parse(readFileSync(join(site, 'tools', 'hero-scene.json'), 'utf8'));
writeFileSync(join(site, 'hero', 'hero.json'), JSON.stringify({ ...JSON.parse(readFileSync(meta, 'utf8')), camera: scene.camera }));

for (const file of ['hero/hero.glb', 'hero/hero.json'])
  console.log(file, Math.round(statSync(join(site, file)).size / 1024), 'KB');
