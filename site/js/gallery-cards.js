// The community gallery on the landing site: the anonymous list endpoint (`GET /api/gallery`, cursor-paged, see
// cad/service/gallery.py), each layout's structured thumbnail drawn as SVG the way the app's `GalleryThumb` does
// (src/gallery/views.tsx), the gallery page's cards and the landing's strip. Member text only ever goes in as text.

const SVG = 'http://www.w3.org/2000/svg';
const LIST = '/api/gallery';

/** One page of the gallery as anyone sees it: no session cookie, so a signed-in author's hidden layouts stay out. */
async function fetchPage(fetcher, before) {
  const response = await fetcher(before ? `${LIST}?before=${encodeURIComponent(before)}` : LIST,
    { credentials: 'omit', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`The gallery answered ${response.status}`);
  return await response.json();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The structured top view, y already flipped: shelves, then owned and printed centrelines. */
export function thumbnailSvg(thumbnail) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'gallery-thumb');
  if (!thumbnail) {
    svg.setAttribute('viewBox', '0 0 1 1');
    return svg;
  }
  svg.setAttribute('viewBox', thumbnail.box.join(' '));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  for (const [x, y, width, height] of thumbnail.shelves) {
    const shelf = document.createElementNS(SVG, 'rect');
    shelf.setAttribute('class', 'gallery-thumb-shelf');
    Object.entries({ x, y, width, height }).forEach(([name, value]) => shelf.setAttribute(name, String(value)));
    svg.append(shelf);
  }
  for (const track of thumbnail.tracks) {
    const line = document.createElementNS(SVG, 'polyline');
    line.setAttribute('class', track.owned ? 'gallery-thumb-owned' : 'gallery-thumb-printed');
    line.setAttribute('points', track.points.join(' '));
    svg.append(line);
  }
  return svg;
}

/** A gallery card: thumbnail, title, author, remix credit, date and pieces, and the layout's page in the app. */
export function layoutCard(item, appUrl) {
  const href = `${appUrl}#gallery=${item.id}`;
  const card = element('li', 'gallery-card');
  card.id = `layout-${item.id}`;
  const picture = element('a', 'gallery-card-thumb');
  picture.href = href;
  picture.tabIndex = -1;
  picture.setAttribute('aria-hidden', 'true');
  picture.append(thumbnailSvg(item.thumbnail));

  const text = element('div', 'gallery-card-text');
  const info = element('div', 'gallery-card-info');
  const meta = element('p', 'gallery-card-meta', `by ${item.author} · `);
  const date = element('time', '', new Date(item.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
  date.dateTime = item.publishedAt;
  meta.append(date, ` · ${item.pieces} ${item.pieces === 1 ? 'piece' : 'pieces'}`);
  info.append(element('h3', 'gallery-card-title', item.title), meta);
  if (item.remixOf) info.append(element('p', 'gallery-card-remix', `Remix of “${item.remixOf.title}” by ${item.remixOf.author}`));
  if (item.description) info.append(element('p', 'gallery-card-description', item.description));
  const open = element('a', 'btn btn-ghost btn-small gallery-card-open', 'Open in Plateway');
  open.href = href;
  open.setAttribute('aria-label', `Open “${item.title}” in Plateway`);
  text.append(info, open);

  card.append(picture, text);
  return card;
}

/**
 * The gallery page: newest first, Load more continues from the last page's cursor. `settled` is the load in flight
 * (or the last one), so a caller can wait for what a click started. A `#layout-<id>` hash (a landing thumbnail) marks
 * and scrolls to that card once the first page is in: the browser's own jump ran before the cards existed.
 */
export function mountGallery(root, { appUrl, fetcher = fetch, hash = location.hash }) {
  const part = name => root.querySelector(`[data-gallery-${name}]`);
  const list = part('list'), status = part('status'), empty = part('empty'), error = part('error'), more = part('more');
  const moreLabel = more.textContent;
  let cursor = null, shown = 0;
  const state = { settled: Promise.resolve() };

  async function load() {
    error.hidden = true;
    more.disabled = true;
    more.textContent = 'Loading…';
    try {
      const page = await fetchPage(fetcher, cursor);
      const cards = page.layouts.map(item => layoutCard(item, appUrl));
      list.append(...cards);
      const linked = shown === 0 && cards.find(card => `#${card.id}` === hash);
      if (linked) {
        linked.classList.add('is-target');
        linked.scrollIntoView({ block: 'start' });
      }
      shown += page.layouts.length;
      cursor = page.next;
      empty.hidden = shown > 0;
      more.hidden = !cursor;
    } catch {
      part('error-text').textContent = shown ? 'Could not load more layouts.' : 'Could not load the gallery.';
      error.hidden = false;
    } finally {
      status.hidden = true;
      more.disabled = false;
      more.textContent = moreLabel;
    }
  }
  const start = () => { state.settled = load(); };
  more.addEventListener('click', start);
  part('retry').addEventListener('click', start);
  start();
  return state;
}

/** The landing's strip: the newest `count` thumbnails, each linking to its card on the gallery page. An empty gallery
 * shows its invitation; a gallery that cannot load hides the strip. */
export async function mountStrip(root, { fetcher = fetch, count = 6 } = {}) {
  const strip = root.querySelector('[data-gallery-strip]');
  try {
    const { layouts } = await fetchPage(fetcher, null);
    const tiles = layouts.slice(0, count).map(item => {
      const tile = element('li', 'gallery-tile');
      const link = element('a');
      link.href = `gallery.html#layout-${item.id}`;
      link.setAttribute('aria-label', `${item.title} by ${item.author}`);
      link.append(thumbnailSvg(item.thumbnail), element('span', 'gallery-tile-title', item.title));
      tile.append(link);
      return tile;
    });
    strip.replaceChildren(...tiles);
    strip.hidden = tiles.length === 0;
    root.querySelector('[data-gallery-strip-empty]').hidden = tiles.length > 0;
  } catch {
    root.hidden = true;
  }
}
