// seatPose.js — the pilot as the seated animation leaves them, corrected each frame after it: the
// "driving" pose holds a wheel at the chest and stretches the legs to pedals far down (the hands float,
// the feet go through the floor). Here the hands come down to the stick and the throttle, the right one
// moving with the stick, and the knees come up.

// rotations (degrees, the bone's own x, y, z) added to the animation's, per bone of the Ready Player Me rig
export const SEAT_POSE = {
  RightArm: [55, -20, 0],      // down and in: the hand in front of the lap, on the stick
  RightForeArm: [-35, 0, 0],   // the elbow opened: reaching forward to it
  LeftArm: [45, 25, -35],      // down and out to the left: on the throttle
  LeftForeArm: [-10, 0, 0],
  RightUpLeg: [-12, 0, 0],     // the knees up
  LeftUpLeg: [-12, 0, 0],
  RightLeg: [10, 0, 0],        // the feet lifted, forward onto the pedals
  LeftLeg: [10, 0, 0],
};

// the right arm following the stick: degrees per full deflection on the upper arm (roll: to the right, pitch: pulled)
export const STICK_ARM = { roll: [0, 0, 12], pitch: [-12, 0, 0] };

export class SeatPose {
  constructor() {
    this.pose = structuredClone(SEAT_POSE);   // (tunable live: vibe._seatPose.pose)
    this.stickArm = structuredClone(STICK_ARM);
    this._mesh = null;
    this._bones = null;
    this._q = new pc.Quat();
  }

  /** After the animation, this frame: `mesh` the avatar's (ArrivalSpace.getPlayerMesh), `stick` { x: roll, y: pitch } −1…1. */
  apply(mesh, stick = { x: 0, y: 0 }) {
    if (!mesh) return;
    if (this._mesh !== mesh) {
      this._mesh = mesh;
      this._bones = {};
      for (const name of Object.keys(this.pose)) this._bones[name] = mesh.findByName(name);
    }
    for (const [name, d] of Object.entries(this.pose)) {
      const b = this._bones[name];
      if (!b) continue;
      let [x, y, z] = d;
      if (name === 'RightArm') {
        const r = this.stickArm.roll, p = this.stickArm.pitch;
        x += r[0] * stick.x + p[0] * stick.y; y += r[1] * stick.x + p[1] * stick.y; z += r[2] * stick.x + p[2] * stick.y;
      }
      if (!x && !y && !z) continue;
      this._q.setFromEulerAngles(x, y, z);
      const q = b.getLocalRotation().clone().mul(this._q);
      b.setLocalRotation(q);
    }
  }
}

