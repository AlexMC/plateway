/**
 * library.html: every live item of the community library as a card with its 3D preview, filtered by kind. The hash
 * picks a kind (#piece, #train, #furniture) or points at one item (#community_…, from the landing strip).
 */
import { KINDS, formatSize, itemFolderUrl, kindOf, licence } from './library-data.js';
import { loadIndex, previewBox, warmPreviews } from './library-cards.js';

const grid = document.querySelector('[data-library-grid]');
const count = document.querySelector('[data-library-count]');
const filters = document.querySelector('[data-library-filters]');
const state = document.querySelector('[data-library-state]');
const appUrl = document.documentElement.dataset.appUrl;
let items = [];
let kind = 'all';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(href, text, className) {
  const anchor = element('a', className, text);
  anchor.href = href;
  return anchor;
}

function card(item, indexUrl) {
  const li = element('li', 'lib-card');
  li.id = item.id;
  li.dataset.kind = item.kind;
  const size = element('p', 'lib-size');
  const known = item.kind === 'train' && item.train?.car;
  if (known) size.textContent = formatSize([known.length, known.width, known.height]);
  li.append(previewBox(item, indexUrl, { spin: 'button', onSize: value => { size.textContent = formatSize(value); } }));

  const body = element('div', 'lib-card-body');
  body.append(element('p', 'lib-tag', kindOf(item).singular), element('h2', 'lib-name', item.name), size);
  body.append(element('p', 'lib-credit', `by ${item.credit}`));
  const { label, url } = licence(item.licence), source = item.piece?.source ?? item.train?.source;
  const links = element('p', 'lib-links');
  links.append(url ? link(url, label) : element('span', '', label), link(itemFolderUrl(item), 'On GitHub'));
  if (typeof source?.url === 'string' && /^https:\/\//.test(source.url)) links.append(link(source.url, 'Original model'));
  body.append(links, link(appUrl, 'Use it in Plateway', 'btn btn-ghost btn-small lib-use'));
  li.append(body);
  return li;
}

function showState(title, text, { retry = false, contribute = false } = {}) {
  state.hidden = false;
  state.querySelector('[data-state-title]').textContent = title;
  state.querySelector('[data-state-text]').textContent = text;
  state.querySelector('[data-library-retry]').hidden = !retry;
  state.querySelector('[data-library-contribute]').hidden = !contribute;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function applyFilter() {
  for (const button of filters.querySelectorAll('[data-kind]')) button.setAttribute('aria-pressed', String(button.dataset.kind === kind));
  let shown = 0;
  for (const li of grid.children) {
    li.hidden = kind !== 'all' && li.dataset.kind !== kind;
    if (!li.hidden) shown++;
  }
  const meta = KINDS.find(entry => entry.id === kind);
  count.textContent = !items.length ? '' : kind === 'all' ? `Showing all ${plural(items.length, 'item', 'items')}`
    : `Showing ${plural(shown, meta.one, meta.many)} of ${plural(items.length, 'item', 'items')}`;
  state.hidden = true;
  if (!items.length) showState('The library is empty for now', 'Be the first to add a piece, a train or a piece of furniture.', { contribute: true });
  else if (!shown) showState(`No ${meta.many} yet`, `Nobody has shared ${meta.one === 'furniture' ? 'any furniture' : `a ${meta.one}`} yet. Yours could be the first.`, { contribute: true });
}

function setKind(next, { push = true } = {}) {
  kind = KINDS.some(entry => entry.id === next) ? next : 'all';
  if (push) history.replaceState(null, '', kind === 'all' ? location.pathname : `#${kind}`);
  applyFilter();
}

function followHash() {
  const target = decodeURIComponent(location.hash.slice(1));
  if (KINDS.some(entry => entry.id === target)) return setKind(target, { push: false });
  setKind('all', { push: false });
  const li = target ? document.getElementById(target) : null;
  if (li?.classList.contains('lib-card')) {
    li.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    li.classList.add('is-target');
  }
}

async function load() {
  state.hidden = true;
  count.textContent = 'Loading the library…';
  try {
    const index = await loadIndex();
    items = index.items;
    grid.replaceChildren(...items.map(item => card(item, index.indexUrl)));
    for (const button of filters.querySelectorAll('[data-kind]')) {
      const n = button.dataset.kind === 'all' ? items.length : items.filter(item => item.kind === button.dataset.kind).length;
      button.querySelector('[data-count]').textContent = String(n);
    }
    followHash();
  } catch (error) {
    console.warn('Library not loaded:', error);
    items = [];
    grid.replaceChildren();
    count.textContent = '';
    showState("The library didn't load", 'Check your connection and try again, or browse the items on GitHub.', { retry: true });
  }
}

filters.addEventListener('click', event => {
  const button = event.target.closest('[data-kind]');
  if (button) setKind(button.dataset.kind);
});
state.querySelector('[data-library-retry]').addEventListener('click', load);
addEventListener('hashchange', followHash);
warmPreviews();
load();
