// arrestor.js — the carrier's arresting gear: four cross-deck pendants
// (wires) across the landing area, each reeved through sheaves to a
// hydraulic arresting engine below deck.
//
// A wire is caught when the tail hook's tip, low enough to sweep the deck,
// crosses it inside its span. From then on the wire pulls the hook back
// along both of its halves (a V from the deck-edge sheaves to the hook, so
// it also pulls the airplane toward the centre line). The engine is set for
// the airplane's weight and speed at engagement, as a Mk 7's constant
// run-out valve is: an even pull that stops it in about the design
// run-out. Once stopped, the wire holds against the engines and draws the
// airplane back a little until the hook is raised. A hook that touched the
// deck and passed every wire is a bolter.

const RUNOUT = 78;            // m: set short of the ~100 m design run-out [pub, Mk 7 Mod 3], which the engines
                              // at military power (a pilot goes to full power as the wheels touch) use up
const RAMP = 0.12;            // s for the pull to build as the wire pays out
const MAX_DECEL = 5 * 9.80665;
const HOLD_K = 60000;         // N/m: the wire holding a stopped airplane
const REACH = 0.25;           // m: a hook tip this far above the deck still catches a wire

export class Arrestor {
  /** @param {object} carrier  world/carrier.js buildCarrier() */
  constructor(carrier) {
    this.carrier = carrier;
    this.reset();
  }

  reset() {
    this.engaged = null;      // { wire, force, t, stopped, holdAt }
    this.prevAlong = null;    // the hook tip's distance along the landing line, last step
    this.touched = false;     // has the hook swept the deck on this pass?
    this.bolter = false;
    this.events = [];
  }

  /**
   * @param {number[]} tip   hook tip, NED (m)
   * @param {number[]} vel   the airplane's velocity, NED (m/s)
   * @param {number} mass
   * @param {boolean} hookDown
   * @param {number} dt
   * @returns {number[]|null} the wire's pull on the hook, NED (N), or null
   */
  update(tip, vel, mass, hookDown, dt) {
    const c = this.carrier;
    const h = -tip[2];
    const along = c.along(tip[0], tip[1]);
    const lateral = c.lateral(tip[0], tip[1]);
    const onDeck = c.deckAt(tip[0], tip[1], tip[2]) != null;
    const low = onDeck && h - c.deckH < REACH;
    const vAlong = vel[0] * c.axis[0] + vel[1] * c.axis[1];

    if (this.engaged && !hookDown) {
      // hook up: the wire drops off and retracts
      this.events.push({ e: 'wireReleased', wire: this.engaged.wire.index });
      this.engaged = null;
      this.prevAlong = along;
      return null;
    }

    if (!this.engaged) {
      if (hookDown && low) this.touched = true;
      if (hookDown && low && this.prevAlong != null && vAlong > 1) {
        for (const w of c.wires) {
          if (this.prevAlong < w.along && along >= w.along && Math.abs(lateral) <= c.data.wireHalfSpan) {
            // the arresting engine is set for this airplane: an even pull that stops it in the run-out
            const force = Math.min(MAX_DECEL * mass, (mass * vAlong * vAlong) / (2 * RUNOUT));
            this.engaged = { wire: w, force, t: 0, stopped: false, holdAt: null, v0: vAlong, runout: 0 };
            this.events.push({ e: 'trap', wire: w.index, kt: vAlong / 0.514444 });
            break;
          }
        }
      }
      // past the last wire with the hook on the deck and nothing caught: bolter
      const last = c.wires[c.wires.length - 1].along;
      if (!this.engaged && !this.bolter && this.touched && this.prevAlong != null && this.prevAlong < last + 6 && along >= last + 6) {
        this.bolter = true;
        this.events.push({ e: 'bolter' });
      }
      // off the deck again (a go-around): the next pass starts afresh
      if (!onDeck) { this.touched = false; this.bolter = false; }
      this.prevAlong = along;
      if (!this.engaged) return null;
    }

    const g = this.engaged;
    g.t += dt;
    g.runout = along - g.wire.along;
    // the wire's two halves run from the hook to the sheaves at the deck edges
    let fx = 0, fy = 0;
    for (const end of g.wire.ends) {
      const dx = end[0] - tip[0], dy = end[1] - tip[1];
      const l = Math.hypot(dx, dy) || 1;
      fx += dx / l; fy += dy / l;
    }
    // the share of the pull that acts back along the landing line
    const back = -(fx * c.axis[0] + fy * c.axis[1]);
    let pull;
    if (!g.stopped) {
      pull = g.force * Math.min(1, g.t / RAMP);
      if (vAlong < 0.4 && g.t > 0.5) {
        g.stopped = true;
        g.holdAt = g.runout - 0.4;     // the wire draws it back a little
        this.events.push({ e: 'stopped', wire: g.wire.index, runout: g.runout });
      }
    } else {
      pull = Math.max(0, Math.min(g.force, HOLD_K * (g.runout - g.holdAt) + 8000 * vAlong));
    }
    const k = pull / Math.max(back, 0.3);
    return [fx * k, fy * k, 0];
  }
}
