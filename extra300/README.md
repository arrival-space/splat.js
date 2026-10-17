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

## Google Photorealistic 3D Tiles

The space also carries the Arrival library's **Google 3D Tiles** vibe, centred on
the parking spot. Enter a Google Maps API key with the Map Tiles API in its
settings, and once the first tiles are in, Google's photographed Chicago becomes
the city, the land and the lake. Only **Meigs Field** stays ours: a box around
Northerly Island is cut out of the tiles, so the 1990s field shows flat and paved
instead of today's park. The cut starts just under the runway's surface, so
Google's water and low shore stay all round the island.

Google's buildings aren't solid, and the OpenStreetMap ones aren't drawn or solid while the tiles are on. Without a key,
or before the tiles arrive, the procedural OpenStreetMap city is drawn as before.
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
- **Chicago from OpenStreetMap**: about 15,000 building footprints, extruded at load time into procedural geometry.
  - **Facades:** procedural window patterns sized to real floors and bays.
  - **Roofs:** flat roofs with courtyards; gabled houses; pyramids and domes where OSM tags them.
  - **Tall towers:** built from their OSM `building:part`s, so Sears keeps its setbacks and antennas.
  - **Heights:** from OSM, or from the City of Chicago's storey counts.
  - **Years:** the default is today's skyline. Anything standing on the airfield (island, runway and overruns) is left out, so Meigs is open again amid the 2026 city. A building's year comes from the City's `year_built`, and the *Skyline year* setting shows any year back to 1980 (2002 was the last full Meigs year).
  - **Ground:** the Lake Michigan shore, the river, parks, the main roads and the rail lines. The gear knows land from water.
  - **Collisions:** hitting a building ends the flight (the OpenStreetMap city only, not under Google's tiles).
- **Meigs Field**:
  - The 3,948 ft runway on Northerly Island, painted as it was.
  - The terminal and tower, Burnham Harbor, Navy Pier.
  - The Loop skyline as it stood in the 1990s: Sears, Aon, Hancock, Two Prudential, 311 S Wacker, Lake Point Tower.
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

**Auto-rudder** keeps the ball centred in the air (**U** toggles it), and any
rudder key overrides it. Analog inputs (gamepad, touch, mouse yoke) stay
direct stick positions.

## Working on it

```bash
cd extra300
npm install
npm test               # 100 unit, component and flight-test checks (~4 s)
npm run build          # → dist/extra300-meigs.mjs, the single-file vibe
npm run serve          # http://localhost:8740/tests/harness/  (PlayCanvas + an Arrival stand-in)
npm run test:e2e       # headless Chromium on the local stand-in: boards, rolls, screenshots into dist/shots/
npm run test:arrival   # the real arrival.space client, as a guest, read-only: loads the vibe, boards, flies, exits
npm run osm:fetch      # download OSM + City of Chicago data (data/osm/raw/, not committed)
npm run osm:bake       # → src/world/data/chicagoOsm.js, the compact city the vibe ships with
BPY=bpyenv/bin/python npm run model   # Blender (pip install bpy) → src/render/data/extra300lModel.js, plus dist/extra300l.glb / .blend
```

`test:arrival` opens a public space in headless Chromium and blocks every
request that would write anything. It injects the built vibe and checks that
it boards, flies and hands the camera back. The last run was on client 1.26.0
(`worldScale` 0.7) and passed with no errors from the vibe.

`?fly=1&view=chase` on the harness URL boards right away; `?bundle=0` loads the sources without building.

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
src/sim/aircraft/ the airplane as data, every number tagged [pub] / [est] / [tune]
src/instruments/  gauge physics and the canvas instrument panel
src/world/        WGS-84 local frame, Meigs Field, the OSM codec and the baked city
src/render/       engine-free geometry: the Extra (baked from Blender), Meigs, procedural buildings, ground textures, sky, camera maths, sound
scripts/blender/  the Extra 300L modelled in Blender, by script: fuselage shell, cockpit, sunburst, tail, MT prop, gear
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
