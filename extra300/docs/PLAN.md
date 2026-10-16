# Extra 300L at Meigs Field — plan

## Goal

An Extra 300L that flies right, flown inside an Arrival.Space space, starting
on runway 36 at Meigs Field the way Flight Simulator 1.0 through 2002 did.
"Right" means two things:

- **The airframe matches the published numbers.** That covers stall, climb, roll rate, top speed, ground handling and engine behaviour.
- **The gauges behave like real instruments.** A pilot who knows the airplane should recognise how it feels and what it reads.

## Architecture

```
            engine-free, unit-tested in Node                         PlayCanvas / Arrival glue
 ┌────────────────────────────────────────────────────────┐   ┌─────────────────────────────┐
 │ sim/        atmosphere · aero strips · engine · prop    │   │ plugin/extra300.js          │
 │             gear · mass & balance · rigid body (480 Hz) │──▶│   boarding, input sampling, │
 │ sim/aircraft/extra300l.js   the airplane as data        │   │   camera takeover, HUD, UI  │
 │ instruments/ gauge physics · canvas panel               │──▶│ plugin/aircraftVisual.js    │
 │ world/      WGS-84 local frame · Meigs · ground query   │──▶│ plugin/sceneryVisual.js     │
 │ render/     model & scenery geometry · camera · sound   │──▶│ plugin/pcMesh.js            │
 │ input/      device state → controls                     │   └──────────────┬──────────────┘
 └────────────────────────────────────────────────────────┘                  │ scripts/build.mjs (esbuild)
                                                                             ▼
                                                     dist/extra300-meigs.mjs  (one file, no imports)
                                                                             │ scripts/sync.mjs
                                                                             ▼
                                         arrival CLI: pull → stage → validate → push → the space
```

The rule that keeps it testable is that only `src/plugin/` may touch `pc`, `ArrivalScript` or `ArrivalSpace`. Everything else is plain ES modules over plain arrays.

## Conventions

- **Units:** SI inside the sim. Knots, feet, inHg and °F appear only on gauges and in test names.
- **Body axes:** x forward, y right wing, z down. Positions are measured from R, the CG at the reference loading.
- **Earth axes:** local NED (north, east, down) about the runway-centre datum, at 593 ft MSL.
- **Render space (PlayCanvas):** x east, y up, z south. `fromBody`, `fromNE`, `nedToRender` and `simToRenderQuat` are the only crossings, and a test checks that they agree.
- **Control signs:**
  - stick right gives +aileron and rolls right;
  - stick back gives +elevator and pitches up;
  - right pedal gives +rudder and yaws right;
  - right pedal steers the tailwheel right.
- **Aircraft data:** every number carries a provenance tag:
  - `[pub]`: published;
  - `[est]`: estimated from three-views or textbook methods;
  - `[tune]`: set to hit a published figure, with the test that pins it named.

## Testing

| layer | where | what it pins |
|---|---|---|
| maths | `tests/math.test.js` | quaternion/Euler round trips, inertia solve |
| atmosphere | `tests/atmosphere.test.js` | ISA, pressure altitude, CAS |
| powerplant | `tests/engine.test.js` | idle 700 rpm, static rpm/MP/thrust, 300 hp rated, governor, starter, fuel flow |
| aerodynamics | `tests/aero.test.js` | control signs, Cmα < 0, Cnβ > 0, rate damping, section polar over 360° |
| ground | `tests/gear.test.js` | three-point attitude and tail share, drop test, parking brake, braking distance, tailwheel steering, prop strike |
| flight-test card | `tests/performance.test.js` | Vmax, climb, stall vs weight, roll rate, 6 g pull, takeoff from Meigs 36 on the centreline |
| gauges | `tests/instruments.test.js` | ASI at high α, VSI lag, g tell-tales, compass heading and northerly turning error, ball, Kollsman |
| input | `tests/input.test.js` | keyboard ramps, FS arrow convention, gamepad deadzone/expo/brakes, touch |
| world | `tests/world.test.js` | local frame, runway on the island, lake level, Sears position, triangulation |
| model | `tests/model.test.js` | 8.0 m span, ~7 m length, wheels on the gear contact points, frame mapping |
| deliverable | `tests/bundle.test.js` | single file, one ArrivalScript class, scriptName, no reserved fields |
| sync | `tests/sync.test.js` | staged files, one default spawn, untouched foreign entities, managed room keys only |
| browser | `tests/e2e/shots.mjs` | the bundle runs in PlayCanvas: boards with E, rolls at full throttle, screenshots of every view |

`tests/lib/pilot.js` is the test pilot: a few PID loops hold altitude, airspeed or pitch and keep the ball centred, so the flight-test card measures the airplane rather than the stick technique.

## Known approximations (phase 1)

- **Meigs coordinates** are hand-placed from memory of the layout. These need surveying: the runway centre, its true bearing, the island outline, the shoreline and the landmark positions. Every one is marked `[verify]` in `src/world/meigs.js`.
- **Ground effect** reduces induced drag only; there is no lift increase.
- **Downwash and slipstream** use single lagged values. The slipstream covers fixed fractions of the tail and inner wing, regardless of yaw.
- **Climb rate** reads 2,730 fpm against 3,200 published, at 85 KCAS. Vy and the published weight still need checking before re-tuning the drag or the propeller.
- **Fuel and oil** run inverted indefinitely. The real Christen system has time limits, and those aren't modelled.
- **No stick forces:** trim simply adds to the elevator.
- **Tailwheel** steers ±30° with the rudder, with no castering breakout.
- **Gear** acts along the ground normal, not along the strut axis.
- **Multiplayer:** the airplane is attached to the player through `attachPlayerToEntity`, so others see the avatar riding. A second Extra is not yet rendered for remote players.

## Roadmap

**Phase 1: done in this commit.**

- Flight model, gauges and the instrument panel.
- Procedural Meigs Field and the Loop skyline, with the four camera views and sound.
- Keyboard, gamepad, touch and mouse-yoke input.
- The browser harness and the sync tooling.

**Phase 2: fidelity.**

- **Spins:** upright and inverted spin rate, and the turns to recover, against Extra flight-test data, plus snap rolls.
- **Tailwheel:** castering with breakout.
- **Controls:** stick-force gradient and the trim tab.
- **Inverted systems:** limits on the inverted fuel and oil systems.
- **Weather:** turbulence and crosswind gusts.
- **Approach and landing:** tests for wheel landings and three-pointers, and for a bounce that is recoverable.
- **Climb shortfall:** close it once the published conditions are confirmed.

**Phase 3: the place.**

- **Survey:** pin the `[verify]` coordinates against FAA 5010 data and period aerial photos.
- **Google 3D Tiles (optional layer):** use the existing `google-3d-tiles` vibe with a key. Align it to the local frame, crop today's Northerly Island park, and draw the 1990s runway over it.
- **Retro mode:** FS1-style wireframe and flat-shaded rendering.
- **Time of day and night lighting:** runway edge lights, the Loop lit up.
- **3D cockpit:** the panel as a texture, so VR works.

**Phase 4: people.**

- **Remote aircraft:** broadcast the sim state (pose, rpm, surfaces) on the attach sideband and render other pilots' Extras.
- **Formation flying.**
- **Aerobatics:** an aerobatic box over the lake with Aresti figure recognition and scoring.

**Phase 5: hangar.**

- **More airplanes as data files on the same flight model:** the Cessna 182 and the Learjet from the old Flight Simulator defaults, and the Sopwith Camel.

## Needs from the space owner

- **Arrival API key** for the sync: `ARRIVAL_TOKEN` as an environment secret, or a one-time `npm run sync -- login` on a machine with a browser.
- **Which space to use:** create a new one (`npm run sync -- create`) or put an existing id into `arrival.json`.
- **Google 3D Tiles (optional):** a Google Maps Platform key, or a Cesium Ion token in the EEA.
