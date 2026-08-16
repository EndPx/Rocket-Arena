import { Schema, MapSchema, type } from '@colyseus/schema';
import { PlayerState } from './player-state.js';
import { BallState } from './ball-state.js';

export class GameState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type(BallState) ball = new BallState();

  @type('uint8') blueScore: number = 0;
  @type('uint8') orangeScore: number = 0;
  @type('float32') timeRemaining: number = 300;
  @type('string') phase: string = 'waiting';
}
