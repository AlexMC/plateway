/**
 * The landing page's library strip (#library): live counts and up to eight items, a mix of kinds, each a 3D preview
 * linking to its card on library.html. Nothing loads until the section is near the viewport; without the index the
 * section keeps its static copy and buttons.
 */
import { countLine, kindOf, stripItems } from './library-data.js';
import { loadIndex, previewBox, warmPreviews } from './library-cards.js';

const STRIP = 8;
const section = document.getElementById('library');
const strip = section?.querySelector('[data-library-strip]');
const live = section?.querySelector('[data-library-live]');

async function fill() {
  warmPreviews();
  let index;
  try { index = await loadIndex(); } catch (error) { console.warn('Library strip not shown:', error); return; }
  if (!index.items.length) return;
  live.querySelector('[data-library-count]').textContent = countLine(index.items);
  live.hidden = false;
  strip.replaceChildren(...stripItems(index.items, STRIP).map(item => {
    const li = document.createElement('li'), tile = document.createElement('a');
    tile.className = 'lib-tile';
    tile.href = `library.html#${encodeURIComponent(item.id)}`;
    const name = document.createElement('span'), kind = document.createElement('span');
    name.className = 'lib-tile-name';
    name.textContent = item.name;
    kind.className = 'lib-tile-kind';
    kind.textContent = kindOf(item).singular;
    tile.append(previewBox(item, index.indexUrl, { spin: 'hover', decorative: true, eager: true }), name, kind);
    li.append(tile);
    return li;
  }));
  strip.hidden = false;
}

if (strip && live) {
  const near = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    near.disconnect();
    fill();
  }, { rootMargin: '800px 0px' });
  near.observe(section);
}
