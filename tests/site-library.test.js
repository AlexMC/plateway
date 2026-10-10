// The public library page and the landing strip (site/library.html, site/js/library-*.js) read index.json with these.
// Plain JS: the site ships its scripts as written, with no build step.
import { describe, expect, it } from 'vitest';
import { countLine, formatSize, itemFileUrl, itemFolderUrl, licence, liveItems, stripItems } from '../site/js/library-data.js';

const item = (id, kind, extra = {}) => ({ id, version: 1, kind, state: 'live', name: id, licence: 'CC-BY-4.0', credit: 'Plateway',
  file: `${kind === 'piece' ? 'pieces' : kind === 'train' ? 'trains' : 'furniture'}/${id}/1/${kind === 'piece' ? 'piece.stl' : 'x.json'}`,
  digest: '0'.repeat(64), ...extra });

describe('library index', () => {
  it('keeps live items of known kinds, in index order, and drops retired, removed and malformed ones', () => {
    const index = { format: 1, items: [
      item('community_a', 'furniture'),
      { ...item('community_b', 'piece'), state: 'retired' },
      { id: 'community_c', version: 2, kind: 'piece', state: 'removed' },
      item('community_d', 'piece'),
      item('community_e', 'boat'),
      { ...item('community_f', 'train'), file: 42 },
      item('community_g', 'train')
    ] };
    expect(liveItems(index).map(entry => entry.id)).toEqual(['community_a', 'community_d', 'community_g']);
  });

  it('refuses an index of another format', () => {
    expect(() => liveItems({ format: 2, items: [] })).toThrow();
    expect(() => liveItems({ format: 1 })).toThrow();
    expect(() => liveItems(null)).toThrow();
  });
});

describe('counts', () => {
  it('names the total and each kind present, furniture uncounted and singulars singular', () => {
    const items = [...['a', 'b', 'c', 'd'].map(id => item(id, 'piece')), ...['e', 'f', 'g', 'h', 'i', 'j'].map(id => item(id, 'furniture'))];
    expect(countLine(items)).toBe('10 items · 4 pieces · 6 furniture');
    expect(countLine([item('a', 'piece'), item('b', 'train')])).toBe('2 items · 1 piece · 1 train');
    expect(countLine([item('a', 'train')])).toBe('1 item · 1 train');
    expect(countLine([])).toBe('0 items');
  });
});

describe('links and files', () => {
  it('links the item version folder on GitHub', () => {
    expect(itemFolderUrl(item('community_station', 'piece')))
      .toBe('https://github.com/AlexMC/plateway-library/tree/main/pieces/community_station/1');
  });

  it("resolves a file against where the index came from, and refuses one outside the index's folder", () => {
    const base = 'https://plateway-library.example/index.json';
    expect(itemFileUrl(item('community_a', 'piece'), base)).toBe('https://plateway-library.example/pieces/community_a/1/piece.stl');
    expect(itemFileUrl({ ...item('x', 'piece'), file: '../secrets.stl' }, 'https://cdn.example/lib/index.json')).toBeNull();
    expect(itemFileUrl({ ...item('x', 'piece'), file: 'https://evil.example/piece.stl' }, base)).toBeNull();
    expect(itemFileUrl({ ...item('x', 'piece'), file: 'pieces/x/1/piece.stl?x=1' }, base)).toBeNull();
  });

  it('spells CC licences out with their deed, and passes anything else through', () => {
    expect(licence('CC-BY-4.0')).toEqual({ label: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' });
    expect(licence('CC-BY-2.0')).toEqual({ label: 'CC BY 2.0', url: 'https://creativecommons.org/licenses/by/2.0/' });
    expect(licence('CC-BY-SA-4.0')).toEqual({ label: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' });
    expect(licence('MIT')).toEqual({ label: 'MIT', url: null });
  });
});

describe('sizes', () => {
  it('rounds to whole millimetres from 100 mm, else to a tenth, dropping a trailing .0', () => {
    expect(formatSize([143.996, 64.02, 9.6])).toBe('144 × 64 × 9.6 mm');
    expect(formatSize([1470, 390, 1465])).toBe('1470 × 390 × 1465 mm');
    expect(formatSize([128, 128, 3.2049])).toBe('128 × 128 × 3.2 mm');
  });
});

describe('landing strip', () => {
  it('alternates kinds in index order, up to the limit, then fills with what is left', () => {
    const items = ['f1', 'f2', 'f3', 'f4'].map(id => item(id, 'furniture'))
      .concat(['p1', 'p2'].map(id => item(id, 'piece')), [item('f5', 'furniture'), item('t1', 'train')]);
    expect(stripItems(items, 6).map(entry => entry.id)).toEqual(['p1', 't1', 'f1', 'p2', 'f2', 'f3']);
    expect(stripItems(items, 20)).toHaveLength(8);
  });
});
