import assert from 'node:assert/strict';
import type RAPIER from '@dimforge/rapier3d-compat';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
} from '@rocket-arena/shared';
import { getConstant } from '../../../shared/src/constants/index.js';
import type { InputPayload } from '../../../shared/src/types/input.js';
import { createArenaColliders } from './arena.js';
import {
  applyCarPhysics,
  createCar,
  createCarPhysicsState,
  recoverCarBodyAfterStep,
  recoverCarBodyBeforeStep,
  resetCarPhysicsState,
  synchronizeCarInputState,
  type CarPhysicsState,
} from './car.js';
import { createWorld, initPhysics } from './world.js';

interface Scenario {
  world: RAPIER.World;
  car: RAPIER.RigidBody;
  state: CarPhysicsState;
  groundY: number;
}

const TIMESTEP = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.physics.fixedStepSeconds,
);
const NEUTRAL: InputPayload = {
  throttle: 0,
  steer: 0,
  jump: false,
  boost: false,
};

function input(jump: boolean, jumpSequence?: number): InputPayload {
  return { ...NEUTRAL, jump, ...(jumpSequence === undefined ? {} : { jumpSequence }) };
}

function step(scenario: Scenario, payload: InputPayload): void {
  recoverCarBodyBeforeStep(scenario.car);
  applyCarPhysics(scenario.world, scenario.car, payload, scenario.state);
  scenario.world.step();
  recoverCarBodyAfterStep(scenario.car);
}

function createScenario(): Scenario {
  const world = createWorld();
  let ownershipTransferred = false;
  try {
    createArenaColliders(world);
    const groundY = getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.car.collider.height,
    ) / 2 + getConstant('ARENA.KICKOFF.SPAWN_CLEARANCE');
    const car = createCar(world, { x: 0, y: groundY, z: 0 });
    const state = createCarPhysicsState();

    for (let frame = 0; frame < Math.round(0.5 / TIMESTEP); frame++) {
      recoverCarBodyBeforeStep(car);
      world.step();
      recoverCarBodyAfterStep(car);
    }
    resetCarPhysicsState(state);
    ownershipTransferred = true;
    return { world, car, state, groundY };
  } finally {
    if (!ownershipTransferred) world.free();
  }
}

function withScenario<T>(run: (scenario: Scenario) => T): T {
  const scenario = createScenario();
  try {
    return run(scenario);
  } finally {
    scenario.world.free();
  }
}

function holdThroughLanding(scenario: Scenario, sequence: number): number {
  const held = input(true, sequence);
  step(scenario, held);
  assert.ok(scenario.car.linvel().y > 2, `sequence ${sequence} did not launch`);

  let apex = scenario.car.translation().y;
  let airborneSeen = false;
  let rearmed = false;
  for (let frame = 0; frame < Math.round(4 / TIMESTEP); frame++) {
    step(scenario, held);
    apex = Math.max(apex, scenario.car.translation().y);
    airborneSeen ||= !scenario.state.grounded;
    if (airborneSeen && scenario.state.grounded && scenario.state.count === 0) {
      rearmed = true;
      break;
    }
  }

  assert.ok(rearmed, `sequence ${sequence} did not land and rearm`);
  const landingY = scenario.car.translation().y;
  for (let frame = 0; frame < Math.round(0.25 / TIMESTEP); frame++) step(scenario, held);
  assert.equal(scenario.state.count, 0, 'held Space must not retrigger after landing');
  assert.ok(
    scenario.car.translation().y <= landingY + getConstant('CAR.GROUND.CONTACT_MARGIN'),
    'held Space launched the car again after landing',
  );

  step(scenario, input(false, sequence));
  return apex - scenario.groundY;
}

function runRepeatedLandingCycles(): { cycles: number; fifthApex: number; minApex: number } {
  return withScenario((scenario) => {
    const apexes: number[] = [];

    // **Validates: Requirements 4**
    for (let sequence = 1; sequence <= 10; sequence++) {
      apexes.push(holdThroughLanding(scenario, sequence));
    }

    assert.ok(apexes.every((apex) => apex > 1), `weak repeated jump: ${apexes.join(', ')}`);
    return {
      cycles: apexes.length,
      fifthApex: apexes[4],
      minApex: Math.min(...apexes),
    };
  });
}

function runCollapsedRapidTap(): number {
  return withScenario((scenario) => {
    // Keyup won the boolean race, but the incremented sequence must survive.
    step(scenario, input(false, 1));
    const verticalVelocity = scenario.car.linvel().y;
    assert.ok(verticalVelocity > 2, 'collapsed rapid tap did not trigger a jump');
    assert.equal(scenario.state.lastJumpSequence, 1);
    return verticalVelocity;
  });
}

function runAirbornePressDiscard(): number {
  return withScenario((scenario) => {
    step(scenario, input(false, 1));
    for (let frame = 0; frame < 5; frame++) step(scenario, input(false, 1));
    assert.equal(scenario.state.grounded, false, 'scenario must be airborne before second press');

    step(scenario, input(false, 2));
    assert.equal(scenario.state.lastJumpSequence, 2, 'airborne sequence was not consumed');

    let landed = false;
    for (let frame = 0; frame < Math.round(4 / TIMESTEP); frame++) {
      step(scenario, input(false, 2));
      if (scenario.state.grounded && scenario.state.count === 0) {
        landed = true;
        break;
      }
    }
    assert.ok(landed, 'airborne-press scenario did not land');

    let postLandingApex = scenario.car.translation().y;
    for (let frame = 0; frame < Math.round(0.5 / TIMESTEP); frame++) {
      step(scenario, input(false, 2));
      postLandingApex = Math.max(postLandingApex, scenario.car.translation().y);
    }
    assert.ok(
      postLandingApex <= scenario.groundY + getConstant('CAR.GROUND.CONTACT_MARGIN'),
      'airborne press queued an automatic landing jump',
    );
    return postLandingApex;
  });
}

function runKickoffSynchronization(): void {
  withScenario((scenario) => {
    const heldAtReset = input(true, 7);
    synchronizeCarInputState(scenario.state, heldAtReset);
    resetCarPhysicsState(scenario.state);
    step(scenario, heldAtReset);

    assert.equal(scenario.state.count, 0, 'kickoff/reset must not replay a held sequence');
    assert.ok(scenario.car.linvel().y < 2, 'kickoff/reset auto-jumped');
  });
}

function runBooleanFallback(): number {
  return withScenario((scenario) => {
    step(scenario, input(true));
    const firstJumpVelocity = scenario.car.linvel().y;
    assert.ok(firstJumpVelocity > 2, 'legacy boolean press did not jump');

    let landed = false;
    for (let frame = 0; frame < Math.round(4 / TIMESTEP); frame++) {
      step(scenario, input(true));
      if (scenario.state.grounded && scenario.state.count === 0) {
        landed = true;
        break;
      }
    }
    assert.ok(landed, 'legacy held jump did not land');
    step(scenario, input(true));
    assert.equal(scenario.state.count, 0, 'legacy held boolean retriggered');
    step(scenario, input(false));
    step(scenario, input(true));
    assert.equal(scenario.state.count, 1, 'legacy release/press did not retrigger');
    return firstJumpVelocity;
  });
}

async function main(): Promise<void> {
  await initPhysics();
  const repeated = runRepeatedLandingCycles();
  const rapidTapVelocity = runCollapsedRapidTap();
  const postLandingApex = runAirbornePressDiscard();
  runKickoffSynchronization();
  const fallbackVelocity = runBooleanFallback();

  console.log('=== JUMP SEQUENCE HARNESS: PASS ===');
  console.log(`cycles=${repeated.cycles} fifthApex=${repeated.fifthApex.toFixed(3)}m minApex=${repeated.minApex.toFixed(3)}m`);
  console.log(`rapidTapVy=${rapidTapVelocity.toFixed(3)}m/s airbornePostLandingY=${postLandingApex.toFixed(3)}m`);
  console.log(`legacyFallbackVy=${fallbackVelocity.toFixed(3)}m/s kickoffAutoJump=false`);
}

main().catch((error: unknown) => {
  console.error('=== JUMP SEQUENCE HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
