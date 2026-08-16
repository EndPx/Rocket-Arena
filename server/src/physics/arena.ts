import RAPIER from '@dimforge/rapier3d-compat';
import { getConstant } from '../../../shared/src/constants/index.js';

/**
 * Create static colliders for the arena: floor, 4 walls, ceiling.
 * Goal openings are left as gaps in the short walls (Z-axis ends).
 */
export function createArenaColliders(world: RAPIER.World): void {
  const W = getConstant('ARENA.WIDTH');
  const L = getConstant('ARENA.LENGTH');
  const H = getConstant('ARENA.HEIGHT');
  const T = getConstant('ARENA.WALL_THICKNESS');
  const goalW = getConstant('ARENA.GOAL.WIDTH');
  const goalH = getConstant('ARENA.GOAL.HEIGHT');

  // Floor (y = 0)
  const floorDesc = RAPIER.ColliderDesc.cuboid(W / 2, T / 2, L / 2)
    .setTranslation(0, -T / 2, 0)
    .setRestitution(0.3);
  world.createCollider(floorDesc);

  // Ceiling
  const ceilDesc = RAPIER.ColliderDesc.cuboid(W / 2, T / 2, L / 2)
    .setTranslation(0, H + T / 2, 0);
  world.createCollider(ceilDesc);

  // Left wall (negative X)
  const leftDesc = RAPIER.ColliderDesc.cuboid(T / 2, H / 2, L / 2)
    .setTranslation(-W / 2 - T / 2, H / 2, 0);
  world.createCollider(leftDesc);

  // Right wall (positive X)
  const rightDesc = RAPIER.ColliderDesc.cuboid(T / 2, H / 2, L / 2)
    .setTranslation(W / 2 + T / 2, H / 2, 0);
  world.createCollider(rightDesc);

  // Back wall (negative Z) - with goal opening
  // Left segment
  const backLeftW = (W - goalW) / 2;
  if (backLeftW > 0) {
    const blDesc = RAPIER.ColliderDesc.cuboid(backLeftW / 2, H / 2, T / 2)
      .setTranslation(-(W / 2 - backLeftW / 2), H / 2, -L / 2 - T / 2);
    world.createCollider(blDesc);
  }
  // Right segment
  if (backLeftW > 0) {
    const brDesc = RAPIER.ColliderDesc.cuboid(backLeftW / 2, H / 2, T / 2)
      .setTranslation(W / 2 - backLeftW / 2, H / 2, -L / 2 - T / 2);
    world.createCollider(brDesc);
  }
  // Top segment above goal
  const topSegH = (H - goalH) / 2;
  if (topSegH > 0) {
    const btDesc = RAPIER.ColliderDesc.cuboid(goalW / 2, topSegH / 2, T / 2)
      .setTranslation(0, goalH + topSegH / 2, -L / 2 - T / 2);
    world.createCollider(btDesc);
  }

  // Front wall (positive Z) - with goal opening (same structure)
  if (backLeftW > 0) {
    const flDesc = RAPIER.ColliderDesc.cuboid(backLeftW / 2, H / 2, T / 2)
      .setTranslation(-(W / 2 - backLeftW / 2), H / 2, L / 2 + T / 2);
    world.createCollider(flDesc);
  }
  if (backLeftW > 0) {
    const frDesc = RAPIER.ColliderDesc.cuboid(backLeftW / 2, H / 2, T / 2)
      .setTranslation(W / 2 - backLeftW / 2, H / 2, L / 2 + T / 2);
    world.createCollider(frDesc);
  }
  if (topSegH > 0) {
    const ftDesc = RAPIER.ColliderDesc.cuboid(goalW / 2, topSegH / 2, T / 2)
      .setTranslation(0, goalH + topSegH / 2, L / 2 + T / 2);
    world.createCollider(ftDesc);
  }

  // Goal back walls (to catch the ball inside the goal)
  const goalD = getConstant('ARENA.GOAL.DEPTH');
  // Blue goal back (negative Z)
  const bgBack = RAPIER.ColliderDesc.cuboid(goalW / 2, goalH / 2, T / 2)
    .setTranslation(0, goalH / 2, -L / 2 - goalD);
  world.createCollider(bgBack);
  // Orange goal back (positive Z)
  const ogBack = RAPIER.ColliderDesc.cuboid(goalW / 2, goalH / 2, T / 2)
    .setTranslation(0, goalH / 2, L / 2 + goalD);
  world.createCollider(ogBack);
}
