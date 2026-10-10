"""Procedural LDraw model of the 60052 Cargo Train (2014, infrared).

There is no LDraw model of 60052 in the LDraw OMR (full set list checked) and no openly licensed
one elsewhere (GitHub code search, LDraw forums, Eurobricks threads), so this script assembles one:
real LDraw library parts for everything that sets the catalogue measurements (chassis, bogies,
wheels, IR motor, magnetic buffer beams) and plain boxes/cylinders for the superstructure.
The catalogue marks the set source.kind = "procedural" with the evidence string below.

Writes /tmp/train-data/procedural/60052-1.mpd and procedural.json; build.py picks both up.
LDraw frame: x along the car (front +x), y down, z across; LDU (0.4 mm); rail top at y = 0.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path

DATA = Path(os.environ.get('TRAIN_DATA_DIR', '/tmp/train-data'))

# LDraw colour codes
BLACK, BLUE, WHITE, YELLOW, ORANGE, LBG, DBG, GREEN, RED, BROWN, TAN, GLASS = 0, 1, 15, 14, 25, 71, 72, 10, 4, 70, 19, 43

I3 = (1, 0, 0, 0, 1, 0, 0, 0, 1)
TURN = (0, 0, 1, 0, 1, 0, -1, 0, 0)      # local x -> -z (across), local z -> +x (along)
TURN_BACK = (0, 0, -1, 0, 1, 0, 1, 0, 0)  # local x -> +z, local z -> -x
HALF = (-1, 0, 0, 0, 1, 0, 0, 0, -1)      # 180 degrees about y

# Heights (LDU, y down, rail top 0). Wheel centre = -tread radius; the 2878 wheel holder top sits
# 34 LDU above its axle (LDraw 2878c02), the 18626 bogie plate is 8 LDU thick, the chassis bottom
# rests on it; 92339/92088 are 16 LDU deep including the underside ribs.
HOLDER_TOP = -(21 + 34)          # 57878 tread radius 21
BOGIE_PLATE = HOLDER_TOP - 8
CHASSIS = BOGIE_PLATE - 16       # chassis origin (top surface)
BEAM_Y = BOGIE_PLATE + 1         # buffer beam top just under the chassis

EVIDENCE = (
    "No LDraw model of 60052 exists in the LDraw Official Model Repository (all 1470 OMR sets listed via "
    "library.ldraw.org/omr/sets, Oct 2026) or as an openly licensed file elsewhere (GitHub code search, LDraw forums, "
    "Eurobricks). This is a procedural model, not a measured one. Real LDraw library parts set the running gear: "
    "chassis parts from the set's element inventory for 60052 (Brickset inventory: 2x 92339 Train Base 6x28 for the "
    "locomotive and fuel wagon, 1x 92088 Train Base 6x24 for the cable drum wagon; the cattle wagon is built on "
    "2x14/6x plates, modelled as 14 studs), 87574 infrared train motor with its wheels (55423 stands in for "
    "element 57999), 57878 wheels on 4x6 bogie plates (18626) with 2878 holders, 50254 small train wheels on the cattle "
    "wagon, magnetic buffer beams 29084 at every end (29082 has no LDraw part). Bogie pivots sit in the centre hole of "
    "each chassis' 3-hole group (92339 +/-72 mm, 92088 +/-56 mm; +/-8 mm uncertainty), bogie axle spacing 24 mm and the "
    "cattle wagon axles are estimates read from the building instructions (lego.com 6124197, 6124199, 6124203, "
    "6201476, 6201479, 6201485). Body heights follow the official product page (lego.com, 2018): locomotive 3 in high, "
    "11 in long, 2 in wide; fuel wagon 3 x 9 x 2 in; cable drum wagon 3 x 8 x 2 in; cattle wagon 2 in high, 5 in long. Lengths "
    "come from the chassis parts plus buffer beams (the locomotive measures 23.6 cm over couplers against the "
    "product page's rounded 11 in). Cab, hood, tank, drums and cage are boxes and cylinders sized from the instructions: estimates."
)


def ref(colour: int, x: float, y: float, z: float, m: tuple, part: str) -> str:
    return f"1 {colour} {x:g} {y:g} {z:g} {' '.join(f'{v:g}' for v in m)} {part}"


def box(colour: int, x0, x1, y0, y1, z0, z1) -> list[str]:
    p = [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return ['4 %d %s' % (colour, ' '.join('%g %g %g' % p[i] for i in f)) for f in faces]


def cylinder(colour: int, axis: str, centre: tuple, radius: float, half: float, n: int = 20) -> list[str]:
    """Closed cylinder along 'x' or 'z'."""
    cx, cy, cz = centre
    out = []
    ring = [(radius * math.cos(2 * math.pi * k / n), radius * math.sin(2 * math.pi * k / n)) for k in range(n)]

    def pt(a, u, v):
        return (cx + a, cy + u, cz + v) if axis == 'x' else (cx + v, cy + u, cz + a)
    for k in range(n):
        (u0, v0), (u1, v1) = ring[k], ring[(k + 1) % n]
        quad = [pt(-half, u0, v0), pt(half, u0, v0), pt(half, u1, v1), pt(-half, u1, v1)]
        out.append('4 %d %s' % (colour, ' '.join('%g %g %g' % q for q in quad)))
        for a in (-half, half):
            tri = [pt(a, 0, 0), pt(a, u0, v0), pt(a, u1, v1)]
            out.append('3 %d %s' % (colour, ' '.join('%g %g %g' % q for q in tri)))
    return out


def bogie(x: float) -> list[str]:
    """4x6 bogie plate (pin up into the chassis hole) over two 57878 wheelsets, axles 60 LDU apart."""
    return [ref(14, x, BOGIE_PLATE, 0, TURN, '18626.dat'),
            ref(0, x - 30, HOLDER_TOP, 0, TURN, '2878c02.dat'),
            ref(0, x + 30, HOLDER_TOP, 0, TURN, '2878c02.dat')]


def buffers(end: float, colour: int = 0) -> list[str]:
    """29084 buffer beams under each chassis end: the beam face (55 LDU ahead of the part origin) flush
    with the chassis end, so the sealed magnet stands 15 LDU (6 mm) proud of it."""
    return [ref(colour, end - 55, BEAM_Y, 0, TURN_BACK, '29084.dat'),
            ref(colour, -end + 55, BEAM_Y, 0, TURN, '29084.dat')]


def locomotive() -> list[str]:
    tread = 22.9  # 55423 rubber ring
    motor_y = -(tread + 42)  # 87574 axles 42 LDU below its top
    lines = [ref(BLUE, 0, CHASSIS, 0, I3, '92339.dat'),
             ref(0, 180, motor_y, 0, TURN, '87574.dat')]
    for ax in (120, 240):
        lines += [ref(0, ax, -tread, 50, HALF, '55423.dat'), ref(0, ax, -tread, -50, I3, '55423.dat')]
    lines += bogie(-180) + buffers(280)
    deck = CHASSIS
    lines += box(DBG, -110, 110, deck + 16, deck + 40, -40, 40)             # fuel tank between the bogies
    lines += box(BLUE, -262, 128, deck - 96, deck, -40, 40)                 # long hood, 4 wide
    lines += box(ORANGE, -262, 128, deck - 58, deck - 46, -41, 41)          # hood stripe
    lines += box(BLACK, -258, 124, deck - 102, deck - 96, -36, 36)          # hood top
    lines += box(BLUE, 128, 262, deck - 104, deck, -60, 60)                 # cab, 6 wide
    lines += box(GLASS, 150, 240, deck - 92, deck - 60, -61, 61)            # cab side windows
    lines += box(GLASS, 262, 264, deck - 92, deck - 56, -50, 50)            # windscreen
    lines += box(BLACK, 124, 266, deck - 112, deck - 104, -62, 62)          # cab roof
    for z in (-58, 58):                                                     # walkway hand rails
        lines += box(BLACK, -270, 124, deck - 34, deck - 30, z - 2, z + 2)
    lines += box(YELLOW, 266, 270, deck - 8, deck, -50, 50)                 # front step edge
    return lines


def fuel_wagon() -> list[str]:
    lines = [ref(BLUE, 0, CHASSIS, 0, I3, '92339.dat')] + bogie(-180) + bogie(180) + buffers(280)
    deck = CHASSIS
    for x in (-150, 150):
        lines += box(DBG, x - 20, x + 20, deck - 22, deck, -46, 46)         # saddles
    lines += cylinder(WHITE, 'x', (0, deck - 62, 0), 56, 240)               # tank
    lines += box(BLUE, -40, 40, deck - 122, deck - 112, -20, 20)            # dome
    for end in (-272, 272):
        lines += box(YELLOW, end - 4, end + 4, deck - 48, deck, -56, 56)    # end platforms
    return lines


def cable_drum_wagon() -> list[str]:
    lines = [ref(0, 0, CHASSIS, 0, I3, '92088.dat')] + bogie(-140) + bogie(140) + buffers(240)
    deck = CHASSIS
    for end in (-225, 225):
        lines.append(ref(YELLOW, end, deck - 8, 0, TURN, '6583.dat'))       # wagon end hand rails
    for x in (-105, 105):
        lines += box(BLACK, x - 30, x + 30, deck - 16, deck, -44, 44)       # drum cradles
        lines += cylinder(GREEN, 'z', (x, deck - 58, 0), 56, 36)            # cable drums
        lines += cylinder(BLACK, 'z', (x, deck - 58, 0), 20, 40)            # drum hubs
    return lines


def cattle_wagon() -> list[str]:
    small = 10  # 50254 tread radius
    deck = -46
    lines = box(DBG, -140, 140, deck, deck + 8, -60, 60)                    # 6 x 14 deck
    for ax in (-100, -60, 60, 100):
        lines += box(BLACK, ax - 20, ax + 20, deck + 8, -small - 4, -20, 20)  # 2x2 wheel holders
        lines += [ref(0, ax, -small, 46, HALF, '50254.dat'), ref(0, ax, -small, -46, I3, '50254.dat')]
    lines += buffers(140)
    top = -127                                                              # 2 in above the rail
    for z in (-58, 58):
        lines += box(LBG, -132, 132, top, top + 6, z - 2, z + 2)            # top rails
        for x in range(-130, 131, 20):
            lines += box(LBG, x - 2, x + 2, top, deck, z - 2, z + 2)        # lattice bars
        for y in (top + 30, top + 55):
            lines += box(LBG, -132, 132, y, y + 3, z - 2, z + 2)
    for x in (-136, 136):
        lines += box(LBG, x - 3, x + 3, top, deck, -60, 60)                 # end walls
    for x in (-70, 0, 70):
        lines += box(BROWN, x - 30, x + 30, deck - 40, deck - 10, -14, 14)  # cows
        lines += box(BROWN, x + 30, x + 42, deck - 46, deck - 30, -9, 9)
    return lines


def main() -> None:
    out = DATA / 'procedural'
    out.mkdir(parents=True, exist_ok=True)
    cars = [('60052 - locomotive.ldr', locomotive(), 0),
            ('60052 - cable drum wagon.ldr', cable_drum_wagon(), -260 - 20 - 240 - 20),
            ('60052 - fuel wagon.ldr', fuel_wagon(), -260 - 20 - 480 - 40 - 280 - 20),
            ('60052 - cattle wagon.ldr', cattle_wagon(), -260 - 20 - 480 - 40 - 560 - 40 - 140 - 20)]
    header = ['0 Author: train-layout-workshop scripts/trains/procedural_60052.py (procedural, not an OMR model)',
              '0 !LICENSE Procedural geometry; LDraw parts from the LDraw library (CC BY 4.0 / CCAL 2.0)']
    lines = ['0 FILE 60052 - main.ldr', '0 60052 Cargo Train (procedural)', '0 Name: 60052 - main.ldr', *header]
    lines += [ref(16, offset, 0, 0, I3, name) for name, _, offset in cars]
    for name, body, _ in cars:
        lines += ['', f'0 FILE {name}', f'0 {name[8:-4]}', f'0 Name: {name}', *header, *body]
    (out / '60052-1.mpd').write_text('\n'.join(lines) + '\n')
    (out / 'procedural.json').write_text(json.dumps([{
        'id': '60052-1', 'name': 'Cargo Train', 'year': 2014, 'theme': 'City > Trains', 'file': '60052-1.mpd',
        'url': 'https://www.lego.com/en-us/service/building-instructions/60052', 'evidence': EVIDENCE}], indent=1))
    print(out / '60052-1.mpd')


if __name__ == '__main__':
    main()
