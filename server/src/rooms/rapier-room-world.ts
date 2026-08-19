import RAPIER from '@dimforge/rapier3d-compat';
import {
  INPUT_PROTOCOL_VERSION,
  TUNING_IDS,
  getScalarTuningValue,
  type RoomPinnedTuningSnapshot,
  type RosterEntry,
} from '@rocket-arena/shared';
import { getConstant } from '@rocket-arena/shared/constants';
import { createArenaColliders } from '../physics/arena.js';
import {
  createBall,
  recoverBallAfterStep,
  recoverBallBeforeStep,
} from '../physics/ball.js';
import {
  createCarBody,
  recoverCarBodyAfterStep,
  recoverCarBodyBeforeStep,
} from '../physics/car-body.js';
import {
  createCarJumpAirState,
  planCarControllerCommand,
  synchronizeCarJumpAirState,
  type CarJumpAirState,
} from '../physics/car-controller.js';
import { detectGroundSupport } from '../physics/grounding.js';
import { createWorld, initPhysics } from '../physics/world.js';
import { prepareResetToKickoff } from '../systems/scoring.js';
import type {
  AuthoritativeGroundingResult,
  AuthoritativeRoomWorldBundle,
} from './authoritative-room-core.js';

export interface AuthoritativeRapierCar {
  readonly body: RAPIER.RigidBody;
  jumpAirState: Readonly<CarJumpAirState>;
  boostAmount: number;
}

interface RapierCarKickoffState {
  readonly jumpAirState: Readonly<CarJumpAirState>;
  readonly boostAmount: number;
}

export interface AuthoritativeRapierWorldOptions {
  readonly initialCarPosition: (
    entry: Pick<RosterEntry, 'acceptedJoinOrdinal' | 'team'>,
    tuning: RoomPinnedTuningSnapshot,
  ) => Readonly<{ readonly x: number; readonly y: number; readonly z: number }>;
}

export interface AuthoritativeRapierRoomWorldBundle extends AuthoritativeRoomWorldBundle<
  RAPIER.World,
  AuthoritativeRapierCar,
  RAPIER.RigidBody
> {
  readonly carsBySessionId: ReadonlyMap<string, AuthoritativeRapierCar>;
}

function initialBoostAmount(): number {
  return Math.max(
    0,
    Math.min(getConstant('CAR.BOOST.START_AMOUNT'), getConstant('CAR.BOOST.MAX_AMOUNT')),
  );
}

function captureKickoffState(car: AuthoritativeRapierCar): RapierCarKickoffState {
  return Object.freeze({
    jumpAirState: car.jumpAirState,
    boostAmount: car.boostAmount,
  });
}

function restoreKickoffState(
  car: AuthoritativeRapierCar,
  snapshot: RapierCarKickoffState,
): void {
  car.jumpAirState = snapshot.jumpAirState;
  car.boostAmount = snapshot.boostAmount;
}

function resetKickoffState(car: AuthoritativeRapierCar): void {
  car.jumpAirState = createCarJumpAirState(car.jumpAirState.lastConsumedJumpSequence);
  car.boostAmount = initialBoostAmount();
}

/**
 * Build the one shared production Rapier runtime used by both room policies.
 * Policy, stage order, roster order, gates, and fixed-step indices remain owned
 * by AuthoritativeRoomCore; this adapter performs only stage-local body work.
 */
export async function initializeAuthoritativeRapierWorld(
  { tuning }: { readonly tuning: RoomPinnedTuningSnapshot },
  options: Readonly<AuthoritativeRapierWorldOptions>,
): Promise<AuthoritativeRapierRoomWorldBundle> {
  await initPhysics();
  let world: RAPIER.World | null = null;
  let ownershipTransferred = false;

  try {
    const initializedWorld = createWorld(tuning);
    world = initializedWorld;
    const surfaces = createArenaColliders(initializedWorld);
    const ball = createBall(initializedWorld, undefined, tuning);
    const carsBySessionId = new Map<string, AuthoritativeRapierCar>();
    let disposed = false;

    const bundle: AuthoritativeRapierRoomWorldBundle = {
      world: initializedWorld,
      ball,
      carsBySessionId,
      mutationResources: {
        prepareJoin: ({ entry }, scope) => {
          const position = options.initialCarPosition(entry, tuning);
          const rotation = entry.team === 'orange'
            ? { x: 0, y: 1, z: 0, w: 0 }
            : { x: 0, y: 0, z: 0, w: 1 };
          let lastFiniteBoostAmount = initialBoostAmount();
          const car = scope.track<AuthoritativeRapierCar>(
            {
              body: createCarBody(initializedWorld, position, rotation, tuning),
              jumpAirState: createCarJumpAirState(),
              get boostAmount(): number {
                return lastFiniteBoostAmount;
              },
              set boostAmount(value: number) {
                if (!Number.isFinite(value)) return;
                lastFiniteBoostAmount = Math.max(
                  0,
                  Math.min(value, getConstant('CAR.BOOST.MAX_AMOUNT')),
                );
              },
            },
            (temporary) => {
              carsBySessionId.delete(entry.sessionId);
              if (temporary.body.isValid()) initializedWorld.removeRigidBody(temporary.body);
            },
          );
          carsBySessionId.set(entry.sessionId, car);
          return {
            car,
            input: {
              protocolVersion: INPUT_PROTOCOL_VERSION,
              throttle: 0,
              steer: 0,
              pitch: 0,
              yaw: 0,
              roll: 0,
              jumpHeld: false,
              jumpSequence: 0,
              boostHeld: false,
              powerslideHeld: false,
              cameraToggleSequence: 0,
            },
          };
        },
        prepareLeave: ({ entry, car }) => ({
          commitRemoval: () => {
            if (car.body.isValid()) initializedWorld.removeRigidBody(car.body);
            carsBySessionId.delete(entry.sessionId);
          },
        }),
      },
      prepareKickoffPlacement: ({ ball: authoritativeBall, cars, assignmentSet }) => (
        prepareResetToKickoff(
          authoritativeBall,
          new Map([...cars].map(([sessionId, car]) => [sessionId, {
            body: car.body,
            captureState: () => captureKickoffState(car),
            resetState: () => { resetKickoffState(car); },
            restoreState: (snapshot: RapierCarKickoffState) => {
              restoreKickoffState(car, snapshot);
            },
          }])),
          assignmentSet.assignments,
          getScalarTuningValue(tuning, TUNING_IDS.ball.radius),
        )
      ),
      synchronizeCarInput: ({ car, input }) => {
        car.jumpAirState = synchronizeCarJumpAirState(car.jumpAirState, input);
      },
      recoverBallBeforeStep: ({ ball: authoritativeBall }) => {
        recoverBallBeforeStep(authoritativeBall);
      },
      recoverCarBeforeStep: ({ car }) => {
        recoverCarBodyBeforeStep(car.body);
      },
      prepareGrounding: ({ world: authoritativeWorld }) => {
        authoritativeWorld.updateSceneQueries();
      },
      groundCar: ({ world: authoritativeWorld, car, tuning: roomTuning }) => {
        const result = detectGroundSupport(
          authoritativeWorld,
          car.body,
          surfaces,
          { tuning: roomTuning },
        );
        return Object.freeze({
          grounded: result.grounded,
          basis: result.basis,
        } satisfies AuthoritativeGroundingResult);
      },
      prepareCarCommand: ({
        car,
        input,
        grounding,
        fixedStepIndex,
        fixedStepSeconds,
        tuning: roomTuning,
      }) => {
        const rotation = car.body.rotation();
        const linearVelocity = car.body.linvel();
        const angularVelocity = car.body.angvel();
        const plan = planCarControllerCommand(input, {
          observation: {
            rotation,
            linearVelocity,
            angularVelocity,
            grounded: grounding.grounded,
            surfaceBasis: grounding.basis,
          },
          previousFiniteState: { rotation, linearVelocity, angularVelocity },
          availableBoost: car.boostAmount,
          tuning: roomTuning,
          timestepSeconds: fixedStepSeconds,
          jumpAir: {
            state: car.jumpAirState,
            fixedStepIndex,
          },
        });
        const nextJumpAirState = plan.nextJumpAirState ?? car.jumpAirState;
        let applied = false;
        let committed = false;

        return Object.freeze({
          apply: () => {
            if (applied) throw new Error('A prepared car command can be applied only once.');
            car.body.setLinvel(plan.projectedVelocity, true);
            car.body.setAngvel(plan.projectedAngularVelocity, true);
            applied = true;
          },
          commit: () => {
            if (!applied || committed) {
              throw new Error('A prepared car command must be applied once before one commit.');
            }
            car.jumpAirState = nextJumpAirState;
            committed = true;
          },
        });
      },
      stepWorld: ({ world: authoritativeWorld }) => {
        authoritativeWorld.step();
      },
      recoverCarAfterStep: ({ car }) => {
        recoverCarBodyAfterStep(car.body);
      },
      recoverBallAfterStep: ({ ball: authoritativeBall }) => {
        recoverBallAfterStep(authoritativeBall);
      },
      extractMatchFlowInput: () => Object.freeze({
        // Swept goal extraction and outcome resolution are installed in Wave 18.
      }),
      projectCar: ({ car }) => {
        const position = car.body.translation();
        const rotation = car.body.rotation();
        const linearVelocity = car.body.linvel();
        const angularVelocity = car.body.angvel();
        return {
          position: [position.x, position.y, position.z],
          rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
          linearVelocity: [linearVelocity.x, linearVelocity.y, linearVelocity.z],
          angularVelocity: [angularVelocity.x, angularVelocity.y, angularVelocity.z],
          boost: car.boostAmount,
        };
      },
      projectBall: ({ ball: authoritativeBall }) => {
        const position = authoritativeBall.translation();
        const rotation = authoritativeBall.rotation();
        const linearVelocity = authoritativeBall.linvel();
        const angularVelocity = authoritativeBall.angvel();
        return {
          position: [position.x, position.y, position.z],
          rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
          linearVelocity: [linearVelocity.x, linearVelocity.y, linearVelocity.z],
          angularVelocity: [angularVelocity.x, angularVelocity.y, angularVelocity.z],
        };
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        carsBySessionId.clear();
        initializedWorld.free();
      },
    };

    ownershipTransferred = true;
    return bundle;
  } finally {
    if (!ownershipTransferred) world?.free();
  }
}
