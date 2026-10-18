// profiles.js — what makes each airplane itself in the vibe: its flight-model
// data, 3D model, intro film, cockpit display, sound, where the pilot sits,
// and the words on its cards. The plugin swaps the whole set when the pilot
// picks another airplane.

import EXTRA from '../sim/aircraft/extra300l.js';
import F15 from '../sim/aircraft/f15c.js';
import XW from '../sim/aircraft/xwing.js';
import { buildXwingModel } from '../render/xwingModel.js';
import { buildExtraModel } from '../render/extraModel.js';
import { buildF15Model } from '../render/f15Model.js';
import { INTROS } from '../render/intro.js';
import { CockpitSound, JetSound, XwingSound } from '../render/audio.js';

const VIEWS_HELP = ['Views', 'V  cockpit · chase · tower · fly-by    drag the mouse to look (chase: orbit)    wheel: zoom    C  centre'];
const COMMON_TAIL = [
  ['Intro', 'Space / Enter / Esc skips it'],
  ['Mouse yoke', 'Y  fly with the mouse (screen centre = neutral)'],
  ['Aircraft', 'T  next airplane: Extra 300L → F-15C Eagle → X-wing (back on runway 36)'],
  ['Sim', 'P  pause    Backspace  back to runway 36    Esc  leave the airplane'],
];

export const PROFILES = {
  extra300l: {
    id: 'extra300l',
    title: 'Extra 300L',
    spec: EXTRA,
    buildModel: buildExtraModel,
    intro: INTROS.extra300l,
    display: 'gauges',
    Sound: CockpitSound,
    chaseSize: 1,
    demo: 'platzrunde',        // the demo flight (O): a circuit with a loop
    // the avatar in the rear seat: the plugin's avatarSeat* settings apply to this one
    seat: null,
    quick: [
      'Hold <b>R</b> for full throttle, keep it straight with <b>Q</b> / <b>E</b>',
      'At 60 kt ease back on <b>S</b> (or <b>↓</b>) and it flies',
      '<b>W A S D</b> or the arrows fly it, <b>V</b> changes the view, <b>Esc</b> gets out',
    ],
    quickMobile: [
      'Engine running, 75 % power: it rolls straight and lifts off by itself',
      '<b>Left stick</b>: down climbs, up dives, sideways banks',
      'Let go and it holds the attitude · <b>right stick</b>: throttle ↑↓',
    ],
    easyOn: 'Easy mode: the wing won\'t stall, torque handled for you',
    easyTitle: 'Easy mode (L): the wing can\'t stall, rudder and bank are held against the torque',
    help: [
      ['Pitch', 'S / ↓ nose up (pull)    W / ↑ nose down (push)    + Shift: pull through the buffet'],
      ['Roll', 'A / ←  left    D / →  right'],
      ['Easy mode', 'L  on / off, any time: no stalls, rudder and bank held against the torque'],
      ['Rudder', 'Q  left    E  right    (Z / X too)    U  auto-rudder on / off'],
      ['Throttle', 'R  more    F  less    (also + / − or PgUp / PgDn)    Home idle    End full'],
      ['Brakes', 'B or .  (hold)    ,  parking brake'],
      ['Trim', ';  nose down    \'  nose up'],
      ['Prop rpm', '[  lower    ]  higher'],
      ['Engine', 'M  mixture run / cut-off    K  starter (hold, if it stopped)'],
      VIEWS_HELP,
      ['Panel', 'I  show / hide    G  reset g-meter    N  set altimeter'],
      ['Demo', 'O  watch a Platzrunde flown for you    any flight key takes over'],
      ['Carrier', 'Start: Carrier approach (settings): land on USS Nimitz\'s angled deck, no hook needed for the Extra    V  deck view'],
      ...COMMON_TAIL,
      ['Gamepad', 'left stick flies, right stick rudder / throttle, triggers brake'],
    ],
  },

  f15c: {
    id: 'f15c',
    title: 'F-15C Eagle',
    spec: F15,
    buildModel: buildF15Model,
    intro: INTROS.f15c,
    display: 'hud',
    cockpitDisplay: true,       // the large area display, live (plugin/cockpitDisplay.js)
    Sound: JetSound,
    chaseSize: 2.1,
    demo: 'carrier',           // the demo flight (O): a carrier landing
    // the avatar on the ACES II seat, upright under the bubble: body x of its root, body z, lean back (°)
    seat: { forward: F15.eye[0] + 0.22, height: F15.eye[2] + 1.32, lean: 10 },   // 20 cm under the eye line: the helmet clears the bubble
    quick: [
      'Hold <b>End</b> (or <b>R</b>) for the burners, keep it straight with <b>Q</b> / <b>E</b>',
      'At 130 kt ease back on <b>S</b> (or <b>↓</b>), then <b>G</b> brings the gear up',
      '<b>W A S D</b> or the arrows fly it, <b>V</b> changes the view, <b>Esc</b> gets out',
    ],
    quickMobile: [
      'Engines at 75 % throttle: it rolls straight, lifts off and raises the gear by itself',
      '<b>Left stick</b>: down climbs, up dives, sideways banks',
      'Let go and it holds the attitude · <b>right stick</b>: throttle ↑↓ (the top fifth is burner)',
    ],
    easyOn: 'Easy mode: α and g limited, rudder and gear handled for you',
    easyTitle: 'Easy mode (L): angle of attack and g limited, rudder, bank and gear handled',
    help: [
      ['Pitch', 'S / ↓ nose up (pull)    W / ↑ nose down (push)    + Shift: pull harder'],
      ['Roll', 'A / ←  left    D / →  right'],
      ['Easy mode', 'L  on / off: α and g limited, rudder and bank held, the gear by itself'],
      ['Rudder', 'Q  left    E  right    (Z / X too)    U  auto-rudder on / off'],
      ['Throttle', 'R  more    F  less    Home idle    End full burner    (past 80 %: afterburner)'],
      ['Gear', 'G  up / down    J  speed brake out / in    B in the air: speed brake while held'],
      ['Carrier', '/  tail hook down / up    fly the ball (amber light on the lens), catch a wire    O  watch a carrier landing    V  deck view'],
      ['Brakes', 'B or .  (hold, on the ground)    ,  parking brake'],
      ['Trim', ';  nose down    \'  nose up'],
      ['Engines', 'M  fuel off / on    K  jet fuel starter (hold, if they flamed out)'],
      VIEWS_HELP,
      ['HUD', 'I  show / hide    N  set altimeter'],
      ...COMMON_TAIL,
      ['Gamepad', 'left stick flies, right stick rudder / throttle, triggers brake'],
    ],
  },

  xwing: {
    id: 'xwing',
    title: 'X-wing',
    spec: XW,
    buildModel: buildXwingModel,
    intro: INTROS.xwing,
    display: 'hud',
    hudColor: '#ff7a4a',
    boostLabel: 'BOOST',
    Sound: XwingSound,
    chaseSize: 1.5,
    demo: null,
    lasers: true,
    seat: { forward: XW.eye[0] + 0.22, height: XW.eye[2] + 1.1, lean: 14 },
    quick: [
      'Hold <b>R</b> (past 80 %: boost) and it lifts off on its repulsors, keep it straight with <b>Q</b> / <b>E</b>',
      '<b>J</b> S-foils into attack position, <b>Space</b> fires the lasers, <b>G</b> gear',
      '<b>W A S D</b> or the arrows fly it, <b>V</b> changes the view, <b>Esc</b> gets out',
    ],
    quickMobile: [
      'Engines at 75 %: it rolls, lifts off and its S-foils open by themselves',
      '<b>Left stick</b>: down climbs, up dives, sideways banks',
      '<b>Fire</b> shoots the lasers · <b>right stick</b>: throttle ↑↓ (the top fifth is boost)',
    ],
    easyOn: 'Easy mode: limits held, rudder and gear handled for you',
    easyTitle: 'Easy mode (L): angle of attack and g limited, rudder, bank and gear handled',
    help: [
      ['Pitch', 'S / ↓ nose up    W / ↑ nose down    (reaction thrusters: a rate for the stick)'],
      ['Roll', 'A / ←  left    D / →  right'],
      ['Easy mode', 'L  on / off: limits held, rudder and bank held, the gear by itself'],
      ['Rudder', 'Q  left    E  right    (Z / X too)'],
      ['Throttle', 'R  more    F  less    Home idle    End full boost    (past 80 %: boost)'],
      ['S-foils', 'J  attack position / closed (closed: a little faster)    Space  lasers (held, S-foils open)'],
      ['Gear', 'G  up / down    B  wheel brakes'],
      ['Engines', 'M  fuel off / on    K  starter (hold)'],
      VIEWS_HELP,
      ['HUD', 'I  show / hide    N  set altimeter'],
      ...COMMON_TAIL,
      ['Gamepad', 'left stick flies, right stick rudder / throttle, A fires, triggers brake'],
    ],
  },
};

/** The choices as the editor shows them, and back. */
export const AIRCRAFT_OPTIONS = Object.values(PROFILES).map((p) => p.title);
export function profileByTitle(title) {
  return Object.values(PROFILES).find((p) => p.title === title || p.id === title) || PROFILES.extra300l;
}
export function nextProfile(p) {
  const all = Object.values(PROFILES);
  return all[(all.indexOf(p) + 1) % all.length];
}
