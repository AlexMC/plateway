"""Bought (non-printed) parts: shopping-list categories and the canonical names shared by several mechanisms.

Every hardware row a module returns is ``{"name", "quantity", "category"}``. A part used by more than one
mechanism is named here once, so identical parts add up on the layout's shopping list.
"""
from __future__ import annotations

FASTENERS, MAGNETS, BEARINGS, BRICK, ELECTRONICS, MATERIALS = (
    "fasteners", "magnets", "bearings", "brick", "electronics", "materials")
# Shopping-list order.
CATEGORIES = (FASTENERS, MAGNETS, BEARINGS, BRICK, ELECTRONICS, MATERIALS)

MAGNET = "6 x 3 mm neodymium disc magnet"
DOWEL_3X12 = "3 x 12 mm steel dowel pin"
M3_ST = "M3 x {length} mm self-tapping screw"
M2_HORN_PIN = "M2 x 8 mm screw and nut"
WOOD_SCREW = "Wood screw {size} mm (pan head)"
BEARING_608 = "608 ball bearing (8 x 22 x 7 mm)"
M8_NUT = "M8 nut"
COUNTERWEIGHT = "M8 nuts or steel shot as counterweight (to balance)"

SERVO = "SG90 micro servo (9 g) with its single-arm horn and two M2 ear screws"

FRICTION_PIN = "Friction pin (2780)"
AXLE_TO_SUIT = "Cross axle, length to suit"
AXLE_3 = "Cross axle 3 (4519)"
AXLE_6 = "Cross axle 6 (3706)"
AXLE_12 = "Cross axle 12 (3708)"
HALF_BUSH = "Half bush (4265c)"
WORM_GEAR = "Worm gear (4716)"
GEAR_16 = "Gear 16 tooth (94925)"
GEAR_24 = "Gear 24 tooth (3648)"
BT_L_MOTOR = "Bluetooth L motor (88013)"
BT_M_MOTOR = "Bluetooth M motor (88008)"
# Motors a Bluetooth hub drives (the layout's control list counts them).
BLUETOOTH_MOTORS = frozenset({BT_L_MOTOR, BT_M_MOTOR})
IR_L_MOTOR = "Infrared L motor (88003)"
# Motors an IR receiver drives.
INFRARED_MOTORS = frozenset({IR_L_MOTOR})

GLUE = "CA glue (superglue)"
GRAPHITE = "Graphite powder (dry lubricant)"
MOUNTING_TAPE = "Double-sided mounting tape"
# One pack does a whole layout: the shopping list counts these once, however many pieces use them.
CONSUMABLES = frozenset({GLUE, GRAPHITE, MOUNTING_TAPE})


def row(name: str, quantity: int, category: str) -> dict:
    return {"name": name, "quantity": quantity, "category": category}


def m3_screw(length: int, quantity: int) -> dict:
    """M3 self-tapping screws into a printed 2.6 mm pilot."""
    return row(M3_ST.format(length=length), quantity, FASTENERS)


def wood_screw(size: str, quantity: int) -> dict:
    return row(WOOD_SCREW.format(size=size), quantity, FASTENERS)


def merged(rows: list[dict]) -> list[dict]:
    """Rows with the same name added together, in first-seen order."""
    out: dict[str, dict] = {}
    for item in rows:
        if item["name"] in out:
            out[item["name"]] = {**out[item["name"]], "quantity": out[item["name"]]["quantity"] + item["quantity"]}
        else:
            out[item["name"]] = dict(item)
    return list(out.values())


def with_glue(rows: list[dict]) -> list[dict]:
    """The rows plus CA glue when they include magnets (each is glued into its pocket)."""
    rows = list(rows)
    if any(item["name"] == MAGNET for item in rows) and all(item["name"] != GLUE for item in rows):
        rows.append(row(GLUE, 1, MATERIALS))
    return rows
