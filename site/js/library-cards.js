/**
 * What library.html and the landing strip share: loading the index, and an item's preview box, which draws its still
 * (library-preview.js, imported with three.js only once a preview is about to scroll into view) and can spin.
 */
import { LIBRARY_INDEX_URL, itemFileUrl, liveItems } from './library-data.js';

/** The live items and the index's final URL (on the hosted site, the library bucket after the redirect). */
export async function loadIndex() {
  const response = await fetch(LIBRARY_INDEX_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`The library index did not load (${response.status}).`);
  return { items: liveItems(await response.json()), indexUrl: response.url };
}

/** Previews need WebGL 2 (as the landing hero does) and are skipped under Save-Data: a piece's STL is megabytes. */
const previews = (() => {
  if (navigator.connection?.saveData) return false;
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
})();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let renderer = null;
const loadRenderer = () => renderer ??= import('./library-preview.js');
/** Starts downloading the renderer (and three.js) now, when the page is sure to draw previews. */
export const warmPreviews = () => { if (previews) loadRenderer().catch(() => { renderer = null; }); };

let firstShown = false;
const observer = previews && new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    observer.unobserve(entry.target);
    entry.target.libraryDraw();
  }
}, { rootMargin: '400px 0px' });

/**
 * The preview box of `item`: a still drawn when it nears the viewport, a note when it can't be. `onSize` gets the
 * model's size ([x, y, z] mm) once drawn. `spin`: 'button' makes the box a toggle (tap, Enter) that also spins on
 * mouse hover; 'hover' spins on mouse hover only (inside a link); none never spins. Reduced motion never spins.
 * `decorative` leaves the image without alt text, for a box inside a link that already names the item. `eager` draws
 * at once, for boxes the caller only builds near the viewport (the landing strip, whose sideways scroller would
 * otherwise hide its later boxes from the observer).
 */
export function previewBox(item, indexUrl, { onSize, spin, decorative = false, eager = false } = {}) {
  const url = itemFileUrl(item, indexUrl), interactive = spin === 'button' && previews && !reduceMotion.matches;
  const box = document.createElement(interactive ? 'button' : 'div');
  box.className = 'lib-preview';
  box.dataset.kind = item.kind;
  const note = document.createElement('span');
  note.className = 'lib-preview-note';
  box.append(note);
  if (!previews || !url) {
    box.dataset.state = 'off';
    note.textContent = url ? 'Preview off' : 'No preview';
    return box;
  }
  box.dataset.state = 'loading';
  note.textContent = 'Drawing preview…';
  const image = new Image(640, 480);
  image.alt = decorative ? '' : `${item.name}, 3D preview`;
  image.decoding = 'async';
  box.prepend(image);

  box.libraryDraw = async () => {
    try {
      const { preview } = await loadRenderer();
      const { blob, size } = await preview(item, url);
      image.src = URL.createObjectURL(blob);
      await image.decode().catch(() => {});
      box.dataset.state = 'ready';
      note.textContent = '';
      if (!firstShown) { firstShown = true; performance.mark('library-first-preview'); }
      onSize?.(size);
    } catch (error) {
      console.warn(`Library preview of ${item.id} not shown:`, error);
      box.dataset.state = 'failed';
      note.textContent = 'Preview unavailable';
    }
  };
  if (eager) box.libraryDraw(); else observer.observe(box);

  if ((spin === 'button' || spin === 'hover') && !reduceMotion.matches) addSpin(box, item, url, interactive);
  return box;
}

/** Spins while a mouse is over the box; a button box also toggles on tap, click or Enter. */
function addSpin(box, item, url, toggle) {
  let canvas = null, stop = null, pointer = '';
  const start = async () => {
    if (stop || box.dataset.state !== 'ready') return;
    const { WIDTH, HEIGHT, spin } = await loadRenderer();
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'lib-spin';
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      canvas.setAttribute('aria-hidden', 'true');
      box.append(canvas);
    }
    stop = spin(item, url, canvas, () => box.classList.add('is-spinning'));
    if (toggle) box.setAttribute('aria-pressed', 'true');
  };
  const end = () => {
    stop?.();
    stop = null;
    box.classList.remove('is-spinning');
    if (toggle) box.setAttribute('aria-pressed', 'false');
  };
  box.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') start(); });
  box.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') end(); });
  if (!toggle) return;
  box.type = 'button';
  box.setAttribute('aria-pressed', 'false');
  box.setAttribute('aria-label', `Turn the 3D preview of ${item.name}`);
  box.addEventListener('pointerdown', event => { pointer = event.pointerType; });
  // A mouse already spins it by hovering; touch, pen and keyboard toggle it.
  box.addEventListener('click', () => {
    const mouse = pointer === 'mouse';
    pointer = '';
    if (!mouse) stop ? end() : start();
  });
  box.addEventListener('blur', () => { if (pointer !== 'mouse') end(); });
}
