"""Fetch the LDraw data the train catalogue is built from.

Caches everything under /tmp/train-data (override with TRAIN_DATA_DIR):
  pages/p{N}.html      OMR set list pages (Filament table, 25 rows per page, ?page=N)
  omr_sets.json        parsed set list: record id -> number, name, theme, year, models_count
  sets/{rid}.html      per-set pages (/omr/sets/{rid}) listing the model MPDs + authors
  omr_models.json      candidate sets with their model download URLs
  mpd/{file}.mpd       the OMR model files
  lib/ldraw/           the LDraw parts library (complete.zip)

Run: uv run python scripts/trains/fetch.py
"""
from __future__ import annotations

import html
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import certifi

DATA = Path(os.environ.get('TRAIN_DATA_DIR', '/tmp/train-data'))
BASE = 'https://library.ldraw.org'
UA = {'User-Agent': 'train-layout-workshop catalogue builder (LDraw OMR reader)'}

# Themes that can contain rail vehicles. Everything else in the OMR (Star Wars,
# Castle, ...) has no train-track vehicles. Candidates are then confirmed by geometry:
# a model only becomes a catalogue set if it contains train or monorail wheel parts.
CANDIDATE_THEME = re.compile(
    r'^(Train|City > Trains|Factory|Hobby Sets|Town > World City|Creator > Creator Expert|Icons|'
    r'Seasonal|Space > Futuron|Space > Unitron|Town > Classic Town|Town$|Town > Space Port|'
    r'Creator > Creator 3-in-1|Promotional|LEGO Ideas|Harry Potter|Other|Legoland|LEGO Exclusive|'
    r'LEGO Brand Store|Modular Buildings)'
)


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    # certifi's CA bundle: python.org builds on macOS ship without system certificates.
    ctx = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(req, timeout=120, context=ctx) as r:
        return r.read()


def cached(path: Path, url: str) -> bytes:
    if path.exists() and path.stat().st_size > 0:
        return path.read_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = get(url)
    path.write_bytes(data)
    return data


def text(fragment: str) -> str:
    return html.unescape(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', fragment))).strip()


def list_sets() -> dict[str, dict]:
    first = cached(DATA / 'pages' / 'p1.html', f'{BASE}/omr/sets?page=1').decode()
    total = int(re.search(r'([\d,]+)\s*results', text(first)).group(1).replace(',', ''))
    pages = (total + 24) // 25
    with ThreadPoolExecutor(8) as pool:
        bodies = list(pool.map(
            lambda n: cached(DATA / 'pages' / f'p{n}.html', f'{BASE}/omr/sets?page={n}').decode(),
            range(1, pages + 1)))
    rows: dict[str, dict] = {}
    cell = re.compile(r'table\.record\.(\d+)\.column\.(number|name|theme\.name|year|models_count)"(.*?)</td>', re.S)
    for body in bodies:
        for rid, col, frag in cell.findall(body):
            rows.setdefault(rid, {})[col.replace('.name', '')] = text(frag.split('>', 1)[1])
    if len(rows) != total:
        print(f'warning: parsed {len(rows)} sets, list says {total}', file=sys.stderr)
    (DATA / 'omr_sets.json').write_text(json.dumps(rows, indent=1))
    return rows


def set_models(rid: str) -> list[dict]:
    page = cached(DATA / 'sets' / f'{rid}.html', f'{BASE}/omr/sets/{rid}').decode()
    models = []
    blocks = page.split('<div class="flex flex-col rounded border">')[1:]
    for block in blocks:
        name = re.search(r'font-bold bg-gray-200 p-2">\s*(.*?)\s*</div>', block, re.S)
        author = re.search(r'Author:</span>(.*?)</div>', block, re.S)
        url = re.search(r'href="(https://library\.ldraw\.org/library/omr/[^"]+\.mpd)"', block)
        if not url:
            continue
        models.append({'name': text(name.group(1)) if name else '', 'author': text(author.group(1)) if author else '',
                       'url': html.unescape(url.group(1))})
    return models


def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    rows = list_sets()
    cands = {rid: r for rid, r in rows.items() if CANDIDATE_THEME.match(r.get('theme', ''))}
    print(f'{len(rows)} OMR sets, {len(cands)} in candidate themes')
    with ThreadPoolExecutor(8) as pool:
        models = dict(zip(cands, pool.map(set_models, cands)))
    out = []
    for rid, r in cands.items():
        out.append({'rid': rid, **r, 'page': f'{BASE}/omr/sets/{rid}', 'models': models[rid]})
    (DATA / 'omr_models.json').write_text(json.dumps(out, indent=1))
    urls = [m['url'] for s in out for m in s['models']]

    def dl(url: str) -> str | None:
        try:
            cached(DATA / 'mpd' / urllib.request.unquote(url.rsplit('/', 1)[1]), urllib.parse.quote(url, safe=':/'))
        except urllib.error.HTTPError as err:
            return f'{url}: HTTP {err.code}'
        return None

    with ThreadPoolExecutor(8) as pool:
        failures = [f for f in pool.map(dl, urls) if f]
    for f in failures:
        print('missing model file', f, file=sys.stderr)
    print(f'{len(urls) - len(failures)} model files cached')
    lib = DATA / 'lib' / 'ldraw'
    if not (lib / 'parts').is_dir():
        z = DATA / 'complete.zip'
        cached(z, f'{BASE}/library/updates/complete.zip')
        with zipfile.ZipFile(z) as zf:
            zf.extractall(DATA / 'lib')
    print('parts library at', lib)


if __name__ == '__main__':
    main()
