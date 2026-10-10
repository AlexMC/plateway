/**
 * The community library's index.json as the public pages read it (library.html and the landing strip). The format is
 * README "Community library"; the app's own reader is src/domain/library.ts, which also checks digests and registers
 * items. These pages only show live items, so they keep what they can draw and drop the rest.
 */
export const LIBRARY_INDEX_URL = '/api/library/index.json';
export const REPOSITORY = 'https://github.com/AlexMC/plateway-library';
/** Filter order and wording. Furniture is uncounted: "6 furniture". */
export const KINDS = [
  { id: 'piece', label: 'Pieces', singular: 'Piece', one: 'piece', many: 'pieces' },
  { id: 'train', label: 'Trains', singular: 'Train', one: 'train', many: 'trains' },
  { id: 'furniture', label: 'Furniture', singular: 'Furniture', one: 'furniture', many: 'furniture' }
];
const KIND = new Map(KINDS.map(kind => [kind.id, kind]));

/** The index's live items in index order; throws on an index this page can't read. */
export function liveItems(index) {
  if (index?.format !== 1 || !Array.isArray(index.items)) throw new Error('The library index is not format 1.');
  return index.items.filter(item => item?.state === 'live' && KIND.has(item.kind) &&
    [item.id, item.name, item.file, item.credit, item.licence].every(field => typeof field === 'string' && field));
}

/** "10 items · 4 pieces · 6 furniture": the total, then each kind present. */
export function countLine(items) {
  const parts = [`${items.length} ${items.length === 1 ? 'item' : 'items'}`];
  for (const kind of KINDS) {
    const count = items.filter(item => item.kind === kind.id).length;
    if (count) parts.push(`${count} ${count === 1 ? kind.one : kind.many}`);
  }
  return parts.join(' · ');
}

export const kindOf = item => KIND.get(item.kind);

/** The item version's folder in the library repository (its file and metadata.json); the index mirrors its paths. */
export function itemFolderUrl(item) {
  return `${REPOSITORY}/tree/main/${item.file.split('/').slice(0, -1).join('/')}`;
}

/** The item's file, resolved against the index's final URL (after the redirect); null when it would leave its folder. */
export function itemFileUrl(item, indexUrl) {
  const folder = new URL('./', indexUrl), url = new URL(item.file, folder);
  return url.origin !== folder.origin || !url.pathname.startsWith(folder.pathname) || url.search || url.hash ? null : url.href;
}

/** A licence code as a label and, for Creative Commons, its deed. */
export function licence(code) {
  const match = /^CC-(BY(?:-SA|-NC|-ND|-NC-SA|-NC-ND)?)-(\d\.\d)$/.exec(code);
  return match ? { label: `CC ${match[1]} ${match[2]}`, url: `https://creativecommons.org/licenses/${match[1].toLowerCase()}/${match[2]}/` }
    : { label: code, url: null };
}

/** [x, y, z] in mm as "144 × 64 × 9.6 mm": whole millimetres from 100 mm, else tenths. */
export function formatSize(size) {
  return `${size.map(value => String(value >= 100 ? Math.round(value) : Math.round(value * 10) / 10)).join(' × ')} mm`;
}

/** Up to `limit` items for the landing strip: one of each kind in turn (pieces first), each kind in index order. */
export function stripItems(items, limit) {
  const queues = KINDS.map(kind => items.filter(item => item.kind === kind.id)), picked = [];
  while (picked.length < limit && queues.some(queue => queue.length))
    for (const queue of queues) if (queue.length && picked.length < limit) picked.push(queue.shift());
  return picked;
}
