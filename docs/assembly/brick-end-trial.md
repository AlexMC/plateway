# Brick v1: shared connector and rail profile

Engineering reference for the shared connector and rail geometry. For the user calibration steps, see [Connector calibration](fit-coupon.md). This file contains no built-in physical pass; a user's results belong to their local project or calibration library.

## Track systems and catalogue geometry

- **Brick v1** is the new-project default. `cad/profiles/brick-v1.json` owns the rail section and connector version; `cad/models/brick_end.py` preserves the accepted sample's distinct A and B ends on every straight, curve, vertical transition, bridge deck and direct bridge-joint generator. Integral ends mate directly—no separate custom joiner is inserted.
- **Custom joiner v1** (legacy) retains rectangular sockets and separate printed joiners. It does not claim brick compatibility. Projects saved as versions 1–3 migrate to this system, preserving their geometry and observations instead of silently replacing their interfaces. New projects never offer it.
- Catalogue rail dimensions are product geometry, not user measurements: 63.8 mm body, 3.2 mm base, 40 mm rail-centre spacing, 2.4 mm crown and 9.6 mm running height above the underside datum. Standard owned straights are 128 mm and R40 curves have a 320 mm radius/22.5° sweep; stale custom overrides cannot change those ports. Custom rails still require measured dimensions for layout export.
- Shared connector ends remain rigid in the declared port tangent frames. Circular/Hermite centre paths are retained outside short connector blends. Production rails and top/3D previews use source-measured 15.8 mm cross-ties, normal 16.2 mm open gaps and half-ties ending 7.9 mm inward from each port, with 7.8 mm continuous rail-base strips. Non-grid lengths keep the extra spacing only in the central gap(s), not at the connectors; centre blends remain approximate in previews and owned pieces remain planning representations.
- Production cross-tie ends carry nominal Ø4.8 × 1.6 mm studs. Underside seating bays, ribs and solid clutch pins accept nominal stud envelopes on a rigid 8 mm grid, including curved/graded pieces; rail contacts and the accepted calibration coupon are unchanged. These brick connections are not physically calibrated: test insertion and retention on real bricks/plates before printing a batch.
- Plan geometry and CAD share right-handed XY coordinates with Z up: positive bends turn left. Only the top-view screen projection reverses Y; saved positions and source contacts are not reflected with the display.

## Shared geometry

`cad/profiles/brick-v1.json` and `cad/models/brick_end.py` define the same interface for the 24 mm sample and applicable production rails:

- 63.8 mm body width; 3.2 mm base.
- Rail centres at y=±20 mm; 2.4 mm crown; rail top z=9.6 mm.
- Vertical stem to z=5 mm, shoulders to z=4 mm, 6 mm rail foot.
- Rigid source-derived A and B rail-mating contacts retained independently over 5.8 mm inward from each declared port; minimum port spacing 24 mm. B is not an interchangeable mirrored copy of A. Production outer end-body attachment zones are updated separately from the protected rail contacts.
- No integral adhesion pads or sacrificial pedestals. The zero-adjustment sample's envelope is approximately 31.4 × 63.8 × 9.6 mm, including projecting contacts.

Straight, curve, transition, deck and bridge-joint generators call this shared implementation instead of approximating the contact with a separate rectangular plug. Shared decks connect directly; the layout fitter inserts no custom loose joiners. Existing custom-joiner projects remain a separate system.

Circular and Hermite centre paths are exact outside localized end blends. Blend regions occupy at most the first/last `min(23.2, (length−0.8)/2)` mm; source contacts themselves are not bent. With end depth `d=5.8`, conservative centreline-deviation bounds are `2d²/R` for curves and `2d²K` for ramps, where `K` is the maximum absolute endpoint second derivative of the declared Hermite height function. These bounds do not establish swept train clearance or printed strength; inspect generated meshes and test the assembled route.

Production sweeps use one merged body-and-rails contour and absolute 0.001 mm tessellation deflection. This avoids microscopic cavities between separately tessellated touching sections and prevents relative tessellation from flattening shallow ramps. The accepted sample and versioned contact/profile dimensions are unchanged; production now retains the actual B-end latch instead of duplicating A. Regenerate production parts from the current source rather than reusing historical artifacts.

## Library coverage

| Family | Shared interface in standard mode |
| --- | --- |
| Printed straight | Accepted A/B ends; constant shared running section |
| Printed curve | Accepted A/B in tangent frames; same section on either bend direction |
| Vertical transition | Accepted A/B in endpoint pitch frames; same section on rising/falling Hermite paths |
| Bridge deck | Accepted A/B; 63.8 mm body and 3.2 mm base, not an oversized decorative deck |
| Bridge joint (direct CAD generator) | Same A/B and running section; at least 24 mm between ports |
| Connector sample | Original accepted 24 mm sample with both distinct ends |
| Owned straight/R40 curve | Nominal planning geometry only; no printable CAD claim |
| Columns/brackets | Support interfaces, not rail-bearing parts; no rail connectors added |

Production centres have real through-openings, not a continuous full-width web. Sections of the supplied rerailer establish 15.8 mm interior ties on a nominal 32 mm pitch, 16.2 mm normal gaps, and inward end-tie boundaries at 7.9 mm. Continuous 7.8 mm-wide rail stringers support the running rails; the 6 mm rail foot above them is unchanged. As in LDraw 53401 the stringers are hollow from below: 1.2 mm walls, open to z=2.2 between them and to the rail foot (z=3.2) over the central 4 mm, closed by a 1.2 mm cross-web at each full-tie centre and by each end tie's inner wall. LDraw's V roof above z=3.2 is not copied, because it would hollow the printed rail foot and need support; both channel ceilings are flat bridges (5.4 and 4.0 mm). A straight laid on a studded baseplate on the 8 mm grid therefore seats with every baseplate stud clear. The accepted rail-mating contacts and 24 mm calibration sample remain unchanged.

For lengths that do not fit a whole 32 mm repeat, the user-selected policy preserves the pattern from both connectors and places the residual only in the central gap, or the two gaps beside a central tie. Tie widths, route length and connector poses do not stretch. A 160 mm straight has normal 16.2 mm gaps throughout; an R56 22.5° curve has a 32.129 mm central gap, an 80 mm straight has two 24.2 mm central gaps, and a short 24 mm bridge joint has one 8.2 mm gap. Those curve boundaries are radial and dimensions use centreline arc stations; ramp stations use horizontal run. The official R40 22.5° curve follows LDraw 53400 instead: three rigid 15.8 × 63.8 mm rectangular ties centred at equal 5.625° steps (centreline stations 31.416, 62.832 and 94.248 mm), each with the straight tie's complete clutch, and its end half-ties are rigid 7.9 mm rectangles in the port frames.

### Brick connections

- Top studs: nominal Ø4.8 × 1.6 mm above the 3.2 mm tie surface, at lateral ±4, ±12 and ±28 mm (LDraw 53401: 12 per full tie, 6 per end half-tie). Full ties have two rows 8 mm apart; end half-ties have one row 4 mm inward from the port. Flex half-ties carry ±4 and ±28 only (LDraw 64022).
- Full-tie underside: 1.8 mm-deep seating bays, 12.8 mm longitudinally, with a central 32 mm-wide bay and outer bays at lateral 24–30.4 mm on each side. LDraw's nominal bay is 1.6 mm, but real studs are about 1.7 mm tall, so the deeper bay lets the track sit flat on a baseplate. The outer bays contain Ø3.2 mm **solid clutch pins**, not hollow tubes. Retaining ribs are 1.6 mm wide. Half-ties have 4.8 mm-long outer sockets and retain the source's central latch/cavity geometry. Behind that geometry, a 0.6 mm slice is opened so the baseplate studs 4 mm inside each port clear.
- Each tie uses a rigid attachment grid, not separately warped stud positions. Printed-only curved ties keep radial exterior boundaries; very tight direct-API curves are rejected if a socket would break a wall. The catalogue's minimum 240 mm radius is supported. Graded ties have locally planar seating lands at every stud column, so both the mating brick's body and its studs can seat without nominal interference.
- Dimensions follow the coherent nominal [LDraw 53401 track model](https://library.ldraw.org/library/official/parts/53401.dat) and [sleeper subpart](https://library.ldraw.org/library/official/parts/s/53401s01.dat) by Ronald Vallenduuk, with [stud](https://library.ldraw.org/library/official/p/stud.dat) and [solid underside pin](https://library.ldraw.org/library/official/p/stud3.dat) primitives by James Jessiman (CC BY 4.0; 1 LDU = 0.4 mm). This is a community geometry reference, not manufacturer tolerance certification. Local rerailer/curve examples have approximately 4.9 mm studs; those larger diameters are deliberately not mixed with the nominal 4.8 mm socket width. The shared profile records the comparison.

No screw holes/bosses or rerailer guide ramps are added. Brick attachment is separate from rail-connector calibration: the accepted coupon does not test these new studs or sockets. Before printing a batch, test one production piece with real 1×2 and 2×4 bricks/plates and on a baseplate, checking full seating, retention and removal without forcing. Remove rail-end supports and inspect underside bridge roofs for sag or burrs. Digital insertion checks and successful slicing do not establish printed clutch fit.

### Fast print

Printed track has a second style, selected per project. A fast-print piece (request parameter `lite: 1`; absent means full detail) is built by `cad/models/lite.py`, which follows the full-detail pipeline step for step with its unchanged helpers (so fast-print changes never alter full-detail recipes): both 7.9 mm end half-ties are unchanged — accepted contacts, half-tie clutch and their six studs — and so are the body sweep and running rails. Every full tie is replaced by a 2.8 mm gauge brace at its centre (equal 5.625° steps on the official R40), spanning between the rail supports, and the rail stringers stay solid (lateral 16.1–23.9 mm, z 0–3.2) instead of hollow. Full ties' studs and underside clutch are gone, so fast-print pieces only clutch bricks at their end half-ties and do not seat on a studded baseplate. Ramps print lying on their side, so their braces run the full body width and stand at most 16 mm apart; the bed-facing rail support only bridges between them.

Turnouts, crossovers and the 90° crossing keep every mechanism unchanged — cassette floors and pockets, stops, keeper seats and posts, state-lock sockets, flangeways, seam plugs and dovetail keys — and swap tie clutch for braces the same way; the far keeper stands on a solid seat instead of the first straight tie. Selectors, keepers, lock pins and both flex leaves (which only carry end half-ties and the pivot) are identical to full detail. The same motion, retention, lock, envelope, flangeway and source-contact probes run on both styles. Fast-print parts are mesh-derived like every shared-end part, so no STEP is written.

## Nominal brick layout dimensions

`src/domain/track.ts` owns the stud-grid layout constants: 8 mm pitch, 128 mm owned straight, 320 mm R40 radius and 22.5° curve sweep. Printed defaults remain custom compatible geometry: a 160 mm straight and 448 mm R56 curve, with the same running section and contacts. They are not one-to-one replicas of owned pieces.

The nominal references are [LDraw 53401](https://library.ldraw.org/library/official/parts/53401.dat) (end datums ±160 LDU, rail centres ±50 LDU), [53400](https://library.ldraw.org/library/official/parts/53400.dat) (800 LDU radius, 22.5° segment), and the [LDraw unit convention](https://www.ldraw.org/article/218.html#ldu) (20 LDU per stud, nominally 0.4 mm/LDU). LDraw explicitly describes its dimensions as approximations, not manufacturing tolerances. These references constrain layout, not the accepted mating surfaces or 2.4 mm source-derived crown.

Standard-mode catalogue ports ignore legacy part-design straight-length and curve-radius overrides. Custom-joiner projects retain those settings; saved routes and physical observations are not rewritten.

## Source-derived previews

Regenerate `src/editor/brick-end-preview.json` from the repository root with:

```sh
uv run python -m cad.generate_preview
```

The asset contains independent production A/B triangle meshes and projected silhouettes, normalized to a port at the origin, inward +x, underside z=0. It includes the complete 7.9 mm half-tie attachment region, while the accepted rail contacts remain rigid over 5.8 mm. A `flex` A/B pair is the same end with the top studs outside `flexStudLateralOffsets` removed (LDraw 64022 half ties carry ±4/±28 only); its silhouette is unchanged. Its digest binds the generator, shared CAD implementation, profile, both source STLs and Python dependency lock. Geometry regressions compare each preview end with the corresponding production end and independently protect the unchanged calibration/contact geometry.

Standard top/3D library, placed-piece and ghost previews share these contacts, measured cross-ties/openings, studs and source rail section. Studs follow the profile's stud columns. The official R40 22.5° curve (profile `officialCurve`) shows three rigid 15.8 × 63.8 mm ties centred at equal 5.625° steps, as LDraw 53400; every other piece keeps the 32 mm pitch with its residual in the central gap(s). The 3D view includes underside cavities, ribs and pins but not the under-rail channel; orbit below the track to inspect them, with the room floor hidden from below. Preview centre blends, planarized short tie frames and pitched 2D projection are approximate; fit adjustments appear in generated CAD, not nominal planning previews. Inspect exported meshes for manufacturing and clearance decisions.

## User-local adjustment

`fit_adjustment` is bounded to −0.15…+0.15 mm. Positive removes lateral material at the mating tongues for a looser fit; negative adds it for a tighter fit. It does not scale the part, change rail spacing or alter the running rail section. Zero preserves the standard contact geometry.

The user procedure (generate, print, test both ends, report, adjust, reuse) is in [Connector calibration](fit-coupon.md). Calibration is keyed by track/connector version, printer, material, nozzle, process and calibration-process version; custom profiles also include their baseline dimensions. Layout edits do not invalidate a connector setup; different print settings deactivate its adjustment. A later failed report supersedes an earlier pass at the same adjustment.

## Slicer support contract

Each plate ships twice: a plain core-spec 3MF (geometry only, placed as on the plate, no support data) for any slicer, and a Bambu Studio project for the chosen Bambu printer. In the Bambu project supports are painted, not automatic: the exporter marks support-enforcer triangles (`paint_supports`) and slices with `normal(manual)` supports, so Bambu Studio adds support only where it is painted and nowhere else — never inside the hollow rail channels, under clutch bays or under other bridgeable roofs. Users of the plain 3MF set the same places by hand (see the print and build guide). Painted places:

- **Connector tongues:** downward-facing faces from 4.7 mm outside to 2.8 mm inside every shared brick port face, within the rail stringer band (16.1–23.9 mm off-centre). The calibration sample is painted the same way at both ends.
- **Ramps** (side-on-bed): rails and studs, whose sides face open air; the deck, its clutch bays and channels are not painted.
- **Anchored brackets and turnout lock-pin heads:** every roof within 30° of horizontal.

Other parts, including selectors, keepers and the middle base tiles of turnouts and crossovers, print without support. Supported plates keep small-overhang exclusion disabled, 0.2 mm top separation, three interface layers, 0.2 mm interface spacing and no attached brim where connector ends are present. Supports are separate slicer output, not functional STL material. Painted supports spread up to about 6.7 mm past a part's outline on the first layer, so parts with supports stand at least 15 mm apart (8 mm from an unsupported neighbour) instead of the usual 7 mm; closer neighbours make Bambu Studio reject the plate for colliding toolpaths. Transition parts use their recorded side-on-bed print transform. Fast-print track plates never share a plate with full-detail parts and print with the printer's fast process; the receipt records each plate's `process`.

The exporter records process overrides in Bambu's `different_settings_to_system` metadata, then reopens and slices the saved archive without external preset overrides. This prevents the GUI from silently restoring system support defaults. Verify actual support-interface toolpaths under the roofs for the selected machine; account for its nozzle XY offset when comparing G-code to model coordinates. A support checkbox or thumbnail alone is insufficient evidence.

## Provenance and limits

- Contact reference: `cad/models/reference/brick_red_coupon.stl`, SHA-256 `7797422530cc0a9870e9f39ba3d72df5679c5d7de581de1580e9d35c40d1e3b1`: a 24 mm coupon cut from the running-section reference; both its connector ends are that model's end.
- Running-section reference: `cad/models/reference/rerailer_straight_full.stl`, SHA-256 `b100de50e94c69d01d51dba730f167f9c0157618ffba474f2f914b5ce5445c77`: byte for byte the STL of a straight rerailer by lev (Printables #466240).
- Sources and profile dependencies are bundled and hashed into generated receipts. Historical receipts keep the source hashes they recorded when the library changes.

**Credit:** the reference geometry, and every track part adapted from it, is licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): a straight rerailer by lev, https://www.printables.com/model/466240. Changes: its connector ends are cut, re-joined and given new rails, ties and brick studs. Redistributing packages or meshes needs this credit.

Digital validity, a successful slice and a reported sample fit are separate facts. None establishes wheel running, traction, whole-layout retention, support strength or anchor safety.
