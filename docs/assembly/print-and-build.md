# Print and build

The **Download all** ZIP contains one plain 3MF per plate (`plate-01.3mf`, …) that opens in any slicer — OrcaSlicer, PrusaSlicer, Cura or Bambu Studio — with every part placed as on the plate and named by its code (`1A`, `2C`, `S3`: the same codes as in Print and the PDF guide), plus the STL files (`stl/`) and this guide. For Bambu printers, its `bambu-studio-<printer>` folder holds each plate as a Bambu Studio project, with supports painted only where needed, and its sliced G-code for that printer. The STL ZIP contains each printed part on its own. Multipart pieces are listed above this guide.

1. **Open the plates in your slicer.** Open each plain 3MF and turn on supports for the connector ends, as described under *Supports in your slicer* below. On a Bambu printer you can open the Bambu Studio projects instead: their supports are already painted, so open them as projects to keep those settings. Check each slice before printing — nothing is sent to your printer by this app.
2. **Remove supports carefully.** Supports sit only under the connector ends, along ramp rails, under bracket arms and under lock-pin heads. Clean up the mating surfaces so ends seat fully.
3. **Test-fit before building.** Connect one printed joint to your own track first. If it is too tight or loose, run **Connector calibration** in Print and prepare the plates again.
4. **Lay out the pieces.** Use the Parts list in Print (Advanced) to place every printed piece and every track piece you own. Standard brick track ends connect directly; no extra joiners are needed. Legacy custom-joiner projects need their printed joiners.
5. **Check each joint.** Rail tops should meet without a step. Look for warping, cracks or loose ends.
6. **Run a wagon over every route, then the whole train.** Go slowly in both directions. Stop for binding, derailing or loose joints.

## Supports in your slicer

The plain 3MFs carry no support settings, so set them in your slicer. Support only:

- **Connector ends:** under the rail tongues that stick out past each end face. Use your slicer's support painting or support enforcers there.
- **Ramp rails, bracket arms and lock-pin heads**, where they overhang.

Keep support out of the hollow rail channels, the clutch bays under the sleepers and other bridged roofs: block it there (support blockers or painted "block" areas) rather than using automatic supports everywhere. Leave no brim where connector ends meet the bed, so ends seat flush. Parts are spaced on each plate to leave room for supports; don't pack them closer.

## Shopping list, servos and motors

The **Shopping list** at the top of a layout's guide is everything to buy besides the printed parts, added up for the whole layout; each multipart piece's own share is listed with it below.

- **Servos:** plug each SG90 into its own channel of a PCA9685 servo driver (one board per 16 servos) with an extension lead. Feed the board's V+ terminal from a regulated 5 V supply — at least 2 A, plus 0.5 A per servo beyond four; a 10 A supply above 16 servos — never from the microcontroller, and join all the grounds. Wire the ESP32's (or any I²C microcontroller's) SDA, SCL, 3.3 V and ground to the board. Trim each servo's two endpoints in software, never by bending the horn or the rod.
- **Bluetooth motors** run from a Bluetooth hub: the 4-port hub 88012 has four motor ports, the train hub 88009 two. Infrared sets such as the 60052 Cargo Train (8884 IR receiver, 88000 battery box) can't drive Bluetooth motors.
- **Infrared L motors** (88003, on a turntable, bascule bridge or rotary dumper) plug into an IR receiver 8884 (two motors each) on a battery box 88000 or rechargeable 8878. Your train's receiver and battery ride on the train: give the mechanisms their own on another channel; the train's 8879 remote can drive it.
- **Mounting screws:** the list gives one screw per bracket hole. Use wall plugs or anchors suited to your wall or shelf.

## Ramps

Print the grade rig (Print → Advanced) or the whole ramp and support it at its final height with flat track on both ends. Run your full, loaded train up and down it in both directions before building the rest. If it slips or stalls, make the ramp longer or lighten the train.

Ramp-set pieces print flat as wedges; their parts follow each other in the parts list, so lay them in order (each part's grade matches its neighbour's at the joint). Their columns are cut to each part's flat underside.

## Overpasses

Check that your tallest loaded car passes under the bridge, and that the bridge supports stay still while the train runs over it. Run the full train on the upper and the lower route, each in both directions. Record the result under **After you print** in Print.

## Supports and brackets

Freestanding supports need a flat, stable base and room to reach derailed trains. Riser blocks stack stud-on-socket in the order listed (the 10-plate blocks first, the shorter block on top) and sit centred under a full sleeper, long side across the track; press the track down onto their studs. Printed brackets have no load rating: only anchor them where you have permission, and have the wall, anchors and fasteners checked by someone qualified.

## Buffer stops, rerailers, street track and level crossings

- **Buffer stop:** its block meets magnet couplers and buffer beams at 25.6 mm (8 plates) above the baseplate. Nothing connects to its far end.
- **Rerailer:** ramps outside the rails lift a derailed wheel to rail height; the bow-tie guides between the rails push wheels back out to their rail. Push a derailed wagon over it slowly, then run a train through at speed to check nothing rubs.
- **Street track:** the road surface is flush with the rail tops; each rail has a 4 mm flangeway groove. Clear any stringing from the grooves before running.
- **Level crossings:** lay the street track, then set each road tile on the baseplate beside it, ribs down and long edge against the track. Aprons slope down to 60304 road plates on their outer edge. For double track 16 studs apart, set the facing sides of both crossings to **Next track**: their fillers meet halfway.

## Colour markers

Colour inserts print on their own plates, one plate per colour: load that colour's filament before printing it (Print names each plate's colour, and the Bambu project already shows it). Press each insert into the recess on its marked sleeper until it is flush with the rim. The colour & distance sensor (88007) reads white, red, yellow, green and blue reliably.

## Turnouts, flex track and crossovers

- **Follow the per-assembly steps above this guide.** They list each part and the M3 screws, nuts and washers it needs. Print every part, even for routes you won't use.
- **Seat the base pieces on a flat surface.** Check that every key is fully seated and the rail tops meet without a step.
- **Flex track:** fit the pivot screw, nut and washer so nothing sticks out below the track. Test both bend limits.
- **Switching:** keep trains clear, pull the lock pins, slide each selector fully to its end stop, then put every lock pin back before running. On a double crossover, set all selectors the same way.
- **Test every path in both directions,** one train at a time. Stop for binding, wheel drops or a selector that moves under the train.
- **Point-blade turnouts (radius family, curved, wye, three-way):** keep the points slot, flangeways and frog gaps free of support material. Lower the points onto their floor with both heel blocks in their sockets, then screw the two keepers over the heel blocks (M3 × 4). Throw them by pushing the tie-bar knob. Manual points: drop the printed spacer into the open blade's gap beside the tie bar and lift it out before throwing. Sprung points: no spacer — they spring back to the printed setting; check a train trails through from the other route at walking pace before running at speed.
- **Servo-driven points:** before lowering the points, slide the throw rod in from outside the track, pin up and first, through the window under the stock rail. Lower the points so the pin enters the hole in the raised tie bar, then screw the keepers as usual. Centre the SG90 (90°) with its single-arm horn straight up, lay it on its side in the housing's cradle (ears in their slots, cable out of the back wall) and fix both ears with the servo's own screws. Lower the housing beside the track with the rod in its channel, put an M2 × 8 screw through the horn's 10 mm hole and the rod's fork slot (nut behind), and screw the clamp over the tie and the housing's ledge (four M3 × 4). Drive the servo about ±8° either side of centre and trim each end in the servo controller's software until the closed blade just touches its stock rail; never hold it stalled. No spacer is used.
- **Point-blade crossovers and slips:** build each set of points as on a turnout. On a 16-stud scissors, each track's outer rail beside the diamond is its own long rail tile, keyed to the base pieces at both ends; seat its keys like any other.

## Turntables, transfer tables and sector plates

- **Lay the pit or well pieces on a flat table** and lower the dovetails together; check the floor is flush across every seam.
- **Magnets:** glue one 6 × 3 mm magnet flush into every round floor pocket with the same pole up, and one into each deck end with the opposite pole down, so each deck end is pulled over the magnet beneath it.
- **Deck:** key its pieces together, rails up. Turntable and sector plate: lower it over the pivot pin and fit the cap with the M3 × 8 screw (it keeps 0.2 mm lift). Transfer table: drop it into the well with the two floor ribs in the channels under it.
- **Lock pins:** ream the 3.1 mm holes with a drill; drop a 3 mm steel dowel pin through each deck end into the floor to lock the deck lined up, and lift them out before moving it.
- **Rub graphite** on the floor and the deck's underside. Turn or slide the deck through its whole travel by hand before running a train.
- **Bluetooth turntable:** push a cross axle 12 down through the pivot pin and the table, fit the driven cap with its pegs in the bridge, and drive the axle from below with the L motor pinned to the printed motor mount by the four holes left, right, above and below its bearing (the four on the motor's front face). The worm 4716 sits on the motor axle two modules in front of the plate and meshes the 24-tooth gear 3648 on the vertical axle: fix the mount square to the vertical axle with the motor axle passing 16 mm (two modules) beside it. Stop with the bridge over a stall; the magnets pull it into line.
- **Infrared turntable:** the same with the infrared L motor (88003); run it from an IR receiver beside it.

## Moving bridges and the train elevator

- **Magnets:** glue each 6 × 3 mm magnet flush into its pocket (seat posts and saddle roofs; swing stop blocks and girder faces) so each pair attracts; check the poles on the bench first.
- **Landings:** clip each landing to the track on its side and to the baseplate. A lift-out or hinged span sets the gap between them: lay the span in before fixing the second landing.
- **Hinged section:** line the leaf's knuckles up inside the landing's and drive an M3 × 8 screw through each outer knuckle into its pilot. Raise the leaf past vertical; it leans back onto its stop blocks.
- **Bascule bridge:** push a cross axle 3 through each tower, counterweight arm and leaf arm (the cross holes key them). Add M8 nuts or steel shot to both counterweight pockets until the raised leaf only just falls back closed. With a Bluetooth L motor, pin it to the printed plate on the left tower; an infrared L motor (88003) pins to the same plate by the four holes left, right, above and below its bearing.
- **Swing bridge:** slide the two floor halves together (dovetails down from above), drop the deck over the pivot pin, and swing it clockwise (seen from above) to close against the stops.
- **Lift bridge and train elevator:** stand the four posts in the ground landings' collars and pin each with an M3 × 20 screw; join elevator post segments with an M3 × 12 screw through each tenon and pin the upper landings at their levels. Lower the deck between the posts, shoes round them, and hold it at a level with its four index pins (M3 × 20 or 3 mm rod). Support the track beyond each upper landing at that level.
- **Lead screw (lift bridge, elevator):** press the 608 bearing into the beam, push the beam's sockets down over the left posts' tops, run the M8 rod down through the bearing and the nut seated in the deck's boss, lock two nuts on the rod above the bearing (the deck hangs from them) and the crank's nut on top. One crank turn moves the deck 1.25 mm; pin it at the level's index holes.
- **Rub graphite** on the shoes, seats and pivot. Move each span through its whole travel by hand before running a train.

## Uncoupler track

- **Seat it on a flat surface:** the flap well and the drive have a solid underside (the end ties still clutch onto baseplate studs). Keep the well, the shaft bores and the drive floor free of support material.
- **Magnet/manual:** glue a 6 × 3 mm magnet into each of the two pockets in the block beside the track, the same face outwards, and one into the rocker arm so it attracts both. Lay the flap in its well half raised, hold the arm pointing straight up and slide the rocker's shaft through the cheek window, the block and the near stringer into the flap until its tip enters the far stringer. Swing the arm down: the cheek holds it in and the magnets hold the flap flush; swing it over to the other magnet to raise the flap.
- **Servo:** centre the SG90 (90°), fit its single-arm horn straight up and drill its 10 mm hole to 1.8 mm. Lay the servo in its cradle (ears in their slots, cable out the back) and screw both ears. Slide the rocker shaft in with the flap lowered, then pin arm to link and link to horn with 7 mm pieces of 1.75 mm filament. Trim the endpoints on your controller so lowered rests the flap flush and raised stands it upright just clear of its stop bar — never hold the servo against a stop.
- **Uncoupling:** stop with the coupling to be parted just past the flap, raise it and drive the loco on; the first wagon's leading bogie meets the flap and stays behind. Lower the flap before any train crosses. Trains running in → out push the raised flap onto its stop bar; the other way only the magnets or servo hold it. Try each wagon slowly first — whether a coupler parts cleanly is a physical trial.

## Flexible track (TPU, experimental)

- **Print:** each strip prints straight on its own two-filament plate: your PLA plus a TPU for the spine (the Bambu project loads Bambu TPU for AMS in AMS slot 2 and keeps its prime tower in the back-right corner of the plate). In another slicer, the plain 3MF's strip is one object with two parts: give the spine part your TPU and the rest your PLA. The TPU spine fuses to the PLA segments and is riveted through every sleeper, so it cannot pull out.
- **Lay:** bend each strip by hand to the drawn shape, joining its connectors to the neighbouring track; never bend tighter than R320 (the inner rail gaps close there, the outer ones open to 4 mm).
- **Hold it:** the spine springs back straight — clutch every sleeper to a baseplate or pin the strip to its board. Run a train slowly over the bent strip first; spring-back and TPU fatigue are physical trials.

## Narrow and dual gauge (experimental)

- **Narrow connectors mate this app's narrow and dual ends only.** A narrow end is the standard end's central clip and pin with a plain outer half tie; it does not fit 85976 narrow track, TrixBrix or other third-party narrow track. Test-fit two printed narrow pieces before printing a layout: clip retention without the outer rail tongues is a physical trial. Join narrow track to standard track only through dual-gauge track (the Gauge adapter is a 64 mm piece of it).
- **Narrow and dual track** print like any printed track, detailed or fast, with supports only under the connector ends.
- **Dual-gauge divergence:** one part, no assembly. Keep the frog gaps, flangeways and check rails free of support material and stringing, and seat it on a flat table or baseplate. Push a narrow wagon and a standard wagon slowly through it both ways before running trains: wheel acceptance through the frogs is a physical trial.
- **Narrow stub switch hardware:** three 6 × 3 mm neodymium disc magnets, one 3 × 12 mm steel dowel pin and one M3 × 8 mm self-tapping screw (2.6 mm pilot). Build it as the sector plate above: key the base pieces together on a flat table, then the deck; lower the deck over the pivot pin and fit the cap with the M3 × 8 screw; glue a magnet flush into each floor pocket (same pole up) and one into the deck end (opposite pole down); ream the 3.1 mm pin holes and drop the dowel pin through the deck end into the floor to lock it. Rub graphite on the floor and the deck's underside, and swing the deck between both stubs by hand before running a train.

## Rotary dumper (experimental)

- **Print:** the cradle (in ring, ring gear and body in one) and the out ring print standing on their in-facing end, the crank (hand drive) on its arm; all three print in the detailed style without support even on a Fast layout. The landings with their stands print flat, supported only under the connector ends.
- **Hardware:** four 608 bearings on M8 × 30 bolts with washers and nyloc nuts, a 16-tooth gear (94925), a cross axle 6 (3706) and two half bushes, four 6 × 3 mm magnets, two M3 × 16 self-tapping screws; with the motor drive a Bluetooth L motor (88013) or an infrared L motor (88003) on four friction pins.
- **Assemble:** press the out ring onto the cradle's four pegs and drive the two M3 screws into the walls. Bolt a bearing to each stand cheek (head outside, washer, bearing on the spacer, nyloc nut) and set both ring grooves down on the four bearings. Glue a magnet into each stop block and each out-ring pocket so the pairs attract. Slide the axle through the in stand, the gear (a half bush either side, meshing the ring gear) and the inner bracket, then fit the crank or the motor.
- **Run:** only 6-wide stock up to 80 mm over the rails passes. Push one uncoupled wagon, shorter than the cradle, fully in and turn the cradle until the lug meets the far stop (150°). The load drops onto the table under the cradle, which clears it by 2 mm upright: brush it out while the cradle is tipped, then turn it back onto the upright stop, where the magnets hold the rails lined up. Wagon retention, gear mesh and the motor's lift are physical trials.

## Rack railway and cog bogie (experimental)

- **Print:** rack track prints flat like a ramp wedge, so columns or risers hold it at height. Fit splits long pieces to the bed, and each part keeps the tooth spacing. The rack bar bridges the tie gaps (16 mm bridges); only the raised connector ends get painted support. The cog bogie's frame prints upright on its cheek feet and its cog prints teeth-down; neither needs support.
- **Hardware per bogie:** four 55423 train wheels, two cross axles 6 (3706) for the wheels, a cross axle for the cog, four half bushes (4265c), a universal joint (61903) and a 2x2 turntable (3403c01). The cog is driven by a Bluetooth L (88013) or M (88008) motor and hub in the loco.
- **Assemble:** push the cog axle through the middle bearings with the cog's hub towards its exit side. Fit each wheel axle with a half bush against each cheek and a wheel outside it, and set the wheels so the flanges run just inside the rails. Press the turntable on the deck studs and build the loco on it. Drive the cog axle through the universal joint, then tick **Cog drive** on that car in Setup.
- **Run:** join rack pieces Entry → Slope → Exit on plain track. Keep cog trains off turnouts and crossings: the cog runs 2.4 mm below the rail tops. Cog fit on your wheels is a physical trial; the cog keeps 0.1 mm tip clearance on a 1.28 m crest.

## Monorail (experimental)

- **Print:** straights up to 128 mm print in one piece and longer ones in two. A 90° curve prints in three pieces, a 45° curve in two and a 30° curve in one. A ramp part prints in two and gets painted support under its curved underside only. The switch base prints in three floor pieces, plus a slide and an end stop. Pieces split inside themselves join at dovetailed seams. Print the 4-stud straight first as a fit sample for your monorail motor.
- **Join:** press a 2x4 brick plate under every joint so its studs clutch the 2x2 sockets of both ends; columns of bricks under the plates make stanchions.
- **Switch:** drop the slide into its tongue grooves, key the end stop over its two floor bosses and glue the three 6 × 3 mm magnets in their pockets. Push the finger tab to move the slide between straight and diverging, where the magnets hold it.
- **Run:** give the monorail cars Track **Monorail** in Setup. The groove, rod and gear dimensions are inferred from the classic brick monorail's sizes, so the first motor run on the fit sample is the trial.

## Funicular (experimental)

- **Print:** the bottom buffer, the 128 mm straights (each with a string saddle on its middle tie), the top station (buffer, winch deck and motor plate), the drum, the two wedge feet and the hitch. All print in both styles.
- **Hardware:** a straight plank 12 mm thick, at least 70 mm wide, cut to the climb + 176 mm. The Bluetooth L or M motor named on the piece, with four friction pins, a cross axle and a hub. Braided string a little longer than the slope. A 6 × 3 mm magnet for the hitch, and screws for the feet and the station deck.
- **Assemble:** screw the wedge feet under the plank's ends. The bottom foot's lip catches the plank. Stand the top foot on a level support of the height the piece card gives. Lay the bottom buffer, the straights and the top station on the plank and screw the deck down. Pin the motor to its plate and push the axle through the drum. Tie the string to the drum, run it over the saddles and through the station slot, and tie it to the hitch on the car.
- **Run:** wind the car up and let it roll back down under control: it is one car on one string, with buffers at both ends.
