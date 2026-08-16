import { Schema, MapSchema, defineTypes } from '@colyseus/schema';
import { PlayerState } from './player-state.js';
import { BallState } from './ball-state.js';

export class GameState extends Schema {
  players = new MapSchema<PlayerState>();
  ball = new BallState();

  blueScore: number = 0;
  orangeScore: number = 0;
  timeRemaining: number = 300;
  phase: string = 'waiting';
}

defineTypes(GameState, {
  players: { map: PlayerState },
  ball: BallState,
  blueScore: 'uint8',
  orangeScore: 'uint8',
  timeRemaining: 'float32',
  phase: 'string',
});
