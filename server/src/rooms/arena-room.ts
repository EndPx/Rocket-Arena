import colyseus from 'colyseus';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  INPUT_PROTOCOL_VERSION,
  MATCH_RULES,
  ROOM_POLICIES,
  TUNING_IDS,
  getScalarTuningValue,
  type InputCommandV2,
  type RoomPinnedTuningSnapshot,
  type RosterEntry,
} from '@rocket-arena/shared';
import { GameState, PlayerState } from '@rocket-arena/shared/schema';
import {
  PHYSICS,
  clearOverrides,
  getConstant,
  setOverride,
} from '@rocket-arena/shared/constants';
import type { InputPayload } from '@rocket-arena/shared/types';
import { createArenaColliders } from '../physics/arena.js';
import {
  createBall,
  recoverBallAfterStep,
  recoverBallBeforeStep,
} from '../physics/ball.js';
import {
  applyCarPhysics,
  createCar,
  createCarPhysicsState,
  recoverCarBodyAfterStep,
  recoverCarBodyBeforeStep,
  synchronizeCarInputState,
  type CarPhysicsState,
} from '../physics/car.js';
import { createWorld, initPhysics } from '../physics/world.js';
import { prepareResetToKickoff } from '../systems/scoring.js';
import {
  AuthoritativeRoomCore,
  createNeutralInputCommandV2,
  type AuthoritativeRoomCoreOptions,
  type AuthoritativeRoomMutationFailure,
  type AuthoritativeRoomProjection,
  type AuthoritativeRoomWorldBundle,
} from './authoritative-room-core.js';
import { broadcastDueV2Snapshot } from './room-snapshot-transport.js';

const { Room } = colyseus;

/** The only capacity, assignment, and start policy accepted by Quick Match. */
export const QUICK_MATCH_POLICY = ROOM_POLICIES.quick;

interface QuickCar {
  readonly body: RAPIER.RigidBody;
  readonly jumpState: CarPhysicsState;
}

type QuickRoomCore = AuthoritativeRoomCore<
  RAPIER.World,
  QuickCar,
  RAPIER.RigidBody
>;

/**
 * A policy-bound core factory shared by the Colyseus adapter and focused room
 * tests. Caller-supplied capacity assertions still pass through the core's
 * canonical policy validation; callers cannot replace the Quick policy.
 */
export type QuickMatchCoreOptions<TWorld, TCar, TBall> = Omit<
  AuthoritativeRoomCoreOptions<TWorld, TCar, TBall>,
  'mode' | 'policy'
>;

export function createQuickMatchCore<TWorld, TCar, TBall>(
  options: QuickMatchCoreOptions<TWorld, TCar, TBall>,
): AuthoritativeRoomCore<TWorld, TCar, TBall> {
  return new AuthoritativeRoomCore({
    ...options,
    mode: QUICK_MATCH_POLICY.mode,
    policy: QUICK_MATCH_POLICY,
  });
}

function legacyKickoffPosition(
  entry: Pick<RosterEntry, 'acceptedJoinOrdinal' | 'team'>,
  tuning: RoomPinnedTuningSnapshot,
): {
  readonly x: number;
  readonly y: number;
  readonly z: number;
} {
  const y = getScalarTuningValue(tuning, TUNING_IDS.car.collider.height) / 2
    + getConstant('ARENA.KICKOFF.SPAWN_CLEARANCE');
  const slot = entry.acceptedJoinOrdinal % QUICK_MATCH_POLICY.teamCapacity;
  const horizontalSlot = slot === 0 ? 1 : slot === 1 ? -1 : 0;
  const xOffset = entry.team === 'blue'
    ? getConstant('ARENA.KICKOFF.BLUE_X_OFFSET')
    : getConstant('ARENA.KICKOFF.ORANGE_X_OFFSET');
  const z = entry.team === 'blue'
    ? getConstant('ARENA.KICKOFF.BLUE_Z_OFFSET')
    : getConstant('ARENA.KICKOFF.ORANGE_Z_OFFSET');

  return { x: horizontalSlot * xOffset, y, z };
}

function toLegacyInput(input: Readonly<InputCommandV2>): InputPayload {
  return {
    throttle: input.throttle,
    steer: input.steer,
    jump: input.jumpHeld,
    boost: input.boostHeld,
    jumpSequence: input.jumpSequence,
  };
}

/**
 * Temporary legacy physics bundle. The shared core owns scheduling, roster,
 * bodies, inputs, projection, and disposal; later stages replace only these
 * callback implementations without changing the Quick policy adapter.
 */
async function initializeQuickWorld(
  { tuning }: { readonly tuning: RoomPinnedTuningSnapshot },
): Promise<AuthoritativeRoomWorldBundle<RAPIER.World, QuickCar, RAPIER.RigidBody>> {
  await initPhysics();
  let world: RAPIER.World | null = null;
  let ownershipTransferred = false;

  try {
    const initializedWorld = createWorld(tuning);
    world = initializedWorld;
    createArenaColliders(initializedWorld);
    const ball = createBall(initializedWorld, undefined, tuning);

    const bundle: AuthoritativeRoomWorldBundle<
      RAPIER.World,
      QuickCar,
      RAPIER.RigidBody
    > = {
      world: initializedWorld,
      ball,
      mutationResources: {
        prepareJoin: ({ entry }, scope) => {
          const position = legacyKickoffPosition(entry, tuning);
          const rotation = entry.team === 'orange'
            ? { x: 0, y: 1, z: 0, w: 0 }
            : { x: 0, y: 0, z: 0, w: 1 };
          const car = scope.track<QuickCar>(
            {
              body: createCar(initializedWorld, position, rotation, tuning),
              jumpState: createCarPhysicsState(),
            },
            ({ body }) => { initializedWorld.removeRigidBody(body); },
          );
          return { car, input: createNeutralInputCommandV2() };
        },
        prepareLeave: ({ car }) => ({
          commitRemoval: () => { initializedWorld.removeRigidBody(car.body); },
        }),
      },
      prepareKickoffPlacement: ({ ball: authoritativeBall, cars, assignmentSet }) => (
        prepareResetToKickoff(
          authoritativeBall,
          new Map([...cars].map(([sessionId, car]) => [
            sessionId,
            { body: car.body, jumpState: car.jumpState },
          ])),
          assignmentSet.assignments,
          getScalarTuningValue(tuning, TUNING_IDS.ball.radius),
        )
      ),
      fixedStep: ({ state }) => {
        const activePlay = state.phase === 'playing' || state.phase === 'overtime';
        recoverBallBeforeStep(ball);
        for (const [sessionId, car] of state.cars) {
          recoverCarBodyBeforeStep(car.body);
          const input = state.inputs.get(sessionId) ?? createNeutralInputCommandV2();
          if (activePlay) {
            applyCarPhysics(initializedWorld, car.body, toLegacyInput(input), car.jumpState);
          } else {
            synchronizeCarInputState(car.jumpState, toLegacyInput(input));
          }
        }

        if (activePlay || state.phase === 'goal-reset') {
          initializedWorld.step();
          for (const car of state.cars.values()) recoverCarBodyAfterStep(car.body);
          recoverBallAfterStep(ball);
        }
      },
      projectCar: ({ car }) => {
        recoverCarBodyAfterStep(car.body);
        const position = car.body.translation();
        const rotation = car.body.rotation();
        const linearVelocity = car.body.linvel();
        const angularVelocity = car.body.angvel();
        return {
          position: [position.x, position.y, position.z],
          rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
          linearVelocity: [linearVelocity.x, linearVelocity.y, linearVelocity.z],
          angularVelocity: [angularVelocity.x, angularVelocity.y, angularVelocity.z],
          boost: car.jumpState.boostAmount,
        };
      },
      projectBall: ({ ball: authoritativeBall }) => {
        recoverBallAfterStep(authoritativeBall);
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
      dispose: () => { initializedWorld.free(); },
    };

    ownershipTransferred = true;
    return bundle;
  } finally {
    if (!ownershipTransferred) world?.free();
  }
}

interface LegacyInputEdgeState {
  readonly jumpHeld: boolean;
  readonly jumpSequence: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function legacyInputCommand(
  candidate: unknown,
  previous: LegacyInputEdgeState,
): { readonly command: InputCommandV2; readonly edges: LegacyInputEdgeState } {
  const payload = isRecord(candidate) ? candidate : {};
  const jumpHeld = payload.jump === true;
  const suppliedSequence = Number.isSafeInteger(payload.jumpSequence)
    && (payload.jumpSequence as number) >= previous.jumpSequence
    && (payload.jumpSequence as number) >= 0
    ? payload.jumpSequence as number
    : null;
  const jumpSequence = suppliedSequence
    ?? previous.jumpSequence + Number(jumpHeld && !previous.jumpHeld);
  const edges = Object.freeze({ jumpHeld, jumpSequence });

  return {
    edges,
    command: {
      protocolVersion: INPUT_PROTOCOL_VERSION,
      throttle: typeof payload.throttle === 'number' ? payload.throttle : 0,
      steer: typeof payload.steer === 'number' ? payload.steer : 0,
      pitch: 0,
      yaw: 0,
      roll: 0,
      jumpHeld,
      jumpSequence,
      boostHeld: payload.boost === true,
      powerslideHeld: false,
      cameraToggleSequence: 0,
    },
  };
}

/**
 * Quick Match transport adapter. All authoritative roster and body mutation is
 * delegated to AuthoritativeRoomCore under the immutable exact-3v3 policy.
 */
export class ArenaRoom extends Room<GameState> {
  private core!: QuickRoomCore;
  private readonly legacyInputEdges = new Map<string, LegacyInputEdgeState>();

  protected createAuthoritativeCore(requested: Record<string, unknown>): QuickRoomCore {
    return createQuickMatchCore({
      roomId: this.roomId,
      totalCapacity: requested.totalCapacity,
      teamCapacity: requested.teamCapacity,
      initializeWorld: initializeQuickWorld,
      onFatal: (error) => {
        console.error(`[ArenaRoom] Authoritative core failed: ${error.message}`, error);
      },
    });
  }

  onCreate(options: unknown): void {
    this.setState(new GameState());
    this.applyPolicyMetadata();
    this.maxClients = QUICK_MATCH_POLICY.totalCapacity;
    this.setPatchRate(getConstant('NETCODE.PATCH_RATE_MS'));

    const requested = isRecord(options) ? options : {};
    this.core = this.createAuthoritativeCore(requested);

    this.onMessage('input', (client, candidate: unknown) => {
      let result;
      if (isRecord(candidate) && candidate.protocolVersion === INPUT_PROTOCOL_VERSION) {
        result = this.core.submitInput(client.sessionId, candidate);
      } else {
        const previous = this.legacyInputEdges.get(client.sessionId)
          ?? { jumpHeld: false, jumpSequence: 0 };
        const translated = legacyInputCommand(candidate, previous);
        result = this.core.submitInput(client.sessionId, translated.command);
        if (result.ok) this.legacyInputEdges.set(client.sessionId, translated.edges);
      }

      if (!result.ok) {
        client.send('input-rejection', { code: result.code, message: result.message });
      }
    });

    // Temporary development transport retained until registry tooling is wired.
    this.onMessage('dev-tune', (_client, data: { path: string; value: number }) => {
      try {
        setOverride(data.path, data.value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[Dev] Failed to override: ${message}`);
      }
    });
    this.onMessage('dev-reset', () => { clearOverrides(); });

    void this.core.initialize()
      .then(() => { this.synchronizeState(); })
      .catch((error: unknown) => {
        console.error('[ArenaRoom] Physics initialization failed', error);
      });

    // This callback only feeds the fixed-step scheduler; MatchFlow owns countdown time.
    this.setSimulationInterval((deltaTimeMs) => {
      this.advanceSimulation(deltaTimeMs);
    }, PHYSICS.TIMESTEP * 1000);
  }

  async onJoin(client: colyseus.Client, options: unknown): Promise<void> {
    const requested = isRecord(options) ? options : {};
    const name = typeof requested.name === 'string'
      ? requested.name
      : `Player ${this.clients.length}`;
    const result = await this.core.queueMutation({
      kind: 'join',
      sessionId: client.sessionId,
      name,
    });

    if (!result.ok) {
      this.sendMutationRejection(client, result);
      throw new Error(`Quick Match join rejected (${result.code}): ${result.message}`);
    }

    this.synchronizeState();
    if (result.effect.kind === 'joined') {
      console.log(
        `[ArenaRoom] ${result.effect.entry.name} joined team ${result.effect.entry.team}`
        + ` (${this.state.totalOccupancy}/${QUICK_MATCH_POLICY.totalCapacity})`,
      );
    }
  }

  async onLeave(client: colyseus.Client): Promise<void> {
    this.legacyInputEdges.delete(client.sessionId);
    const result = await this.core.queueMutation({
      kind: 'leave',
      sessionId: client.sessionId,
    });
    if (!result.ok && result.code !== 'not-represented') {
      console.warn(`[ArenaRoom] Leave rejected (${result.code}): ${result.message}`);
    }
    this.synchronizeState();
  }

  onDispose(): void {
    this.legacyInputEdges.clear();
    this.core?.dispose();
    console.log('[ArenaRoom] Disposed');
  }

  private advanceSimulation(deltaTimeMs: number): void {
    const frame = this.core.advanceSimulation(deltaTimeMs);
    const projection = this.synchronizeState();
    broadcastDueV2Snapshot(
      frame.snapshotDue,
      projection,
      this.core,
      Date.now(),
      (type, snapshot) => { this.broadcast(type, snapshot); },
    );
  }

  private applyPolicyMetadata(): void {
    this.state.policyVersion = QUICK_MATCH_POLICY.version;
    this.state.roomMode = QUICK_MATCH_POLICY.mode;
    this.state.totalCapacity = QUICK_MATCH_POLICY.totalCapacity;
    this.state.teamCapacity = QUICK_MATCH_POLICY.teamCapacity;
  }

  private synchronizeState(): Readonly<AuthoritativeRoomProjection> | null {
    const projection = this.core.projectAuthoritativeState();
    if (projection === null) {
      if (this.core.lifecycle === 'disposed' || this.core.lifecycle === 'fatal') {
        for (const sessionId of [...this.state.players.keys()]) {
          this.state.players.delete(sessionId);
        }
        this.state.totalOccupancy = 0;
        this.state.blueOccupancy = 0;
        this.state.orangeOccupancy = 0;
        this.state.hostSessionId = '';
      }
      return null;
    }

    const represented = new Set<string>();
    for (const car of projection.cars) {
      represented.add(car.sessionId);
      const player = this.state.players.get(car.sessionId) ?? new PlayerState();
      player.applyAuthoritativeProjection(car);
      this.state.players.set(car.sessionId, player);
    }
    for (const sessionId of [...this.state.players.keys()]) {
      if (!represented.has(sessionId)) this.state.players.delete(sessionId);
    }

    const [ballX, ballY, ballZ] = projection.ball.position;
    const [ballQx, ballQy, ballQz, ballQw] = projection.ball.rotation;
    const [ballVx, ballVy, ballVz] = projection.ball.linearVelocity;
    Object.assign(this.state.ball, {
      x: ballX,
      y: ballY,
      z: ballZ,
      qx: ballQx,
      qy: ballQy,
      qz: ballQz,
      qw: ballQw,
      vx: ballVx,
      vy: ballVy,
      vz: ballVz,
    });

    this.applyPolicyMetadata();
    this.state.phase = projection.phase;
    this.state.countdownKind = projection.countdownKind;
    this.state.countdownStepsRemaining = projection.countdownStepsRemaining;
    this.state.phaseSecondsRemaining = projection.countdownStepsRemaining
      / MATCH_RULES.fixedStepsPerSecond;
    this.state.regulationStepsRemaining = projection.regulationStepsRemaining;
    this.state.regulationActivePlayStepsCompleted = Math.max(
      0,
      MATCH_RULES.regulationActivePlaySteps - projection.regulationStepsRemaining,
    );
    this.state.regulationSecondsRemaining = projection.regulationStepsRemaining
      / MATCH_RULES.fixedStepsPerSecond;
    this.state.blueScore = projection.blueScore;
    this.state.orangeScore = projection.orangeScore;
    this.state.totalOccupancy = projection.occupancy.total;
    this.state.blueOccupancy = projection.occupancy.blue;
    this.state.orangeOccupancy = projection.occupancy.orange;
    this.state.hostSessionId = projection.hostSessionId ?? '';
    this.state.timeRemaining = projection.phase === 'countdown'
      ? this.state.phaseSecondsRemaining
      : this.state.regulationSecondsRemaining;
    this.state.refreshAuthoritativeOccupancy(projection.policy);

    return projection;
  }

  private sendMutationRejection(
    client: colyseus.Client,
    result: AuthoritativeRoomMutationFailure,
  ): void {
    client.send('room-rejection', {
      code: result.code,
      message: result.message,
    });
  }
}
