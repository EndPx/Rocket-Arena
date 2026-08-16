import { Schema, defineTypes } from '@colyseus/schema';

export class BallState extends Schema {
  x: number = 0;
  y: number = 0;
  z: number = 0;

  qx: number = 0;
  qy: number = 0;
  qz: number = 0;
  qw: number = 1;

  vx: number = 0;
  vy: number = 0;
  vz: number = 0;
}

defineTypes(BallState, {
  x: 'float32',
  y: 'float32',
  z: 'float32',
  qx: 'float32',
  qy: 'float32',
  qz: 'float32',
  qw: 'float32',
  vx: 'float32',
  vy: 'float32',
  vz: 'float32',
});
