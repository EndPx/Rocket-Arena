import { Schema, defineTypes } from '@colyseus/schema';
import { CAR } from '../constants/car.js';
import { TEAMS, type Team } from '../types/room.js';
import type { QuaternionTuple, Vector3Tuple } from '../types/snapshot.js';

export const MIN_AUTHORITATIVE_BOOST = 0 as const;
export const MAX_AUTHORITATIVE_BOOST = 100 as const;

export interface AuthoritativePlayerProjection {
  readonly sessionId: string;
  readonly acceptedJoinOrdinal: number;
  readonly team: Team;
  readonly name: string;
  readonly isHost: boolean;
  readonly position: Vector3Tuple;
  readonly rotation: QuaternionTuple;
  readonly linearVelocity: Vector3Tuple;
  readonly angularVelocity?: Vector3Tuple;
  readonly boost: number;
}

function finite(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be finite.`);
  return value;
}

function finiteVector(value: readonly number[], length: number, field: string): readonly number[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${field} must contain ${length} components.`);
  }
  return value.map((component, index) => finite(component, `${field}[${index}]`));
}

export function clampAuthoritativeBoost(value: number): number {
  finite(value, 'boost');
  return Math.max(MIN_AUTHORITATIVE_BOOST, Math.min(MAX_AUTHORITATIVE_BOOST, value));
}

/**
 * Internal server projection for one represented Human_Player. No constructor
 * or method accepts a client input payload as authoritative state.
 */
export class PlayerState extends Schema {
  declare sessionId: string;
  declare acceptedJoinOrdinal: number;

  declare x: number;
  declare y: number;
  declare z: number;

  declare qx: number;
  declare qy: number;
  declare qz: number;
  declare qw: number;

  declare vx: number;
  declare vy: number;
  declare vz: number;

  declare wx: number;
  declare wy: number;
  declare wz: number;

  declare boost: number;
  declare team: Team;
  declare name: string;
  declare isHost: boolean;

  constructor() {
    super();
    this.sessionId = '';
    this.acceptedJoinOrdinal = 0;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.qx = 0;
    this.qy = 0;
    this.qz = 0;
    this.qw = 1;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.wx = 0;
    this.wy = 0;
    this.wz = 0;
    this.boost = clampAuthoritativeBoost(CAR.BOOST.START_AMOUNT);
    this.team = 'blue';
    this.name = '';
    this.isHost = false;
  }

  /** Validate the complete server-owned candidate before committing any field. */
  applyAuthoritativeProjection(projection: AuthoritativePlayerProjection): this {
    if (typeof projection.sessionId !== 'string' || projection.sessionId.length === 0) {
      throw new TypeError('sessionId must be a non-empty string.');
    }
    if (
      !Number.isSafeInteger(projection.acceptedJoinOrdinal)
      || projection.acceptedJoinOrdinal < 0
      || projection.acceptedJoinOrdinal > 0xffff_ffff
    ) {
      throw new TypeError('acceptedJoinOrdinal must fit an unsigned 32-bit integer.');
    }
    if (!TEAMS.some((team) => team === projection.team)) {
      throw new TypeError(`Invalid authoritative team: ${String(projection.team)}.`);
    }
    if (typeof projection.name !== 'string') throw new TypeError('name must be a string.');
    if (typeof projection.isHost !== 'boolean') throw new TypeError('isHost must be a boolean.');

    const position = finiteVector(projection.position, 3, 'position');
    const rotation = finiteVector(projection.rotation, 4, 'rotation');
    if (rotation.every((component) => component === 0)) {
      throw new TypeError('rotation quaternion cannot be zero.');
    }
    const linearVelocity = finiteVector(projection.linearVelocity, 3, 'linearVelocity');
    const angularVelocity = finiteVector(
      projection.angularVelocity ?? [0, 0, 0],
      3,
      'angularVelocity',
    );
    const boost = clampAuthoritativeBoost(projection.boost);

    this.sessionId = projection.sessionId;
    this.acceptedJoinOrdinal = projection.acceptedJoinOrdinal;
    this.team = projection.team;
    this.name = projection.name;
    this.isHost = projection.isHost;
    [this.x, this.y, this.z] = position;
    [this.qx, this.qy, this.qz, this.qw] = rotation;
    [this.vx, this.vy, this.vz] = linearVelocity;
    [this.wx, this.wy, this.wz] = angularVelocity;
    this.boost = boost;
    return this;
  }

  static fromAuthoritative(projection: AuthoritativePlayerProjection): PlayerState {
    return new PlayerState().applyAuthoritativeProjection(projection);
  }
}

defineTypes(PlayerState, {
  sessionId: 'string',
  acceptedJoinOrdinal: 'uint32',
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
  wx: 'float32',
  wy: 'float32',
  wz: 'float32',
  boost: 'float32',
  team: 'string',
  name: 'string',
  isHost: 'boolean',
});
