// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error The landing site's plain-JS module has no type declarations.
import { layoutCard, mountGallery, mountStrip, thumbnailSvg } from '../site/js/gallery-cards.js';

const THUMBNAIL = { box: [0, -600, 1200, 600], tracks: [{ points: [0, 0, 600, 0, 1200, -300], owned: true }, { points: [0, 0, 0, -500], owned: false }],
  shelves: [[100, -500, 400, 200]] };
let serial = 0;
function layout(overrides: Record<string, unknown> = {}) {
  serial += 1;
  return { id: `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`, title: `Loop ${serial}`, description: '', author: 'Ada',
    licence: 'CC-BY-4.0', publishedAt: '2026-10-09T12:00:00Z', pieces: 12, thumbnail: THUMBNAIL, remixOf: null, mine: false, ...overrides };
}

/** A stand-in for the anonymous list endpoint: pages by cursor, or fails while `down` is set. */
function service(pages: Record<string, { layouts: unknown[]; next: string | null }>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const state = { down: false, calls };
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (state.down) return new Response('{"detail":"Service unavailable"}', { status: 503 });
    const before = new URL(url, 'http://plateway.test').searchParams.get('before') ?? '';
    return Response.json(pages[before]);
  };
  return { fetcher, state };
}

const shown = (element: Element | null) => element !== null && !(element as HTMLElement).hidden;

function galleryPage() {
  document.body.innerHTML = `<section data-gallery>
    <p data-gallery-status>Loading</p>
    <ul data-gallery-list></ul>
    <div data-gallery-empty hidden></div>
    <div data-gallery-error hidden><p data-gallery-error-text></p><button type="button" data-gallery-retry>Try again</button></div>
    <button type="button" data-gallery-more hidden>Load more</button>
  </section>`;
  const root = document.querySelector('[data-gallery]')!;
  const part = (name: string) => root.querySelector(`[data-gallery-${name}]`) as HTMLElement;
  const titles = () => Array.from(root.querySelectorAll('[data-gallery-list] h3')).map(title => title.textContent);
  return { root, part, titles };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('the thumbnail', () => {
  it('draws the shelves, then owned and printed centrelines in the published view box', () => {
    const svg: SVGSVGElement = thumbnailSvg(THUMBNAIL);
    expect(svg.getAttribute('viewBox')).toBe('0 -600 1200 600');
    const shelf = svg.querySelector('rect')!;
    expect(['x', 'y', 'width', 'height'].map(name => shelf.getAttribute(name))).toEqual(['100', '-500', '400', '200']);
    const lines = Array.from(svg.querySelectorAll('polyline'));
    expect(lines.map(line => [line.getAttribute('class'), line.getAttribute('points')])).toEqual([
      ['gallery-thumb-owned', '0 0 600 0 1200 -300'], ['gallery-thumb-printed', '0 0 0 -500']]);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('is an empty frame for a layout published without one', () => {
    const svg: SVGSVGElement = thumbnailSvg(null);
    expect(svg.getAttribute('viewBox')).toBe('0 0 1 1');
    expect(svg.children).toHaveLength(0);
  });
});

describe('a card', () => {
  it('credits the author, the remixed layout and its author, and opens the layout in the app', () => {
    const card: HTMLLIElement = layoutCard(layout({ title: 'Harbour loop with yard', author: 'Bob', pieces: 1,
      remixOf: { id: 'x', title: 'Harbour loop', author: 'Ada', licence: 'CC-BY-4.0' }, description: 'Two stations.' }), '/app/');
    expect(card.querySelector('h3')!.textContent).toBe('Harbour loop with yard');
    expect(card.textContent).toContain('by Bob');
    expect(card.textContent).toContain('1 piece');
    expect(card.textContent).not.toContain('1 pieces');
    expect(card.textContent).toContain('Remix of “Harbour loop” by Ada');
    expect(card.textContent).toContain('Two stations.');
    expect(card.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-09T12:00:00Z');
    expect(card.querySelector('time')!.textContent).toBe('9 Oct 2026');
    const open = Array.from(card.querySelectorAll('a')).find(link => link.textContent === 'Open in Plateway')!;
    expect(open.getAttribute('href')).toBe(`/app/#gallery=${card.id.slice('layout-'.length)}`);
  });

  it('shows member text as text, never markup', () => {
    const card: HTMLLIElement = layoutCard(layout({ title: '<img src=x onerror=alert(1)>', author: '<b>Eve</b>', description: '<script>x</script>' }), '/app/');
    expect(card.querySelector('img, b, script')).toBeNull();
    expect(card.querySelector('h3')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('says nothing about a remix when the layout is an original', () => {
    expect(layoutCard(layout(), '/app/').textContent).not.toContain('Remix of');
  });
});

describe('the gallery page', () => {
  it('lists the first page anonymously, then the next page from its cursor until there is none', async () => {
    const first = [layout({ title: 'Newest' }), layout({ title: 'Older' })], second = [layout({ title: 'Oldest' })];
    const { fetcher, state } = service({ '': { layouts: first, next: '1800000000:abc' }, '1800000000:abc': { layouts: second, next: null } });
    const { root, part, titles } = galleryPage();
    const gallery = mountGallery(root, { appUrl: '/app/', fetcher });
    await gallery.settled;
    expect(titles()).toEqual(['Newest', 'Older']);
    expect(shown(part('status'))).toBe(false);
    expect(shown(part('more'))).toBe(true);
    expect(state.calls[0].url).toBe('/api/gallery');
    expect(state.calls[0].init?.credentials).toBe('omit');

    part('more').click();
    await gallery.settled;
    expect(state.calls[1].url).toBe('/api/gallery?before=1800000000%3Aabc');
    expect(titles()).toEqual(['Newest', 'Older', 'Oldest']);
    expect(shown(part('more'))).toBe(false);
  });

  it('marks the card a landing thumbnail linked to, once its page has loaded', async () => {
    const wanted = layout({ title: 'Wanted' });
    const { fetcher } = service({ '': { layouts: [layout(), wanted], next: null } });
    const { root } = galleryPage();
    const gallery = mountGallery(root, { appUrl: '/app/', fetcher, hash: `#layout-${wanted.id}` });
    await gallery.settled;
    expect(Array.from(root.querySelectorAll('.is-target h3')).map(title => title.textContent)).toEqual(['Wanted']);
  });

  it('says the gallery is empty when nothing is published', async () => {
    const { fetcher } = service({ '': { layouts: [], next: null } });
    const { root, part, titles } = galleryPage();
    const gallery = mountGallery(root, { appUrl: '/app/', fetcher });
    await gallery.settled;
    expect(titles()).toEqual([]);
    expect(shown(part('empty'))).toBe(true);
    expect(shown(part('more'))).toBe(false);
    expect(shown(part('error'))).toBe(false);
  });

  it('reports a failed load and tries the same page again', async () => {
    const { fetcher, state } = service({ '': { layouts: [layout({ title: 'Back again' })], next: null } });
    state.down = true;
    const { root, part, titles } = galleryPage();
    const gallery = mountGallery(root, { appUrl: '/app/', fetcher });
    await gallery.settled;
    expect(shown(part('error'))).toBe(true);
    expect(part('error-text').textContent).toContain('Could not load the gallery');
    expect(shown(part('empty'))).toBe(false);

    state.down = false;
    part('retry').click();
    await gallery.settled;
    expect(titles()).toEqual(['Back again']);
    expect(shown(part('error'))).toBe(false);
  });

  it('keeps the cards it has when a later page fails, and offers that page again', async () => {
    const { fetcher, state } = service({ '': { layouts: [layout({ title: 'First' })], next: 'c1:x' }, 'c1:x': { layouts: [layout({ title: 'Second' })], next: null } });
    const { root, part, titles } = galleryPage();
    const gallery = mountGallery(root, { appUrl: '/app/', fetcher });
    await gallery.settled;
    state.down = true;
    part('more').click();
    await gallery.settled;
    expect(titles()).toEqual(['First']);
    expect(shown(part('error'))).toBe(true);
    state.down = false;
    part('retry').click();
    await gallery.settled;
    expect(titles()).toEqual(['First', 'Second']);
    expect(state.calls.at(-1)!.url).toBe('/api/gallery?before=c1%3Ax');
  });
});

describe('the landing strip', () => {
  function strip() {
    document.body.innerHTML = '<div data-gallery-strip-wrap><ul data-gallery-strip><li></li><li></li></ul><p data-gallery-strip-empty hidden></p></div>';
    return document.querySelector('[data-gallery-strip-wrap]')!;
  }

  it('shows the newest six thumbnails, each linking to its card on the gallery page', async () => {
    const layouts = Array.from({ length: 8 }, () => layout());
    const { fetcher } = service({ '': { layouts, next: null } });
    const root = strip();
    await mountStrip(root, { fetcher, count: 6 });
    const links = Array.from(root.querySelectorAll('[data-gallery-strip] a'));
    expect(links.map(link => link.getAttribute('href'))).toEqual(layouts.slice(0, 6).map(item => `gallery.html#layout-${item.id}`));
    expect(links[0].getAttribute('aria-label')).toBe(`${layouts[0].title} by Ada`);
    expect(links.every(link => link.querySelector('svg'))).toBe(true);
  });

  it('invites the first layout when the gallery is empty, and steps aside when it cannot load', async () => {
    const empty = strip();
    await mountStrip(empty, { fetcher: service({ '': { layouts: [], next: null } }).fetcher, count: 6 });
    expect(shown(empty.querySelector('[data-gallery-strip-empty]'))).toBe(true);
    expect(shown(empty.querySelector('[data-gallery-strip]'))).toBe(false);

    const failing = service({});
    failing.state.down = true;
    const down = strip();
    await mountStrip(down, { fetcher: failing.fetcher, count: 6 });
    expect((down as HTMLElement).hidden).toBe(true);
  });
});
