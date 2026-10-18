// sceneMaps.js — the camera's copies of the opaque scene (its colour and depth) for the effects
// drawn after it: the lake's reflections, the clouds' composite. Several of them can ask; the
// copies stay on until the last one lets go. Through the room's CameraFrame when it has one (HDR),
// else the camera component's own grab passes.

const holders = new Map();   // holder → { cam, color, depth }
let frameState = null;       // the CameraFrame's own settings, restored when nobody needs the maps

function apply(app) {
  const frame = app.customTravelCenter?.cameraFrame;
  const want = { color: false, depth: false };
  for (const h of holders.values()) { want.color ||= h.color; want.depth ||= h.depth; }
  if (frame?.rendering) {
    if (!frameState) frameState = { frame, color: frame.rendering.sceneColorMap, depth: frame.rendering.sceneDepthMap };
    const color = want.color || frameState.color, depth = want.depth || frameState.depth;
    if (frame.rendering.sceneColorMap !== color || frame.rendering.sceneDepthMap !== depth) {
      frame.rendering.sceneColorMap = color;
      frame.rendering.sceneDepthMap = depth;
      frame.update?.();
    }
    if (!holders.size) frameState = null;
  }
}

/** `holder` needs the maps of camera entity `cam` ({ color, depth }); call again when the camera changes. */
export function requestSceneMaps(app, holder, cam, { color = false, depth = true } = {}) {
  const prev = holders.get(holder);
  if (prev && prev.cam === cam && prev.color === color && prev.depth === depth) return;
  if (prev) releaseSceneMaps(app, holder);
  holders.set(holder, { cam, color, depth });
  if (!app.customTravelCenter?.cameraFrame && cam?.camera) {
    if (color) cam.camera.requestSceneColorMap(true);
    if (depth) cam.camera.requestSceneDepthMap(true);
  }
  apply(app);
}

export function releaseSceneMaps(app, holder) {
  const h = holders.get(holder);
  if (!h) return;
  holders.delete(holder);
  if (!app.customTravelCenter?.cameraFrame && h.cam?.camera) {
    if (h.color) h.cam.camera.requestSceneColorMap(false);
    if (h.depth) h.cam.camera.requestSceneDepthMap(false);
  }
  apply(app);
}
