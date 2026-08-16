import RAPIER from '@dimforge/rapier3d-compat';
import { getConstant } from '@rocket-arena/shared/constants';
import { resetCarPhysicsState, type CarPhysicsState } from '../physics/car.js';

/**
 * Create goal sensor colliders (Rapier sensors that detect ball entry).
 * Returns handles for checking intersections.
 */
export function createGoalSensors(world: RAPIER.World): { blueGoalSensor: RAPIER.Collider; orangeGoalSensor: RAPIER.Collider } {
  const L = getConstant('ARENA.LENGTH');
  const goalW = getConstant('ARENA.GOAL.WIDTH');
  const goalH = getConstant('ARENA.GOAL.HEIGHT');
  const goalD = getConstant('ARENA.GOAL.DEPTH');
  const sensorInset = getConstant('ARENA.GOAL.SENSOR_INSET');

  // Blue goal sensor (negative Z end)
  const blueDesc = RAPIER.ColliderDesc.cuboid(goalW / 2 - sensorInset, goalH / 2 - sensorInset, goalD / 2)
    .setTranslation(0, goalH / 2, -L / 2 - goalD / 2)
    .setSensor(true);
  const blueGoalSensor = world.createCollider(blueDesc);

  // Orange goal sensor (positive Z end)
  const orangeDesc = RAPIER.ColliderDesc.cuboid(goalW / 2 - sensorInset, goalH / 2 - sensorInset, goalD / 2)
    .setTranslation(0, goalH / 2, L / 2 + goalD / 2)
    .setSensor(true);
  const orangeGoalSensor = world.createCollider(orangeDesc);

  return { blueGoalSensor, orangeGoalSensor };
}

/**
 * Check if ball is inside a goal sensor by checking ball position against goal bounds.
 * Simpler and more reliable than Rapier intersection events for a single ball.
 */
export function checkGoal(ballBody: RAPIER.RigidBody): 'blue' | 'orange' | null {
  const pos = ballBody.translation();
  const L = getConstant('ARENA.LENGTH');
  const goalW = getConstant('ARENA.GOAL.WIDTH');
  const goalH = getConstant('ARENA.GOAL.HEIGHT');
  const goalD = getConstant('ARENA.GOAL.DEPTH');
  const ballR = getConstant('BALL.RADIUS');

  // Ball center must be past the goal line and within goal bounds
  // Blue goal: ball Z < -L/2 (past blue end)
  if (pos.z < -L / 2 && pos.z > -L / 2 - goalD &&
      Math.abs(pos.x) < goalW / 2 - ballR &&
      pos.y < goalH - ballR && pos.y > ballR) {
    return 'orange'; // Orange scored (ball in blue's goal)
  }

  // Orange goal: ball Z > L/2 (past orange end)
  if (pos.z > L / 2 && pos.z < L / 2 + goalD &&
      Math.abs(pos.x) < goalW / 2 - ballR &&
      pos.y < goalH - ballR && pos.y > ballR) {
    return 'blue'; // Blue scored (ball in orange's goal)
  }

  return null;
}

/**
 * Reset ball and cars to kickoff positions.
 */
export function resetToKickoff(
  ballBody: RAPIER.RigidBody,
  carBodies: Map<string, { body: RAPIER.RigidBody; jumpState: CarPhysicsState }>,
  players: Map<string, { team: string }>,
  getKickoffPosition: (sessionId: string, team: string) => { x: number; y: number; z: number }
): void {
  const ballRadius = getConstant('BALL.RADIUS');

  // Reset ball to center
  ballBody.setTranslation({
    x: 0,
    y: ballRadius + getConstant('BALL.SPAWN_CLEARANCE'),
    z: 0,
  }, true);
  ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
  ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);

  // Reset cars
  for (const [sessionId, carEntry] of carBodies) {
    const playerData = players.get(sessionId);
    if (!playerData) continue;

    const pos = getKickoffPosition(sessionId, playerData.team);
    const rotation = playerData.team === 'orange'
      ? { x: 0, y: 1, z: 0, w: 0 }
      : { x: 0, y: 0, z: 0, w: 1 };

    carEntry.body.setTranslation(pos, true);
    carEntry.body.setRotation(rotation, true);
    carEntry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    carEntry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    resetCarPhysicsState(carEntry.jumpState);
  }
}
