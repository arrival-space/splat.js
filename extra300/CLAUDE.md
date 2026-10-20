# Working on the flight vibe

## Visual checks (screenshots of the live space or the harness)

Only judge a screenshot once Google's 3D tiles have finished loading for that view. Low-resolution
tiles still streaming in are not representative: their ground can be metres off, and they show
blobs where buildings and paving will be.

- After placing the camera, wait until the tiles vibe has nothing pending for a few seconds in a row:
  `t._loadSlots + t._loadQueue.length + (t._revealQueue?.length || 0) === 0`, where `t` is the
  tiles vibe (`vibe._tilesVibe()`). The on-screen count reads "N tiles · 0 loading" with no "queued".
- Every camera move starts new loads: wait again before the next screenshot.
- Never conclude anything about ground height, sunk or floating objects, or the look of the scenery
  from a frame taken while tiles are still loading.
