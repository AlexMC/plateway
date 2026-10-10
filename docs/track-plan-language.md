# Track plan language (v1)

A track plan is a small JSON file that describes a layout as **tracks of steps** — "a left turnout, four straights,
a 180° R40 curve, then close back to the start". The plan builder (`src/plan/build.ts`) lays it with the editor's own
operations (piece placement and snapping at ports, the Raise and Helix kits, junction settings, owned/printed source,
the gap closer, furniture), checks the result with the same fit and Test drive code the app uses, and reports every
problem as plain text tied to the plan step that caused it.

```sh
npm run plan -- plan.json                      # build and print the report (exit 0 = OK, 1 = problems, 2 = unusable input)
npm run plan -- plan.json --out project.json   # also write the project file
npm run plan -- plan.json --save               # also save it to the running app service (http://localhost:8766): it appears under Open
```

In code: `buildPlan(plan, base?) → { project, report }` and `describeReport(report) → string`. Without `base` the plan
is built into a new standard project (the Setup defaults: a typical starter set of 8 straights and 16 R40 curves, the
example train).

`src/plan/plan.schema.json` is the JSON Schema of this language: the AI layout model must answer with it, and the tests
check every example against it. `parsePlan` stays the authority — it also checks family parameters, states, references
and labels, which the schema cannot.

## Frame and units

- Floor plan in **millimetres**: `x` to the right, `y` up the plan, `z` height above the table.
- **Headings in degrees**: 0 = +x, 90 = +y. A left turn increases the heading.
- **Radii** are written `"R<studs>"` (1 stud = 8 mm: `"R40"` = 320 mm) or as a number of millimetres.
- Straight lengths, ramp rises and heights are millimetres. **S-bend sizes are in studs**, as the palette chips show them.
- A standard brick track straight is 128 mm (16 studs); an R40 curve piece is 22.5°, so 16 make a circle 640 mm across
  (centreline).

## Plan

```jsonc
{
  "version": 1,                 // required
  "name": "Oval with passing loop",
  "description": "An oval with a passing loop and a siding.",   // optional: one plain line (Build's example gallery shows it)
  "prefer": "owned",            // "owned" (default) | "printed" | "fast"
  "furniture": [ { "id": "K1", "kallax": { "x": 1490, "y": 1850, "quarterTurns": 0 } } ],   // optional
  "tracks": [ { "id": "main", "start": { … }, "steps": [ … ] } ]
}
```

Unknown keys are errors (they are usually typos). Ids and labels start with a letter and use letters, digits, `-`
and `_` — no dots, because references are `<label>.<port>`.

### Sources: `prefer` and `source`

- `"owned"`: use the user's own track piece where the shape is a standard one (128 mm straight, R40 22.5° curve,
  left/right turnout, 90° crossing, flex, double crossover) **while the inventory has stock**; the builder counts the
  stock down (minus owned pieces already in a base project) and then lays the printed counterpart, marking it as a
  fallback in the report and the bill. Every other shape is printed.
- `"printed"`: printed, full detail.
- `"fast"`: printed in the fast-print style (rails and connectors only) wherever the family offers it.

Any step can override the plan with `"source": "owned" | "printed" | "fast"`.

### Furniture

`{ "id": "K1", "kallax": { "x": …, "y": …, "quarterTurns": 0..3 } }` places an IKEA KALLAX 5×5 (1820 × 390 mm, 1820 mm
tall) with its **centre** at (x, y), turned by quarter turns anticlockwise. Its **front** is the face towards −y when
`quarterTurns` is 0 (towards +x at 1, +y at 2, −x at 3). The shelf is kept inside the room (Setup room size, default
2400 × 2100 mm); a moved shelf is reported as a warning.

## Tracks

Tracks are built **in order**. Each has an `id`, a `start` and `steps`. The track keeps a *current end* (a position and
heading); every step lays pieces from it and moves it on.

### Starts

| Start | Meaning |
| --- | --- |
| `{ "x": 600, "y": 500, "heading": 0, "z": 0 }` | A free pose. `heading` and `z` default to 0. |
| `{ "from": "A.branch" }` | An **open port** of a labelled piece, or `"<trackId>.start"` / `"<trackId>.end"` of an earlier track. The new track continues out of it. |
| `{ "kallax": "K1", "cubby": [row, col], "side": "front" }` | The floor centre of that cubby's opening on the `front` (default) or `back` face, heading **into** the cubby. Rows and columns are 1..5, counted from the bottom-left **as seen from the front** (on either side). The bottom row's floor is 38 mm up, each row 352.25 mm above the last. |

### References and labels

- `"as": "A"` on a turnout, crossing or `piece` step names that piece; each of its ports becomes `A.<portId>`
  (`A.in`, `A.out`, `A.branch`, …; see the family table for port ids).
- Every track has `<id>.start` (the open end behind its first piece) and, unless it ended on a buffer or a `close`,
  `<id>.end` (its current end after the last step it built — also after a failed step, so a repair can build on it).
- Labels and track ids share one global namespace and must be unique.
- A reference must already exist when it is used, and must still be **open** (not joined to other track).

### Building onto a project

When a plan is built onto an existing project (`buildPlan(plan, base)`, Build's **Describe track** with "Add to my
layout"), what the project already has gets names of its own:

- Its KALLAX shelves are `K1`, `K2`, … in project order: start at their cubbies with `{ "kallax": "K1", … }`. Do not
  list them in `furniture` again (that is an error); `furniture` only adds new shelves.
- Its open track ends are `existing.e1`, `existing.e2`, … with their outward heading: continue out of one with
  `{ "from": "existing.e1" }` or join to one with `{ "close": "existing.e2" }`.

## Steps

Each step has exactly one action key, plus that action's options and an optional `"source"`.

### `straight`

```json
{ "straight": 128, "count": 4 }
```
`count` (default 1) pieces of that length, 24–2000 mm. 128 mm is the owned straight (while in stock); other
lengths print as one any-length straight each.

### `curve`

```json
{ "curve": "R40", "turn": "left", "angle": 90 }
```
Radius R24–R184 (192–1472 mm). The angle is split into the curve family's pieces — 22.5° up to R56, 11.25° from R72,
5.625° from R136 — plus one shorter piece for any remainder (at least 0.5°). R40 22.5° pieces are the owned curve
while in stock; others print.

### `sbend`

```json
{ "sbend": { "offset": 16, "length": 48, "turn": "left" } }
```
Shifts the track sideways by `offset` studs over `length` studs with two equal opposite arcs (optional `middle` studs
of straight between). Give `radius` (`"R40"`) instead of `length` to have the length solved; giving both checks they
agree. The palette's grid-exact presets are 8·32, 16·48 (R40), 16·80, 16·112, 16·144 and 24·72. Always printed.

### `turnout`

```json
{ "turnout": "left", "as": "A", "set": "straight" }
{ "turnout": { "family": "turnout_radius", "params": { "radius": 56, "hand": -1, "sprung": 1 } }, "as": "B" }
```
- `"left"` / `"right"`: the standard-shape turnout (owned while in stock, else printed); `"wye"`, `"three-way"`; or any
  junction family with its `params` (see the table).
- `set`: its state (`straight`/`diverging`; wye `left`/`right`; three-way `straight`/`left`/`right`). Default: the
  first state.
- `enter` (default `"in"`): the port that joins the current end. Entered at `in` (a **facing** turnout) the track
  continues along `out` (the straight/main exit; for a wye, its first leg). Entered at `out` or `branch` (a
  **trailing** turnout — the second turnout of a passing loop) the track continues from `in`.
- `follow`: continue along another exit instead (e.g. `"right"` on a wye).
- All other exits stay open and are reachable as `<as>.<port>`.

### `crossing`

```json
{ "crossing": "90", "as": "X" }
{ "crossing": { "family": "track_diamond", "params": { "angle": 30 } }, "as": "D" }
```
The 90° crossing (owned while in stock) or any crossing family. The track runs `in` → `out`; the crossing track's ports
(`X.south`/`X.north`, `D.cross-in`/`D.cross-out`) stay open for another track. `enter`, `follow` and `set` work as on
turnouts.

### `ramp`, `raise`

```json
{ "ramp": { "rise": 64 } }
{ "raise": { "to": 120, "grade": 4 } }
```
Go up or down: one `track_climb` piece, level at both ends — an eased start, constant grade, eased end, landing exactly
on the height. `ramp` changes height by `rise` mm (negative descends); `raise` goes to `to` mm above the table. `grade` is
the steepest percent (default 4, at most 5). Climbs are long: 38 mm takes 1.16 m at 4%. Laid right after a turnout or
crossing (or within 128 mm of level track of one), the climb starts with the level track the points still need (`lead`,
128 mm straight off the points). When printed, fit cuts the piece where its easements meet the slope and to the printer bed.

### `helix`

```json
{ "helix": { "turns": 2, "radius": "R72", "dir": "left", "climb": "up" } }
```
The Helix kit: `turns` in whole or quarter turns (≥ 1), `radius` (R56, R72 — the default and recommended —, R88, R104),
`dir` `left`/`right`, `climb` `up`/`down`, optional `rise` mm per turn (default: the least that leaves 118 mm between
turns) and `columns` per turn (0, 4, 8 — default — or 16). It ends level, on the same heading grid.

### `piece` (escape hatch)

```json
{ "piece": "turnout_curved", "params": { "radius": 56, "sweep": 45, "hand": 1 }, "state": "diverging", "as": "T" }
{ "piece": "printed_curve_r56", "sweep": 22.5 }
```
Any registered family with its `params` (in the units the table lists), `state`, `as`, `enter`, `follow`, and the
legacy `sweep` (degrees, + left), `rise` (mm) or `bend` (degrees) where the family needs one. An owned family is used
while in stock (then its printed counterpart); a printed family is used as given unless `source` says otherwise.

### `buffer`

```json
{ "buffer": true }
```
A buffer stop (`true` = 32 mm, or `64`). It ends the track: nothing joins its far end.

### `close`

```json
{ "close": "main.start" }
{ "close": "B.branch", "minRadius": "R32" }
```
Joins the current end exactly to an open port with the gap closer (one made-to-measure printed piece: a straight, one
arc, or an S of two arcs, level, 24–2000 mm, no tighter than `minRadius` — default R40). If the current end already
meets that port (a loop whose pieces add up) nothing is laid. On failure the report gives the solver's reason and where
the target lies relative to the current end. `close` ends the track.

## Rules of thumb

- A loop closes when its turns add up to 360° and its straights balance: an oval is `straight ×n`, `curve 180`,
  `straight ×n`, `curve 180`, `close <id>.start`.
- A turnout is as long as two straights (256 mm). Its branch ends 261.5 mm along and 103.6 mm aside, turned 22.5°; one
  R40 22.5° curve the other way brings it parallel at 16 studs (128 mm) from the main line.
- Passing loop: on the main line a facing turnout `A`, straights, then a **trailing** turnout `B` (`"enter": "out"`)
  of the opposite hand; the loop track starts `from` `A.branch` and ends with `close` `B.branch`.
- Ends that meet must face each other; laying a piece onto existing track without joining it is an error.
- Every piece must stay inside the room (Setup's size; a new project's is 2400 × 2100 mm, x 0–2400, y 0–2100),
  including its 32 mm half-width and connectors: a 180° R40 turn reaches 352 mm (radius plus half-width) beyond where it starts.
  Track may enter a KALLAX only through a cubby opening, resting on that cubby's floor (38 mm up for row 1); anything
  else that meets the shell, a shelf or a divider is an error. Leave room behind a shelf for a `"side": "back"` start.
- A ramp, helix or junction is laid flat; the fit checks grades, clearances and crossings.

## Report

`buildPlan` never throws on a bad plan; it builds what it can and reports:

- `ok`: no plan errors and no fit errors (fit warnings and open ends do not clear `ok`).
- `steps`: per step what it laid — families, piece ids, `owned` / `printed` / `fast`, and owned-stock fallbacks.
- `errors`: `{ path, message, hint }` — e.g. `tracks[1].steps[3]`, what failed, what would fix it. Schema problems
  (unknown keys, bad values, unknown families, duplicate labels) are listed for the whole plan at once; a step that fails
  stops its track (later steps are listed as not built in `warnings`) and the other tracks still build. A step whose
  pieces leave the room or run into a shelf's body gets an error saying how far past which wall (`226 mm past x = 0`)
  or where in which shelf; building carries on.
- `warnings`: non-fatal notes (a shelf moved into the room, a helix caution, steps not built after a failure).
- `fit`: the app's fit issues (code, severity, message, route, the plan steps involved; identical issues of one step,
  such as one per ramp piece, are merged with a `count`) and `openEnds`, each with its
  label (`A.branch`, `main.end`) and the step whose piece leaves it open.
- `trains`: per track, whether Test drive can run the train (your cars, else the example train) along its route: `ok`,
  `closed` (a loop it runs round), length, and the junction settings needed to get onto it (e.g. a passing loop's
  `A=diverging, B=diverging`). Sprung points are trailed through as built. The route named is the Test drive route
  that runs the track: its own, or — when a branch joins a loop through a plain turnout, so that from its own end the
  train would lap the loop back into the turnout's other side — another route that drives over all of it.
- `bill`: owned pieces used against stock, printed pieces by family, full-detail vs fast, and fallbacks.

`describeReport` prints it compactly. A failing plan reads like this:

```text
Plan "Siding that misses": NOT OK (1 plan error, 0 fit errors)
Steps:
  tracks[0].steps[0] turnout printed_switch_left, continues from out → 1 printed printed_switch_left (no owned one left); other exits: A.branch
  tracks[0].steps[1] straight 128 mm ×2 → 2 owned brick_straight_nominal
  tracks[1].steps[0] curve R40 left 45° (2 × 22.5°) → 2 owned brick_curve_r40
Errors:
  tracks[1].steps[1]: close to main.end failed: The ends face away from each other; turn one of them first. Fix: The target is 226 mm behind and 177 mm to the right of the current end, and the track must turn 113° left to meet it. Turn the track towards the target first so it lies ahead of the current end.
Fit: no issues.
Open ends:
  main.start (tracks[0].steps[0]) at (600, 500) heading 180°
  main.end (tracks[0].steps[1]) at (1112, 500) heading 0°
  spur.end (tracks[1].steps[0]) at (1035, 777) heading 68°
Trains (example train: 4 cars, 800 mm):
  main (Route 1): cannot run: The track is shorter than your train.
  spur (Route 2) with A=diverging: cannot run: The track is shorter than your train.
Bill: owned used/stock: brick_straight_nominal 2/8, brick_curve_r40 2/16; printed: printed_switch_left ×1 (1 full detail, 0 fast); printed because no owned one was left: brick_switch_left ×1.
```

## Examples

All of these build with `ok` and are checked by `tests/plan.test.ts`.

### Oval — `docs/plans/examples/oval.json`

Exactly a starter set's track: 8 owned straights and 16 owned R40 curves.

```json
{
  "version": 1,
  "name": "Owned oval",
  "description": "A starter set’s own track: 8 straights and 16 R40 curves in one loop.",
  "tracks": [
    { "id": "main",
      "start": { "x": 700, "y": 500, "heading": 0 },
      "steps": [
        { "straight": 128, "count": 4 },
        { "curve": "R40", "turn": "left", "angle": 180 },
        { "straight": 128, "count": 4 },
        { "curve": "R40", "turn": "left", "angle": 180 },
        { "close": "main.start" }
      ] }
  ]
}
```

### Passing loop with siding — `docs/plans/examples/passing-loop.json`

```json
{
  "version": 1,
  "name": "Oval with passing loop and siding",
  "description": "An oval with a passing loop, so two trains can pass, and a short siding.",
  "tracks": [
    { "id": "main",
      "start": { "x": 600, "y": 500, "heading": 0 },
      "steps": [
        { "turnout": "left", "as": "A", "set": "straight" },
        { "straight": 128, "count": 3 },
        { "turnout": "right", "as": "B", "enter": "out", "set": "straight" },
        { "curve": "R40", "turn": "left", "angle": 180 },
        { "straight": 128, "count": 2 },
        { "turnout": "right", "as": "C", "set": "straight" },
        { "straight": 128, "count": 3 },
        { "curve": "R40", "turn": "left", "angle": 180 },
        { "close": "main.start" }
      ] },
    { "id": "loop",
      "start": { "from": "A.branch" },
      "steps": [
        { "curve": "R40", "turn": "right", "angle": 22.5 },
        { "straight": 128 },
        { "close": "B.branch" }
      ] },
    { "id": "siding",
      "start": { "from": "C.branch" },
      "steps": [
        { "curve": "R40", "turn": "left", "angle": 22.5 },
        { "straight": 128, "count": 2 },
        { "buffer": true }
      ] }
  ]
}
```

```text
Trains (example train: 4 cars, 800 mm):
  main (Route 1): runs round a loop, 3.80 m
  loop (Route 3) with A=diverging, B=diverging: runs round a loop, 3.86 m
  siding (Route 4) with C=diverging: runs end to end, 4.25 m
```

### KALLAX station — `docs/plans/examples/kallax-station.json`

A siding that climbs from a trailing turnout on an oval to a station track inside a bottom-row cubby, ending on a
buffer. Written by hand over five rounds of reading this report (moved since to keep the oval inside the room).

```json
{
  "version": 1,
  "name": "Oval with a KALLAX station siding",
  "description": "An oval with a siding that climbs into a station inside a KALLAX cubby.",
  "furniture": [{ "id": "K1", "kallax": { "x": 1472, "y": 1900, "quarterTurns": 0 } }],
  "tracks": [
    { "id": "oval",
      "start": { "x": 400, "y": 120, "heading": 0 },
      "steps": [
        { "straight": 128, "count": 4 },
        { "curve": "R40", "turn": "left", "angle": 180 },
        { "straight": 128, "count": 1 },
        { "turnout": "left", "enter": "out", "as": "S", "set": "straight" },
        { "straight": 128, "count": 1 },
        { "curve": "R40", "turn": "left", "angle": 180 },
        { "close": "oval.start" }
      ] },
    { "id": "station",
      "start": { "kallax": "K1", "cubby": [1, 5], "side": "front" },
      "steps": [
        { "straight": 256 },
        { "buffer": true }
      ] },
    { "id": "climb",
      "start": { "from": "S.branch" },
      "steps": [
        { "straight": 128 },
        { "raise": { "to": 38 } },
        { "curve": "R40", "turn": "left", "angle": 67.5 },
        { "close": "station.start" }
      ] }
  ]
}
```

### Figure eight through a 90° crossing — `docs/plans/examples/figure-eight.json`

```json
{
  "version": 1,
  "name": "Figure eight through a 90° crossing",
  "description": "A figure eight that crosses itself on a 90° crossing.",
  "tracks": [
    { "id": "main",
      "start": { "x": 900, "y": 1000, "heading": 0 },
      "steps": [
        { "crossing": "90", "as": "X" },
        { "straight": 128, "count": 2 },
        { "curve": "R40", "turn": "left", "angle": 270 },
        { "straight": 128, "count": 2 },
        { "close": "X.north" }
      ] },
    { "id": "lower",
      "start": { "from": "X.south" },
      "steps": [
        { "straight": 128, "count": 2 },
        { "curve": "R40", "turn": "right", "angle": 270 },
        { "close": "main.start" }
      ] }
  ]
}
```

### KALLAX portal — `docs/plans/examples/kallax-portal.json`

A track starts in the back of a bottom-row cubby, runs through the shelf, ramps down from the cubby floor (38 mm) to the
table and joins an oval through sprung points, so trains from the shelf trail into the loop.

```json
{
  "version": 1,
  "name": "KALLAX portal joining an oval",
  "description": "A track leaves a KALLAX cubby, ramps down to the table and joins an oval.",
  "furniture": [{ "id": "K1", "kallax": { "x": 1490, "y": 1850, "quarterTurns": 0 } }],
  "tracks": [
    { "id": "oval",
      "start": { "x": 390, "y": 200, "heading": 0 },
      "steps": [
        { "straight": 128, "count": 4 },
        { "turnout": { "family": "turnout_radius", "params": { "radius": 40, "hand": -1, "sprung": 1 } }, "as": "C", "set": "straight" },
        { "curve": "R40", "turn": "left", "angle": 180 },
        { "straight": 128, "count": 6 },
        { "curve": "R40", "turn": "left", "angle": 180 },
        { "close": "oval.start" }
      ] },
    { "id": "portal",
      "start": { "kallax": "K1", "cubby": [1, 5], "side": "back" },
      "steps": [
        { "straight": 128, "count": 3 },
        { "raise": { "to": 0 } },
        { "curve": "R40", "turn": "right", "angle": 90 },
        { "close": "C.branch" }
      ] }
  ]
}
```

## Families

For `piece`, and the object form of `turnout` / `crossing`. Ports are the ids used in `enter`, `follow` and
`<label>.<port>`; `in` is where a piece is entered by default. Parameters are in the units shown. Plain-track families
also accept track options (`ballast`, `guard_rail`, `street`, `marker`, `metal`, `led`, `bracket…`), not listed here.

| Family | Piece | Source | Ports | States | Parameters |
| --- | --- | --- | --- | --- | --- |
| `brick_straight_nominal` / `printed_brick_straight` | 128 mm straight | owned / printed | in, out | | |
| `brick_curve_r40` / `printed_curve_r40` | R40 curve | owned / printed | in, out | | needs `sweep` |
| `brick_flex` / `printed_flex` | Flexible track, 32 mm | owned / printed | in, out | | `bend` ±5.625° |
| `brick_switch_left` / `printed_switch_left` | Left turnout | owned / printed | in, out, branch | straight, diverging | |
| `brick_switch_right` / `printed_switch_right` | Right turnout | owned / printed | in, out, branch | straight, diverging | |
| `brick_crossing90` / `printed_crossing90` | 90° crossing, 128 × 128 mm | owned / printed | in, out, south, north | | |
| `brick_double_crossover` / `printed_double_crossover` | Double crossover, 384 mm | owned / printed | in, out, parallel-in, parallel-out | straight, diverging | |
| `printed_straight` | Long straight, 160 mm | printed | in, out | | |
| `printed_curve_r56` | Wide curve R56 | printed | in, out | | needs `sweep` |
| `bridge_deck` | Bridge deck, 160 mm | printed | in, out | | |
| `vertical_transition` | Legacy ramp | printed | in, out | | `rise` |
| `track_straight` | Straight | printed | in, out | | length 24..2000 mm |
| `track_curve` | Curve | printed | in, out | | radius 192..1472 mm; sweep −90..90° |
| `track_sbend` | S-bend | printed | in, out | | offset −512..512 mm; length 64..2000 mm; middle 0..1000 mm |
| `track_easement` | Easement | printed | in, out | | dropin 0..1; lead 0..512 mm; radius 192..1472 mm; sweep −90..90°; clothoid 8..600 mm; reverse 0..1 |
| `track_climb` | Go up or down | printed | in, out | | rise −1000..1000 mm; grade 0.5..5 %; ease 2560..20480 mm; lead, trail 0..512 mm of level before and after the slope (use the `raise` step) |
| `track_ramp` | Ramp set piece | printed | in, out | | part 0..2; grade −6..6 %; length 0..2000 mm; radius; sweep |
| `track_banked` | Banked curve | printed | in, out | | radius 320..1472 mm; sweep −90..90°; cant 0.5..4°; transition 32..512 mm |
| `helix_curve` | Helix section | printed | in, out | | radius; sweep; grade0; grade1 (use the `helix` step) |
| `buffer_stop` | Buffer stop | printed | in, out (stop) | | length 32 or 64 mm |
| `rerailer` | Rerailer | printed | in, out | | length 64..128 mm |
| `street_track` | Street track | printed | in, out | | radius 0..960 mm; length 32..2000 mm; sweep |
| `level_crossing` | Level crossing | printed | in, out | | angle 45..135°; left 0..1; right 0..1 |
| `turnout_radius` | Turnout, radius family | printed | in, out, branch | straight, diverging | radius 40, 56, 104 or 148 studs; hand 1 left, −1 right; sprung 0..1; servo 0..1 |
| `turnout_curved` | Curved turnout | printed | in, out, branch | straight, diverging | radius 40..56 studs; sweep 45..90°; hand; sprung; servo |
| `turnout_wye` | Wye | printed | in, left, right | left, right | sprung; servo |
| `turnout_three_way` | Three-way turnout | printed | in, out, left, right | straight, left, right | sprung; servo |
| `crossover_single` | Crossover | printed | in, out, parallel-in, parallel-out | straight, diverging | spacing 128..512 mm; radius 320..832 mm; hand |
| `crossover_scissors` | Scissors crossover | printed | in, out, parallel-in, parallel-out | straight, diverging | spacing 128..192 mm; radius 320..832 mm; hand |
| `slip_single` | Single slip | printed | in, out, cross-in, cross-out | straight, slip | angle 15..60°; hand |
| `slip_double` | Double slip | printed | in, out, cross-in, cross-out | straight, slip, slip-back, slip-both | angle 15..60°; hand |
| `track_diamond` | Diamond crossing | printed | in, out, cross-in, cross-out | | angle −90..90°; length 64..1024 mm; cross 64..1024 mm |
| `track_diamond_curve` | Curve crossing | printed | in, out, cross-in, cross-out | | angle; length; radius −1472..1472 mm; sweep 5..90° |
| `track_gauntlet` | Gauntlet track | printed | in, out, parallel-in, parallel-out | | spacing; offset 8..24 mm; entry; length |
| `turntable` | Turntable | printed | in, out, l1…, free-1… (stop) | a0 … a15 | bridge 256..512 mm; index 11.25..22.5°; left 0..15; right 0..15; drive |
| `transfer_table` | Transfer table | printed | in, out, in2, out2, … | lane1 … lane6 | deck 256..384 mm; lanes 2..6; hand |
| `sector_plate` | Sector plate | printed | in, out1, out, out3 | track1 … track3 | deck 384..640 mm; tracks 2..3 |
| `bridge_lift_out`, `bridge_drop_leaf`, `bridge_bascule`, `bridge_swing`, `bridge_lift` | Moving bridges | printed | in, out | in/out, down/up, closed/open | span |
| `train_elevator` | Train elevator | printed | in, out, in-2, out-2 | level-1 … level-4 | span; levels 2..4; level_height 96..160 mm |
| `uncoupler_track` | Uncoupler | printed | in, out | lowered, raised | drive |
| `narrow_straight`, `narrow_curve`, `narrow_sbend`, `dual_straight`, `dual_curve`, `narrow_stub_switch`, `dual_divergence` | Experimental gauges | printed | in, out (+ branch / out1) | | as the palette |
| `track_rack`, `flex_tpu_track`, `funicular`, `monorail_*`, `rotary_dumper` | Experimental | printed | in, out (+ branch) | | as the palette |

## Not in v1

- The Flyover, Ladder, Triple and Wall-run kits have no step of their own; lay their pieces with `piece` steps.
- Moving pieces (turntables, transfer tables, elevators) can be laid with `piece`, but the train check only sets
  turnout-like junctions, never operates a mechanism.
- Routes, crossings and supports are whatever the editor derives from the laid pieces; a plan cannot name them.
