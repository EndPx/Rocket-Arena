import { Schema, defineTypes } from '@colyseus/schema';
import type { QuaternionTuple, Vector3Tuple } from '../types/snapshot.js';

export interface AuthoritativeBallProjection {
  readonly position: Vector3Tuple;
  readonly rotation: QuaternionTuple;
  readonly linearVelocity: Vector3Tuple;
}

function finiteTuple(
  value: readonly number[],
  length: number,
  field: string,
): readonly number[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${field} must contain ${length} components.`);
  }
  return value.map((component, index) => {
    if (!Number.isFinite(component)) {
      throw new TypeError(`${field}[${index}] must be finite.`);
    }
    return component;
  });
}

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

  /** Validate the complete server-owned ball candidate before committing it. */
  applyAuthoritativeProjection(projection: AuthoritativeBallProjection): this {
    const position = finiteTuple(projection.position, 3, 'ball.position');
    const rotation = finiteTuple(projection.rotation, 4, 'ball.rotation');
    if (rotation.every((component) => component === 0)) {
      throw new TypeError('ball.rotation quaternion cannot be zero.');
    }
    const linearVelocity = finiteTuple(
      projection.linearVelocity,
      3,
      'ball.linearVelocity',
    );

    [this.x, this.y, this.z] = position;
    [this.qx, this.qy, this.qz, this.qw] = rotation;
    [this.vx, this.vy, this.vz] = linearVelocity;
    return this;
  }

  static fromAuthoritative(projection: AuthoritativeBallProjection): BallState {
    return new BallState().applyAuthoritativeProjection(projection);
  }
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
