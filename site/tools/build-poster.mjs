/**
 * Redraws the hero poster (site/img/hero-*.avif|webp) and the Open Graph card (site/img/og.jpg) from the live 3D hero,
 * so the still matches the model. Run after build-hero.mjs, with the site served and Chrome installed:
 *
 *   python3 -m http.server 8895 --directory site   (in another terminal)
 *   cd site/tools && node build-poster.mjs [http://127.0.0.1:8895/]
 *
 * Needs ImageMagick (`magick`) with AVIF support. Renders on the GPU (Metal) in headless Chrome. The poster is the
 * cinematic's first frame (hero3d.js `still: 'opening'`), so the crossfade to the live canvas is seamless; the OG image
 * is the whole-layout view (`still: 'full'`) drawn at 1200 × 630. Writes the 870 and 1740 px posters and img/og.jpg.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://127.0.0.1:8895/';
const img = join(dirname(fileURLToPath(import.meta.url)), '..', 'img');
const work = mkdtempSync(join(tmpdir(), 'hero-poster-'));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'load' });
/** Mounts a still hero of `width` × `height` CSS px over the page and screenshots it at 2×. */
async function still(view, width, height) {
  await page.evaluate(async (view, width, height) => {
    document.querySelector('#still')?.remove();
    // .hero-shot: the hero's background and the canvas fade-in, so the still looks like the page's hero.
    const box = Object.assign(document.createElement('div'), { id: 'still', className: 'hero-shot' });
    box.style.cssText = `position: fixed; inset: 0 auto auto 0; width: ${width}px; height: ${height}px; z-index: 99; box-shadow: none`;
    document.body.append(box);
    const { mountHero } = await import('./js/hero3d.js');
    await mountHero(box, { still: view });
    box.querySelector('.hero-hint')?.remove();
  }, view, width, height);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const path = join(work, `${view}.png`);
  await page.screenshot({ path, clip: { x: 0, y: 0, width, height } });
  return path;
}
// The poster box is 1740 × 1000 at 2×: a 870 × 500 hero, the same aspect as the page's hero.
const poster = await still('opening', 870, 500);
const og = await still('full', 600, 315);
await browser.close();

const magick = (...args) => execFileSync('magick', args, { stdio: 'inherit' });
for (const width of [870, 1740]) {
  magick(poster, '-filter', 'Lanczos', '-resize', `${width}x`, '-strip', '-quality', '74', '-define', 'webp:method=6', join(img, `hero-${width}.webp`));
  magick(poster, '-filter', 'Lanczos', '-resize', `${width}x`, '-strip', '-quality', '44', join(img, `hero-${width}.avif`));
}
magick(og, '-filter', 'Lanczos', '-resize', '1200x630!', '-strip', '-quality', '82', join(img, 'og.jpg'));
console.log('Poster and OG image written to', img);
