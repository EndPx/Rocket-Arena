import { Schema, type } from '@colyseus/schema';

export class PlayerState extends Schema {
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('float32') z: number = 0;

  @type('float32') qx: number = 0;
  @type('float32') qy: number = 0;
  @type('float32') qz: number = 0;
  @type('float32') qw: number = 1;

  @type('float32') vx: number = 0;
  @type('float32') vy: number = 0;
  @type('float32') vz: number = 0;

  @type('uint8') boost: number = 33;
  @type('string') team: string = 'blue';
  @type('string') name: string = '';
  @type('boolean') isHost: boolean = false;
}
