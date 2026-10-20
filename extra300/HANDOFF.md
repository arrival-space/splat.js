# Handoff: the flight simulator vibe

State as of 2026-10-20, from a cloud Claude Code session. Everything below is committed. The live space is
https://arrival.space/42485456_1041 (space id `42485456_1041`), and it runs exactly this code.

## Where the code should live

The project grew inside `arrival-space/splat.js` (folder `extra300/`, branch
`claude/open-source-flight-sims-yd4upq`). That was never intended: it does not belong to splat.js.
It is self-contained (nothing outside `extra300/` is used). The owner works on it locally in
`C:\Dev\arrival.space\arrival-plugins-public\workspaces\flight-simulator`; copy this folder's
contents there. Note that `arrival-plugins` git-ignores `/workspaces` (local CLI workspaces), so the
code is not tracked there unless that is decided otherwise.

## Setup on a new machine

```
npm install
npm run sync -- setup      # installs the arrival CLI into .arrival-cli/
npm run sync -- login      # browser sign-in (or ARRIVAL_TOKEN=<api key>)
npm test                   # 184 tests, all passing at handoff
```

`space/space/entities/google-3d-tiles.json` holds the Google Maps API key. It is git-ignored; the
first `npm run sync -- status` (or push) pulls it from the space. Never commit it or print the key.

## The workflow after every change

1. `npm test`
2. `npm run sync -- push` (tests, builds, pulls the space, stages our files, validates, pushes)
3. commit the source
4. commit `space/space` as "space snapshot after sync"
5. push the branch

What the sync owns versus what the space owns is in the header of `scripts/sync.mjs`. Since this
session: the spawn point and the airport / airplane vibe entities are the space's (made only when
missing); the blue-white Extra (`flight-aircraft-extra300l-blue`) is created whenever missing.

## How the owner likes to work

- Do exactly what was asked, no widened scope; short updates; careful, verified work.
- Visual checks only once Google's tiles have finished loading (see CLAUDE.md).
- Turquoise (`#3fc5cc`, text `#6fdcdc`) is the signature colour; red only for warnings (Restart).
- Ask before anything hard to reverse.

## Map of the code

- `src/plugin/extra300.js`: the flight vibe (start, places, boarding, intro, camera, weather, Google tiles glue,
  parked airplanes, seat pose hook, keyboard). The big one.
- `src/plugin/hud.js`: all DOM UI (top bar, panels, phone stick, loading screen, intro captions, buttons).
- `src/plugin/parkedAircraft.js`: parked airplanes (stands, bake to a draw call per material, shadow decals, LOD).
- `src/plugin/seatPose.js`: corrects the platform's "driving" seated animation (hands on stick and throttle, knees up).
- `src/plugin/aircraftVibe.js`, `airportVibe.js`, `flightRegistry.js`, `tuning.js`: the small airplane and
  airport vibes and how the flight vibe reads them ("Park at" lives in the airplane vibe).
- `src/sim/`: flight model; `src/instruments/`: panels and HUD drawing; `src/input/controlMapper.js`: keys,
  pad, touch, easy mode, auto trim.
- `src/world/`: airports (Meigs, Innsbruck, Renton, any airfield found by search), flatten mask, stands.
- `src/render/`: models (baked), intro shots and framing, camera rig.
- `scripts/tilesWater.mjs`: patches applied to the Google 3D Tiles vibe at sync (loading, flattening,
  water, sunset); anchors must match `space/reference/examples/google-3d-tiles.mjs` exactly once.

## Recent work (newest first)

- Seated pilot pose correction (`seatPose.js`): local only, other visitors still see the plain driving pose.
- Turquoise UI; F-15 ejection seat sunk under the canopy; Shift / Ctrl throttle (pull-harder moved to Alt).
- Loading screen before the intro; the spawn point no longer overwritten by the sync; after the load
  intro the visitor stays at the spawn point.
- No fly prompt / E boarding in free camera.
- Google tiles flattened only on runway and taxiways plus a disc under each parked airplane (aprons as photographed).
- Parked airplanes: per airport via the airplane vibe's "Park at" (its position in the space), Innsbruck default
  stands (small ones on the pad by the start, the 777 on the main apron), shadow decals, merged meshes, distance LOD.
- Start engine button on boarding; phone UI (own stick, two-row top bar, no side buttons, Fly button).
- Intro framing for portrait phones; address keeps the place (`?airport=`).

## Open / next

- Add an F-22 from the owner's assets (`...\workspaces\flight-simulator\assets\f-22-raptor-fighter-jet-free`):
  follow how the F-15 is built (Blender script → baked model in `src/render/data`, a spec in `src/sim/aircraft`,
  a profile in `src/plugin/profiles.js`, a sound, an intro); or load the GLB directly if that is wanted.
- The seat pose was tuned for the Extra's rear seat; check it in the F-15, X-wing and 777.
- Runway slope at LOWG is flat in our runway versus ~4 m in reality (offered, not requested).
- Where the project's git home should be (see above).
