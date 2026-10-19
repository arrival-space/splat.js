# Extra 300L at Meigs Field

A flight simulation of the Extra 300L aerobatic airplane that runs inside an
[Arrival.Space](https://arrival.space) space, as a vibe (an `ArrivalScript`
plugin). It starts where Microsoft Flight Simulator always started: runway 36
at Chicago's Meigs Field (CGX), closed in 2003 and reopened here.

Place the vibe where the airplane should park. Meigs Field, the lake and
Chicago are laid out around it. Walk up to the airplane and press **E** (or
tap it) to fly. The first boarding plays a short intro film of the airplane
(engine start, the details, then into the rear seat); **Skip intro**, Space,
Enter or Esc skips it. To screen-record it, open the space with **`?intro`** on its address
(`https://arrival.space/<space>?intro`) or tick the vibe's *Film mode* setting: once the city has
loaded, the airplane boards by itself and the film plays without the Skip button. In the cockpit a small card says what you need to take
off; the top bar has the **Easy mode** switch and **Controls** for every key.

New to it? Press **Easy mode** on the right edge (or **L**), on the ground
or in the air. The wing then can't be pulled past the stall (nor past 7 g),
whatever the keys, Shift or a gamepad ask for. The propeller's torque is
handled for you: the runway heading is held on the takeoff roll, the ball is
centred in the air, and the bank stays where you leave it. Press it again for
the real thing.

To watch first, press **O**. The airplane flies one circuit by itself while
the camera follows it: takeoff from 36, a loop over the lake, then the
landing. Press any flight key to take over wherever it is.

![Runway 36, Meigs Field, from the cockpit](docs/img/cockpit-runway36.png)

## The F-15C Eagle

The second airplane. Pick it with the **⇄** button on the top bar, **T** in flight, the vibe's *Aircraft*
setting, or `?aircraft=f15` on the space's address. It lines up on runway 36 in the Extra's place.

- **Flight model.** The same strip build-up as the Extra, built from the published F-15C figures:
  - 13.05 m span, 56.5 m² wing with a 45° leading edge, all-moving stabilators that also roll it differentially, twin fins.
  - Two F100-PW-220s at 64.9 kN dry and 105.7 kN with afterburner. The cores spool up and the burners light past the 80 % throttle detent.
  - Thrust lapses with air density and gains ram with Mach. Zero-lift drag rises through the transonic.
  - Retractable gear (**G**) with flaps that follow it, a dorsal speed brake (**J**, or **B** held in the air), nose-wheel steering that fades with speed, and a jet fuel starter (**K**).
- **Cockpit.** A green head-up display replaces the round gauges: pitch ladder and flight-path marker to scale in the cockpit view, heading tape, KCAS and altitude, Mach, g and α, and an engine strip with N2, FTIT, fuel flow and fuel.
- **3D model.** Modelled in Blender by script from the same numbers: raked intakes, the bubble canopy, the cockpit with its seat, stick and HUD, flaps, ailerons, stabilators, rudders, speed brake, nozzles with burner flames, and gear that folds away.
- **Intro film.** It has its own: radome, intake, wing, nozzles, then into the seat. The engines spool up on the way.
- **Easy mode** limits α and g (7.5 g) and raises and lowers the gear for you. On a phone it rolls at 75 % throttle and lifts off by itself.

| | model | F-15C |
|---|---|---|
| sea level, military / full burner | Mach 0.92 / 1.25 | ~800 KCAS limit (M 1.2) |
| 36,000 ft, military / full burner | Mach 1.00 / 2.28+ | M 2.5 |
| static thrust, both engines | 211 kN, idle → military ~4 s | 2 × 105.7 kN |
| roll rate, full stick, 350 KCAS | 214 °/s | — |
| stall, gear and flaps down, 17.2 t | 98 KCAS, no departure | — |
| burner take-off, lift-off | ~350 m, 10 s | ~270 m (900 ft) |

## The X-wing

The third airplane: an Incom T-65B X-wing. Pick it with **⇄** or **T**, or put `?aircraft=xwing` on the address.

- **Model.** Built in Blender from Troy Vigil's three-view schematic, scaled to its 12.5 m length: the long nose, the faceted canopy, R2 in his socket, and four S-foils, each with its engine, KX9 cannon and Red Squadron markings. **J** swings the S-foils into attack position. They stay closed on the ground.
- **Performance is invented, and it is fast.** Four fusial engines give 60 kN each, or 110 kN on boost past 80 % throttle, with no loss with height or speed. Top speed is Mach 1.9 on the deck in attack position, Mach 2.0 with the S-foils closed for cruise, and past Mach 3.3 high up, where a heat barrier stops it.
- **It flies like a starfighter:**
  - Repulsorlifts carry it when slow: it hovers, sinks gently and settles onto its gear.
  - Reaction thrusters turn the stick into roll, pitch and yaw rates: 190 °/s roll, held to 9 g.
  - Flight stabilizers send it where its nose points at any speed.
- **Lasers:** **Space** (a pad's A, or *Fire* on a phone) fires the four cannons in alternating pairs, with the S-foils open.
- **Cockpit and film:** a targeting-orange HUD with BOOST and S-FOILS, its own engine scream, and its own intro film.

## The aircraft carrier

USS Nimitz (CVN-68) rides at anchor in the lake, 3.4 km east of Meigs. Its angled deck points
360°, like runway 36.

- **Ship:** 332.8 m long with a 76.8 m flight deck, 18.5 m above the water. It has the island and its mast and the deck markings: landing-area edges, centre line, foul lines, catapult tracks, elevators and the hull number.
- **Physics:** the deck is a surface the gear rolls on. The hull and the island are solid; flying into them ends the flight.
- **Arresting wires:** four wires across the landing area, about 12 m apart. A wire is caught when the tail hook's tip, low enough to sweep the deck, crosses it. The wire then pulls back along both halves, in a V to the deck-edge sheaves that also centres the jet. Its pull is set for the jet's weight and speed, as a Mk 7 engine is, so it stops in about 100 m at under 3 g even with the engines at military power. A hook that skips every wire is a **bolter**.
- **Fresnel lens:** on the port sponson. The amber ball rides above or below the green datum bars as you are high or low on the 3.5° glide slope, and it turns red when you are dangerously low.
- **Flying it:**
  - Set *Start* to **Carrier approach**: Backspace then always puts you 3.2 km out on the glide slope, gear and hook down, on speed.
  - **/** lowers the F-15's hook. Easy mode lowers it with the gear.
  - **V** gains a **deck** view from the LSO platform.
  - In the F-15, **O** watches the demo pilot fly it into the 3-wire.
  - The Extra has no hook. It just lands on the deck, which is long enough for it.
- **Film:** `node tests/e2e/record-carrier.cjs` renders the demo landing as a film: chase, cockpit and HUD, a camera under the glide slope, the LSO's view of the trap, then an orbit of the stopped jet.

| | model | published |
|---|---|---|
| demo approach, 3.2 km final | within 0.5° of the glide slope, catches the 3-wire at ~139 kt | 3-wire is the target |
| trap at 135 kt, military power | stopped in ~95–120 m, ~2.8 g | ~100 m run-out, 3–4 g |

## Google Photorealistic 3D Tiles

The space also carries the Arrival library's **Google 3D Tiles** vibe, centred on
the parking spot. Enter a Google Maps API key with the Map Tiles API in its
settings, and once the first tiles are in, Google's photographed Chicago becomes
the city, the land and the lake. Only **Meigs Field** stays ours: a box around
Northerly Island is cut out of the tiles, so the 1990s field shows flat and paved
instead of today's park. The cut starts just under the runway's surface, so
Google's water and low shore stay all round the island.

Google's tiles are all the scenery round the fields: the city, the land, the mountains. Without a key, or
before the tiles arrive, only the fields themselves are drawn (Meigs, the runways). The ground the airplane
rolls and crashes on stays ours everywhere, from the airports' elevation grids and the lakes' masks.
The sync writes the tiles host (`space/space/entities/google-3d-tiles.json`) but
leaves its key alone. That file is git-ignored, because it holds the key once one
is set.

## What is modelled

- **Flight dynamics**: one rigid body with a spinning propeller, stepped at a fixed 480 Hz.
  - **Aerodynamics** come from a component build-up. Each wing and tail strip sees its own airflow, over the full ±180° range. Damping, stall, spins, knife-edge and inverted flight follow from the geometry rather than from tables.
  - **Propeller**: a constant-speed MT 3-blade with a flyweight governor, modelled with blade elements and momentum theory. It produces the slipstream and swirl over the tail, P-factor, and the engine's torque reaction.
  - **Engine**: a Lycoming AEIO-540 whose manifold pressure comes from throttle airflow balanced against cylinder demand. It has a starter, mixture cut-off, fuel burn, and oil and cylinder-head temperatures.
- **Landing gear**: spring-damper struts with slip-angle tyres, differential brakes and a tailwheel steered by the rudder. Prop tip, wingtips and rudder are hard points, so prop strikes and ground loops happen.
- **Gauges** carry their real instrument errors and lags:
  - **Airspeed**: drops out at high angle of attack.
  - **Altimeter**: three-pointer with a Kollsman window.
  - **VSI**: the classic 6-second lag from the capsule's calibrated leak.
  - **G-meter**: max/min tell-tales.
  - **Whiskey compass**: pendulous card, with turning and acceleration errors from Chicago's 70° dip.
  - **Engine**: slip ball, tachometer, manifold pressure, fuel flow, and the engine monitor stack.
- **Lake Michigan's shore from OpenStreetMap**: a 4 m land/water mask round Meigs. The gear knows land from water, and Google's lake is shaded as water from it.
- **Meigs Field**:
  - The 3,948 ft runway on Northerly Island, painted as it was.
  - The tower.
  - Lake Michigan at its real level, 15 ft below the field.

The published numbers it is tested against:

| | model | Extra 300L |
|---|---|---|
| max level speed at 1,000 ft | 189 KTAS | ~185 kt |
| climb, full power, 795 kg | 2,730 fpm @ 85 KCAS | 3,200 fpm |
| stall, power off, 950 kg | 59.5 KCAS | 55 KIAS |
| roll rate, full aileron, 160 KCAS | 437 °/s | ~400 °/s |
| idle / full static rpm | 700 / 2,620 | 700 / ~2,650 |
| takeoff, lift-off | ~130 m, 65 kt | — |
| loop from 160 kt, key held | 10.4 s, 85 kt over the top, no stall | ~10 s, 70–80 kt |
| full circuit with loop and landing | touchdown 66 kt, 1.1 m/s, stop in ~370 m | — |

**Flying it with a keyboard.** A real pilot pulls with a force, and the airflow
pushes back harder the faster the airplane goes. A held key works the same
way: it pulls about 5 g at 170 kt but uses nearly the whole elevator travel at
70 kt. The keyboard pilot also feels the buffet, holding the pull just short
of the stall, so holding the pitch key flies a clean loop. **Shift** pulls
straight through the buffet for stalls, snaps and three-point landings.

**Views.** **V** cycles cockpit, chase, tower and fly-by. Dragging the mouse looks around, or orbits the
airplane in the chase view; the wheel moves the chase camera in and out, and zooms the others. Your avatar
rides in the rear seat in a seated pose (the vibe's *Pilot pose* setting picks the animation).

**On a phone** it flies with one thumb. Boarding switches easy mode on and the engine is already at
75 %: the airplane rolls straight down the runway, rotates by itself at 65 kt and climbs away. The
left stick points it (down climbs, up dives, sideways banks); let go and it holds the attitude.
Easy mode does the same on a desktop when no pitch key is held.

**Auto-rudder** keeps the ball centred in the air (**U** toggles it), and any
rudder key overrides it. Analog inputs (gamepad, touch, mouse yoke) stay
direct stick positions.

## Working on it

```bash
cd extra300
npm install
npm test               # 150 unit, component and flight-test checks
npm run build          # → dist/extra300-meigs.mjs, the single-file vibe
npm run serve          # http://localhost:8740/tests/harness/  (PlayCanvas + an Arrival stand-in)
npm run test:e2e       # headless Chromium on the local stand-in: boards, rolls, screenshots into dist/shots/
npm run test:arrival   # the real arrival.space client, as a guest, read-only: loads the vibe, boards, flies, exits
npm run osm:fetch      # download OSM + City of Chicago data (data/osm/raw/, not committed)
npm run osm:bake       # → src/world/data/chicagoOsm.js, the compact city the vibe ships with
BPY=bpyenv/bin/python npm run model   # Blender (pip install bpy) → src/render/data/extra300lModel.js, plus dist/extra300l.glb / .blend
BPY=bpyenv/bin/python npm run model:f15   # the F-15C → src/render/data/f15cModel.js, plus dist/f15c.glb / .blend
BPY=bpyenv/bin/python npm run model:xwing # the X-wing → src/render/data/xwingModel.js
```

`test:arrival` opens a public space in headless Chromium and blocks every
request that would write anything. It injects the built vibe and checks that
it boards, flies and hands the camera back. The last run was on client 1.26.0
(`worldScale` 0.7) and passed with no errors from the vibe.

`?fly=1&view=chase` on the harness URL boards right away (add `&aircraft=f15` for the Eagle); `?bundle=0` loads the sources without building.
`AIRCRAFT=f15c node tests/e2e/record-intro.cjs` renders the F-15's intro film.

## Syncing with the space

`scripts/sync.mjs` drives the official `arrival` CLI
([arrival-plugins/tools/arrival-cli](https://github.com/arrival-space/arrival-plugins/tree/main/tools/arrival-cli)):

```bash
npm run sync -- setup        # install the CLI into .arrival-cli/
npm run sync -- login        # browser sign-in; or export ARRIVAL_TOKEN=<Arrival API key>
npm run sync -- create       # make the space, its id goes into arrival.json
npm run sync -- validate     # pull, stage our files, server-side dry-run
npm run sync -- push         # test, build, pull, stage, validate, push
```

Every push pulls the space first and then writes only the files this repo owns:

- the plugin
- its host entity
- the runway-36 spawn point
- a few `room.json` keys

Anything edited in the browser stays as it is.

## Layout

```
src/sim/          flight model: atmosphere, aero, engine, propeller, gear, rigid body (no PlayCanvas)
src/sim/aircraft/ the airplanes as data (extra300l.js, f15c.js, xwing.js), every number tagged [pub] / [est] / [tune]
src/instruments/  gauge physics, the Extra's canvas instrument panel, the F-15's HUD
src/world/        WGS-84 local frame, Meigs Field, the airports, the OSM codec and the baked lake shore
src/render/       engine-free geometry: the Extra (baked from Blender), Meigs, the runways, ground textures, sky, camera maths, sound
scripts/blender/  the Extra 300L, the F-15C and the X-wing modelled in Blender, by script (kit.py: the shared helpers)
src/input/        keyboard / gamepad / touch / mouse-yoke → controls
src/plugin/       the Arrival.Space glue (the only code that touches pc / ArrivalSpace)
tests/            node --test suites, the flight-test autopilot, the browser harness
scripts/          build, serve, sync
docs/PLAN.md      architecture, conventions, validation, roadmap
```

## Data

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available under the
Open Database License. Building years and storey counts come from the
[City of Chicago data portal](https://data.cityofchicago.org/) (Building Footprints).
