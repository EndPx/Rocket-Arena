import colyseus from 'colyseus';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  INPUT_PROTOCOL_VERSION,
  MATCH_RULES,
  ROOM_POLICIES,
  TUNING_IDS,
  getScalarTuningValue,
  type InputCommandV2,
  type MatchPhase,
  type RoomMutationErrorCode,
  type RoomPinnedTuningSnapshot,
  type RosterEntry,
  type Team,
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
import { isCapacityValidRoster } from '../systems/room-mutations.js';
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

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** The only capacity, assignment, switch, and start policy accepted by Custom Room. */
export const CUSTOM_ROOM_POLICY = ROOM_POLICIES.custom;

interface CustomCar {
  readonly body: RAPIER.RigidBody;
  readonly jumpState: CarPhysicsState;
}

type CustomRoomCore = AuthoritativeRoomCore<
  RAPIER.World,
  CustomCar,
  RAPIER.RigidBody
>;

/**
 * A policy-bound core factory shared by the Colyseus adapter and focused room
 * tests. Requested capacities remain untrusted assertions checked by the core.
 */
export type CustomRoomCoreOptions<TWorld, TCar, TBall> = Omit<
  AuthoritativeRoomCoreOptions<TWorld, TCar, TBall>,
  'mode' | 'policy'
>;

export function createCustomRoomCore<TWorld, TCar, TBall>(
  options: CustomRoomCoreOptions<TWorld, TCar, TBall>,
): AuthoritativeRoomCore<TWorld, TCar, TBall> {
  return new AuthoritativeRoomCore({
    ...options,
    mode: CUSTOM_ROOM_POLICY.mode,
    policy: CUSTOM_ROOM_POLICY,
  });
}

export interface CustomRoomStartPredicateState {
  readonly phase: MatchPhase;
  readonly hostSessionId: string | null;
  readonly roster: ReadonlyMap<string, Readonly<RosterEntry>>;
}

/** Read-only Custom capacity predicate; MatchFlow owns the later countdown. */
export function isCustomRoomCapacityValidRoster(
  roster: ReadonlyMap<string, Readonly<RosterEntry>>,
): boolean {
  return isCapacityValidRoster(CUSTOM_ROOM_POLICY, roster);
}

/** Compatibility predicate matching the core's fixed-step Host-start validation. */
export function isCustomRoomHostStartEligible(
  state: CustomRoomStartPredicateState,
  requesterSessionId: string,
): boolean {
  const requester = state.roster.get(requesterSessionId);
  return state.phase === 'waiting'
    && state.hostSessionId === requesterSessionId
    && requester?.isHost === true
    && isCustomRoomCapacityValidRoster(state.roster);
}

function generateRoomCode(): string {
  let code = '';
  for (let index = 0; index < getConstant('MATCH.ROOM_CODE_LENGTH'); index += 1) {
    code += ROOM_CODE_ALPHABET.charAt(Math.floor(Math.random() * ROOM_CODE_ALPHABET.length));
  }
  return code;
}

/**
 * Temporary four-player-per-team placement used until Stage 4 installs the
 * complete kickoff-slot service. Balanced initial joins map to four distinct
 * team-local lanes while stable join ordinals keep the choice deterministic.
 */
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
  const teamLocalSlot = Math.floor(entry.acceptedJoinOrdinal / 2)
    % CUSTOM_ROOM_POLICY.teamCapacity;
  const laneMultiplier = [1, -1, 0.5, -0.5][teamLocalSlot] ?? 0;
  const xOffset = entry.team === 'blue'
    ? getConstant('ARENA.KICKOFF.BLUE_X_OFFSET')
    : getConstant('ARENA.KICKOFF.ORANGE_X_OFFSET');
  const z = entry.team === 'blue'
    ? getConstant('ARENA.KICKOFF.BLUE_Z_OFFSET')
    : getConstant('ARENA.KICKOFF.ORANGE_Z_OFFSET');

  return { x: laneMultiplier * xOffset, y, z };
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
 * Temporary legacy physics bundle. The core owns scheduling, transactional
 * roster/body/input state, projections, and disposal; later stages replace
 * these callbacks without changing Custom policy or room-code transport.
 */
async function initializeCustomWorld(
  { tuning }: { readonly tuning: RoomPinnedTuningSnapshot },
): Promise<AuthoritativeRoomWorldBundle<RAPIER.World, CustomCar, RAPIER.RigidBody>> {
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
      CustomCar,
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
          const car = scope.track<CustomCar>(
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

function isTeam(value: unknown): value is Team {
  return value === 'blue' || value === 'orange';
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
 * Custom Room transport adapter. Room-code discovery and established message
 * names remain here; all authoritative state mutation is delegated to the core.
 */
export class CustomRoom extends Room<GameState> {
  private core!: CustomRoomCore;
  private readonly legacyInputEdges = new Map<string, LegacyInputEdgeState>();

  protected createAuthoritativeCore(requested: Record<string, unknown>): CustomRoomCore {
    return createCustomRoomCore({
      roomId: this.roomId,
      totalCapacity: requested.totalCapacity,
      teamCapacity: requested.teamCapacity,
      initializeWorld: initializeCustomWorld,
      onFatal: (error) => {
        console.error(`[CustomRoom] Authoritative core failed: ${error.message}`, error);
      },
    });
  }

  onCreate(options: unknown): void {
    this.setState(new GameState());
    this.applyPolicyMetadata();
    this.maxClients = CUSTOM_ROOM_POLICY.totalCapacity;
    this.setPatchRate(getConstant('NETCODE.PATCH_RATE_MS'));

    const requested = isRecord(options) ? options : {};
    this.core = this.createAuthoritativeCore(requested);

    const code = generateRoomCode();
    this.setMetadata({ code });

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

    this.onMessage('change-team', (client, candidate: unknown) => {
      void this.handleTeamSwitch(client, candidate);
    });
    this.onMessage('start-match', (client) => {
      void this.handleStartRequest(client);
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
        console.error('[CustomRoom] Physics initialization failed', error);
      });

    // This callback only feeds the fixed-step scheduler; MatchFlow owns countdown time.
    this.setSimulationInterval((deltaTimeMs) => {
      this.advanceSimulation(deltaTimeMs);
    }, PHYSICS.TIMESTEP * 1000);

    console.log(
      `[CustomRoom] Created code=${code}`
      + ` mode=${CUSTOM_ROOM_POLICY.mode}`
      + ` totalCapacity=${CUSTOM_ROOM_POLICY.totalCapacity}`
      + ` teamCapacity=${CUSTOM_ROOM_POLICY.teamCapacity}`,
    );
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
      throw new Error(`Custom Room join rejected (${result.code}): ${result.message}`);
    }

    this.synchronizeState();
    if (result.effect.kind === 'joined') {
      console.log(
        `[CustomRoom] ${result.effect.entry.name} joined team ${result.effect.entry.team}`
        + ` (host: ${result.effect.entry.isHost})`
        + ` (${this.state.totalOccupancy}/${CUSTOM_ROOM_POLICY.totalCapacity})`,
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
      console.warn(`[CustomRoom] Leave rejected (${result.code}): ${result.message}`);
    }
    this.synchronizeState();
  }

  onDispose(): void {
    this.legacyInputEdges.clear();
    this.core?.dispose();
    console.log('[CustomRoom] Disposed');
  }

  private async handleTeamSwitch(client: colyseus.Client, candidate: unknown): Promise<void> {
    const team = isRecord(candidate) ? candidate.team : undefined;
    if (!isTeam(team)) {
      this.sendRoomRejection(
        client,
        'not-opposite-team',
        'A switch must target blue or orange as the represented player\'s opposite team.',
      );
      return;
    }

    const result = await this.core.queueMutation({
      kind: 'switch-team',
      sessionId: client.sessionId,
      team,
    });
    if (!result.ok) {
      this.sendMutationRejection(client, result);
      return;
    }

    this.synchronizeState();
    if (result.effect.kind === 'team-switched') {
      console.log(
        `[CustomRoom] ${result.effect.sessionId} switched`
        + ` ${result.effect.from}->${result.effect.to}`,
      );
    }
  }

  private async handleStartRequest(client: colyseus.Client): Promise<void> {
    const result = await this.core.queueMutation({
      kind: 'start',
      sessionId: client.sessionId,
    });
    if (!result.ok) {
      this.sendMutationRejection(client, result);
      return;
    }

    this.synchronizeState();
    if (result.effect.kind === 'start-validated') {
      console.log(
        `[CustomRoom] Host ${result.effect.sessionId} started the fixed-step kickoff countdown.`,
      );
    }
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
    this.state.policyVersion = CUSTOM_ROOM_POLICY.version;
    this.state.roomMode = CUSTOM_ROOM_POLICY.mode;
    this.state.totalCapacity = CUSTOM_ROOM_POLICY.totalCapacity;
    this.state.teamCapacity = CUSTOM_ROOM_POLICY.teamCapacity;
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
    this.sendRoomRejection(client, result.code, result.message);
  }

  private sendRoomRejection(
    client: colyseus.Client,
    code: RoomMutationErrorCode,
    message: string,
  ): void {
    client.send('room-rejection', { code, message });
  }
}
