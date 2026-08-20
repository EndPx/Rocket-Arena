import * as THREE from 'three';

/** Client-only art direction. None of these values participate in collision or arena identity. */
export const DAYLIGHT_SCENE_STYLE = Object.freeze({
  sky: 0x56b7ef,
  skyZenith: 0x187bc5,
  horizon: 0xc7e8f2,
  haze: 0x9fcfe2,
  fogNear: 88,
  fogFar: 230,
  cameraFar: 280,
  exposure: 1.18,
});

export const ARENA_PRESENTATION_STYLE = Object.freeze({
  turf: {
    size: 96,
    repeatX: 6,
    repeatY: 10,
    base: new THREE.Color(0x176b3c),
    checkerLift: 0.075,
    mowLift: 0.055,
    fiberLift: 0.035,
  },
  graphite: 0x121a22,
  graphiteMid: 0x24303a,
  concrete: 0xa9b4b8,
  concreteDark: 0x66747b,
  cageGlass: 0xb7e5f1,
  cageLine: 0x9ed6e6,
  floodlight: 0xeaf8ff,
  skylineGlass: 0x2b759b,
  skylineDark: 0x173a51,
  windowLight: 0xcdf2ff,
  turfLine: 0xf1f8f2,
  blue: 0x2788ff,
  blueLight: 0x78c8ff,
  orange: 0xff6b21,
  orangeLight: 0xffbc6b,
});
