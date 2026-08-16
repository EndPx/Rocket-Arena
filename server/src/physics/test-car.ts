import { initPhysics, createWorld } from './world.js';
import { createArenaColliders } from './arena.js';
import { createCar, applyCarPhysics } from './car.js';
import { getConstant } from '../../../shared/src/constants/index.js';
import type { InputPayload } from '../../../shared/src/types/input.js';

async function main() {
  await initPhysics();
  const world = createWorld();
  createArenaColliders(world);

  // Spawn car slightly above floor
  const carHeight = getConstant('CAR.BODY.HEIGHT');
  const car = createCar(world, { x: 0, y: carHeight / 2 + 0.1, z: 0 });
  const jumpState = { count: 0 };

  const forwardInput: InputPayload = { throttle: 1, steer: 0, jump: false, boost: false };
  const turnInput: InputPayload = { throttle: 1, steer: 1, jump: false, boost: false };

  console.log('=== SCENARIO A: Full throttle forward 120 frames ===');
  for (let i = 0; i < 120; i++) {
    applyCarPhysics(world, car, forwardInput, jumpState);
    world.step();
    if (i % 20 === 0) {
      const pos = car.translation();
      const vel = car.linvel();
      const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
      console.log(`  Frame ${i.toString().padStart(3)}: Z=${pos.z.toFixed(2)} speed=${speed.toFixed(2)} m/s`);
    }
  }

  // Reset car position for scenario B
  car.setTranslation({ x: 0, y: carHeight / 2 + 0.1, z: 0 }, true);
  car.setLinvel({ x: 0, y: 0, z: 0 }, true);
  car.setAngvel({ x: 0, y: 0, z: 0 }, true);
  car.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);

  console.log('\n=== SCENARIO B: Full throttle + full steer (curved path) ===');
  for (let i = 0; i < 120; i++) {
    applyCarPhysics(world, car, turnInput, jumpState);
    world.step();
    if (i % 20 === 0) {
      const pos = car.translation();
      const vel = car.linvel();
      const lateralSpeed = Math.abs(vel.x); // rough lateral check
      console.log(`  Frame ${i.toString().padStart(3)}: X=${pos.x.toFixed(2)} Z=${pos.z.toFixed(2)} lateralVel=${lateralSpeed.toFixed(2)}`);
    }
  }

  // Check lateral grip is working
  const finalVel = car.linvel();
  const finalLateral = Math.abs(finalVel.x);
  const finalForward = Math.abs(finalVel.z);
  console.log(`\n  Final: lateralVel=${finalLateral.toFixed(2)} forwardVel=${finalForward.toFixed(2)}`);
  console.log(`  Grip working: lateral < forward? ${finalLateral < finalForward ? 'YES' : 'NO — grip too low!'}`);

  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
