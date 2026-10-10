"""One package from a layout prepared in parts (R11, AE2): the combine step of a parent job (`jobs.py`), run by
`prepare_job.py` once every part's package is built.

Each part's package (`export_package(part=…)`) holds the whole manifest, so part codes are the whole layout's
already, but its plates start at 1. The combined package, named as the whole layout's package would be:
- numbers the plates on across the parts, in part order: part 2's plate 1 follows part 1's last plate, and so on,
  renaming each plate's folder and plain 3MF (titled by its plate number) to match;
- holds every part's plates, Bambu projects, G-code, print STLs and CAD sources (a source two parts share, once
  when it is byte for byte the same);
- has one markdown and one PDF guide, drawn from the combined receipt, so one shopping list and one overview for the
  whole layout, plus a list of the parts with their plates and pieces (`layoutParts`);
- has one receipt. The part packages stay until `prepare_job` has recorded it, so a combine interrupted before then
  (a worker restart) runs again from them, publishing the combined package it already installed (or, once that is
  published, recording it).
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Collection
import filecmp
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import zipfile

from cad.service.package import (fresh_name, guide_markdown, guide_pdf_bytes, receipt_notes, safe_file, staged_package,
                                 validate_manifest, variants, write_exclusive)
from cad.service.plates import Progress

PLATE_FOLDER = re.compile(r'plate-(\d+)\Z')
# Each part's own guide and layout data; the combined package writes its own.
REPLACED = {'receipt.json', 'manifest.json', 'assembly-guide.md', 'assembly-guide.pdf'}
PATHS = ('printMesh', 'mesh', 'source', 'request', 'step')
PLATE_PATHS = ('model', 'project', 'gcode', 'thumbnail', 'processOverride')


def _part_receipt(root: Path, package_id: str, index: int, count: int, manifest: dict) -> dict:
    fd, _ = safe_file(root, package_id, 'receipt.json')
    with os.fdopen(fd, 'r', encoding='utf-8') as source:
        receipt = json.load(source)
    part = receipt.get('part')
    if (receipt.get('id') != package_id or receipt.get('status') != 'prepared-digital-only' or
            not isinstance(part, dict) or part.get('index') != index or part.get('count') != count or
            receipt.get('printer') != manifest['printer'] or
            receipt.get('layoutRevision') != manifest['project']['layoutRevision']):
        raise ValueError(f'{package_id} is not part {index} of {count} of this layout')
    if [plate['plate'] for plate in receipt['plates']] != list(range(1, len(receipt['plates']) + 1)):
        raise ValueError(f'The plates of {package_id} are not numbered from 1')
    return receipt


def _installed(root: Path, base: str, manifest: dict, receipts: list[dict]) -> dict | None:
    """The receipt of a combined package of these parts already installed here, if any. Publishing removes the folder,
    so one still here is from a combine whose publish was interrupted; its job runs it again."""
    split = [receipt['part']['instanceIds'] for receipt in receipts]
    for name in sorted(variants(os.listdir(root), base)):
        try:
            loaded = []
            for artefact in ('receipt.json', 'manifest.json'):
                fd, _ = safe_file(root, name, artefact)
                with os.fdopen(fd, 'r', encoding='utf-8') as source:
                    loaded.append(json.load(source))
        except (OSError, ValueError):
            continue
        receipt, installed = loaded
        if (isinstance(receipt, dict) and receipt.get('id') == name and isinstance(receipt.get('layoutParts'), list)
                and [part.get('instanceIds') if isinstance(part, dict) else None for part in receipt['layoutParts']]
                == split and installed == manifest):
            return receipt
    return None


def _files(folder: Path) -> list[str]:
    """Every file in a package folder, relative; anything but a regular file or folder is refused."""
    found = []
    for directory, subfolders, names in os.walk(folder):
        for name in subfolders + names:
            path = Path(directory) / name
            mode = path.lstat().st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise ValueError(f'Not a regular file in a package: {path.relative_to(folder)}')
            if stat.S_ISREG(mode):
                found.append(path.relative_to(folder).as_posix())
    return sorted(found)


def _retitle(source: Path, target: Path, old: int, new: int) -> None:
    """A copy of a plain plate 3MF (`plates.write_core_3mf`) titled with its plate's new number."""
    before, after = (f'<metadata name="Title">Plate {number}</metadata>'.encode() for number in (old, new))
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(target, 'x') as renamed:
        for info in original.infolist():
            data = original.read(info)
            if info.filename == '3D/3dmodel.model':
                if data.count(before) != 1:
                    raise ValueError(f'{source.name} is not titled Plate {old}')
                data = data.replace(before, after)
            renamed.writestr(info, data)


def _piece_order(code: str) -> tuple:
    return (code.startswith('S'), int(code.lstrip('S'))) if code.lstrip('S').isdigit() else (True, 1 << 30, code)


def combine_parts(root: Path, manifest: dict, part_packages: list[str], progress: Progress, *,
                  taken: Callable[[str], Collection[str]] = lambda _base: ()) -> dict:
    """Combine the installed part packages `part_packages` (in part order) of `manifest`'s layout into one package
    under the layout's own package id (a variant when that id is in use here or in `taken(base)`); returns its
    receipt. Reports `progress('combine', part, parts)`. The part packages are left for the caller to remove once the
    combined package is published; a combined package of the same parts already installed is returned as it is."""
    base, printed = validate_manifest(manifest)
    count = len(part_packages)
    if count < 2:
        raise ValueError('A layout in parts has at least two parts')
    receipts = [_part_receipt(root, package_id, index, count, manifest)
                for index, package_id in enumerate(part_packages, 1)]
    chosen = [instance for receipt in receipts for instance in receipt['part']['instanceIds']]
    if Counter(chosen) != Counter(instance['id'] for instance in printed):
        raise ValueError('The parts do not hold every printed piece of the layout exactly once')
    installed = _installed(root, base, manifest, receipts)
    if installed is not None:
        return installed
    fingerprint = hashlib.sha256('\n'.join(receipt['id'] for receipt in receipts).encode()).hexdigest
    name = fresh_name(base, variants(os.listdir(root), base) | variants(taken(base), base), fingerprint)
    project = manifest['project']
    with staged_package(root, name) as (directory, stage_fd):
        plates, parts, assemblies, layout_parts = [], [], [], []
        for index, (package_id, receipt) in enumerate(zip(part_packages, receipts)):
            progress('combine', index, count)
            offset = len(plates)
            renames = {f'plate-{plate["plate"]:02d}': f'plate-{plate["plate"] + offset:02d}' for plate in receipt['plates']}
            relocated: dict[str, str] = {}

            def moved(relative: str) -> str:
                if relative in relocated:
                    return relocated[relative]
                folder, _, rest = relative.partition('/')
                if folder not in renames or not rest:
                    return relative
                return f'{renames[folder]}/{f"{renames[folder]}.3mf" if rest == f"{folder}.3mf" else rest}'

            source = root / package_id
            for relative in _files(source):
                if relative in REPLACED:
                    continue
                target = directory / moved(relative)
                if target.exists():
                    # CAD sources are named by their recipe digest, so two parts often share one: kept once when
                    # byte for byte the same, else (a STEP file records when it was written) this part keeps its own.
                    if filecmp.cmp(source / relative, target, shallow=False):
                        continue
                    relocated[relative] = f'part-{index + 1}/{moved(relative)}'
                    target = directory / relocated[relative]
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                folder, _, rest = relative.partition('/')
                if folder in renames and rest == f'{folder}.3mf':
                    _retitle(source / relative, target, int(PLATE_FOLDER.fullmatch(folder)[1]),
                             int(PLATE_FOLDER.fullmatch(renames[folder])[1]))
                else:
                    os.link(source / relative, target)  # the part packages are removed once this one is published
            for plate in receipt['plates']:
                plates.append({**plate, 'plate': plate['plate'] + offset,
                               **{key: moved(plate[key]) for key in PLATE_PATHS if isinstance(plate.get(key), str)}})
            for part in receipt['parts']:
                parts.append({**part, 'plate': part['plate'] + offset,
                              **{key: moved(part[key]) for key in PATHS if isinstance(part.get(key), str)},
                              **({'sourceDependencies': [moved(path) for path in part['sourceDependencies']]}
                                 if isinstance(part.get('sourceDependencies'), list) else {}),
                              **({'materials': [{**material, 'mesh': moved(material['mesh'])}
                                                for material in part['materials']]} if part.get('materials') else {})})
            assemblies.extend(receipt.get('assemblies', []))
            layout_parts.append({'index': index + 1, 'plates': [plate['plate'] + offset for plate in receipt['plates']],
                                 'pieces': sorted({part['piece'] for part in receipt['parts']}, key=_piece_order),
                                 'instanceIds': receipt['part']['instanceIds']})
        if (len({part['instanceId'] for part in parts}) != len(parts) or
                len({assembly['instanceId'] for assembly in assemblies}) != len(assemblies) or
                Counter(obj['instanceId'] for plate in plates for obj in plate['objects']) !=
                Counter(part['instanceId'] for part in parts)):
            raise ValueError('The parts’ plates and pieces do not reconcile')
        payload = {'version': 1, 'id': name, 'status': 'prepared-digital-only', 'partRevision': project['revision'],
                   'layoutRevision': project['layoutRevision'], 'printer': manifest['printer'], 'parts': parts,
                   'plates': plates, 'physicalStatus': 'unverified', 'assemblyGuide': 'assembly-guide.md',
                   'assemblyGuidePdf': 'assembly-guide.pdf', 'layoutParts': layout_parts, 'cadSourceCurrent': True,
                   'manifest': 'manifest.json', **({'assemblies': assemblies} if assemblies else {}),
                   **receipt_notes(parts)}
        write_exclusive(stage_fd, 'manifest.json',
                        (json.dumps(manifest, sort_keys=True, indent=2, allow_nan=False) + '\n').encode())
        write_exclusive(stage_fd, 'assembly-guide.md',
                        guide_markdown(manifest, parts, assemblies, layout_parts).encode())
        write_exclusive(stage_fd, 'assembly-guide.pdf', guide_pdf_bytes(
            lambda relative: (directory / relative).read_bytes(), payload, manifest))
        write_exclusive(stage_fd, 'receipt.json',
                        (json.dumps(payload, sort_keys=True, indent=2, allow_nan=False) + '\n').encode())
    return payload
