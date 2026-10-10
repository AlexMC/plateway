"""Validate the built train catalogue and print the measurement table.

  uv run --with numpy python scripts/trains/validate.py [--out /tmp/trains/validation.txt]

Checks every car: wheels land on z = 0 (each axle's tread contact, from build_report.json),
wheelsets centred on y = 0, width plausibility (brick trains are 6-7 studs, 48-56 mm, plus
handrails/steps; > 80 mm is flagged), couplers outside the outer bogie pivots, triangle and byte
budgets, total asset size. Then spot-checks measured LDraw geometry against primary sources.
Exit status 1 if any hard check fails; known modelling quirks are listed as notes.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from glb import glb_triangles  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
TRAINS = REPO / 'public' / 'trains'
DATA = Path(os.environ.get('TRAIN_DATA_DIR', '/tmp/train-data'))
CONTACT_TOL = 1.5    # mm: wheel tread above/below the railhead plane
LATERAL_TOL = 1.0    # mm: wheelset centre off the centreline (straight track)
MAX_WIDTH = 80.0     # mm

# Cars whose OMR model is posed off the straight-and-level (documented, not errors).
KNOWN = {
    '6399-1': 'monorail: the rear coach rests on the motor unit, which lies beyond its coupler face',
    '6990-1': 'monorail: the rear coach rests on the motor unit; OMR model stands on the monorail ramp transition: axle contacts differ by up to ~3 mm',
    '6991-1': 'monorail: the rear coach rests on the motor unit; OMR model stands on a curve, wheelsets sit off the chord',
    '7817-1': 'OMR model has the crane slewed across the wagon and its outriggers down (working pose)',
    '10233-1': 'articulated coaches: Coach 2 rests on Coach 1\'s rear bogie, which lies beyond its coupler face',
    '10170-1': 'articulated double-stack car: three bogies, the middle one shared by both halves',
}


def main() -> int:
    index = json.loads((TRAINS / 'index.json').read_text())
    report = {r['car']: r for r in json.loads((DATA / 'build_report.json').read_text())}
    rows, problems, notes = [], [], []
    total = 0
    header = (f"{'set':9s} {'car':44s} {'kind':7s} {'power':8s} {'len':>6s} {'wid':>5s} {'hgt':>5s} {'wb':>6s} "
              f"{'cpl rear':>8s} {'cpl front':>9s} {'tris':>6s} {'KB':>5s}")
    rows.append(header)
    rows.append('-' * len(header))
    for s in index['sets']:
        for c in s['cars']:
            path = REPO / 'public' / c['asset']
            size = path.stat().st_size
            total += size
            tris = glb_triangles(path)
            rows.append(f"{s['id']:9s} {c['id'].split('/', 1)[1][:44]:44s} {c['kind']:7s} {s['power']:8s} {c['length']:6.1f} "
                        f"{c['width']:5.1f} {c['height']:5.1f} {c['wheelbase']:6.1f} {c['couplers']['rear']:8.1f} "
                        f"{c['couplers']['front']:9.1f} {len(tris):6d} {size / 1024:5.0f}")
            known = KNOWN.get(s['id'])
            r = report.get(c['id'])
            issues = []
            if r is None:
                issues.append('no build report')
            else:
                worst = max(abs(x) for x in r['contacts'])
                if worst > CONTACT_TOL:
                    issues.append(f'wheel contact {worst:.2f} mm off z=0')
                lateral = max(abs(y) for y in r['wheel_y'])
                if lateral > LATERAL_TOL:
                    issues.append(f'wheelset {lateral:.2f} mm off y=0')
            if c['width'] > MAX_WIDTH:
                issues.append(f'width {c["width"]} mm > {MAX_WIDTH}')
            if not (c['couplers']['front'] > c['bogies'][-1] and c['couplers']['rear'] < c['bogies'][0]):
                issues.append('coupler inside the outer bogies')
            if len(tris) > 12000 or size > 250_000 or len(tris) != c['triangles'] or size != c['bytes']:
                issues.append('asset budget / bookkeeping')
            for msg in issues:
                (notes if known else problems).append(f"{c['id']}: {msg}" + (f' [{known}]' if known else ''))
    rows.append('')
    rows.append(f"{len(index['sets'])} sets, {sum(len(s['cars']) for s in index['sets'])} cars, "
                f"assets {total / 1e6:.2f} MB")
    rows += ['', 'Spot checks (LDraw geometry vs primary source):'] + spot_checks()
    rows += ['', 'Notes (known model poses):'] + (notes or ['none'])
    rows += ['', 'Problems:'] + (problems or ['none'])
    text = '\n'.join(rows)
    print(text)
    if '--out' in sys.argv:
        out = Path(sys.argv[sys.argv.index('--out') + 1])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + '\n')
    return 1 if problems else 0


def spot_checks() -> list[str]:
    """Three measurements against primary sources (official element names; the app's track profile)."""
    from ldraw import LDU, Library

    lib = Library(DATA / 'lib' / 'ldraw')
    out = []

    def bounds(name):
        t, _ = lib.flatten_part(name)
        v = t.reshape(-1, 3)
        return v.min(0), v.max(0)

    # 1. Wheel: element 4496343 (design 57878) is named "TRAIN WHEEL Ø16.6/Ø23" (tread / flange).
    lo, hi = bounds('57878.dat')
    from vehicles import WHEELS
    tread, flange = 2 * WHEELS['57878.dat'] * LDU, (hi[0] - lo[0]) * LDU
    out.append(f"  57878 wheel: LDraw tread Ø{tread:.1f} mm, flange Ø{flange:.1f} mm vs element name "
               f"Ø16.6/Ø23 -> {'OK' if abs(tread - 16.6) <= 0.3 and abs(flange - 23) <= 0.3 else 'MISMATCH'}")
    # 2. Chassis: element 6x28 (design 92339) is named "CHASSIS 6X28X6.4" (studs x studs x mm).
    lo, hi = bounds('92339.dat')
    length, width = (hi[0] - lo[0]) * LDU, (hi[2] - lo[2]) * LDU
    out.append(f"  92339 chassis: LDraw {length:.1f} x {width:.1f} mm vs element 'CHASSIS 6X28' = 28 x 6 studs "
               f"(224 x 48 mm at 8 mm/stud) -> {'OK' if abs(length - 224) <= 0.5 and abs(width - 48) <= 0.5 else 'MISMATCH'}")
    # 3. Gauge: wheel tread centres of a 9V wheelset vs the rail centre spacing of the app's brick track
    #    profile (cad/profiles/brick-v1.json railGauge, from L-Gauge/LDraw track geometry).
    profile = json.loads((REPO / 'cad' / 'profiles' / 'brick-v1.json').read_text())
    rail = float(profile['railGauge'])
    t, _ = lib.flatten_part('2879.dat')
    v = t.reshape(-1, 3)
    r = np.hypot(v[:, 0], v[:, 1])
    tread_z = v[(r > 20) & (r < 22), 2]
    tread_mid = (tread_z.min() + tread_z.max()) / 2   # local z of the tread band's middle
    # 70720c01 puts the wheels at x = +/-50 with their local +z (flange side) pointing inward.
    spacing = 2 * (50 - tread_mid) * LDU
    out.append(f"  9V wheelset (70720c01): tread centres {spacing:.1f} mm apart vs rail centres {rail:.1f} mm "
               f"-> {'OK' if abs(spacing - rail) <= 1.0 else 'MISMATCH'}")
    return out


if __name__ == '__main__':
    sys.exit(main())
