import { initPhysics, createWorld } from './world.js';
import { createArenaColliders } from './arena.js';
import { createBall } from './ball.js';
import { getConstant } from '../../../shared/src/constants/index.js';

async function main() {
  await initPhysics();
  const world = createWorld();
  createArenaColliders(world);

  // Spawn ball at height 10
  const ball = createBall(world, { x: 0, y: 10, z: 0 });
  const timestep = getConstant('PHYSICS.TIMESTEP');

  console.log('--- Ball Bounce Test ---');
  console.log(`Gravity: ${getConstant('PHYSICS.GRAVITY')} m/s^2`);
  console.log(`Ball mass: ${getConstant('BALL.MASS')} kg, restitution: ${getConstant('BALL.RESTITUTION')}`);
  console.log(`Timestep: ${timestep}s (${Math.round(1 / timestep)} Hz)`);
  console.log('');

  for (let i = 0; i < 300; i++) {
    world.step();
    if (i % 10 === 0) {
      const pos = ball.translation();
      const vel = ball.linvel();
      console.log(`Frame ${i.toString().padStart(3)}: Y=${pos.y.toFixed(3)} velY=${vel.y.toFixed(3)}`);
    }
  }

  console.log('\n--- Test Complete ---');
}

main().catch(console.error);
