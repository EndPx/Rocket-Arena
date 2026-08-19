import colyseus from 'colyseus';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  INPUT_PROTOCOL_VERSION,
  ROOM_POLICIES,
  TUNING_IDS,
  getScalarTuningValue,
  type InputCommandV2,
  type RoomPinnedTuningSnapshot,
  type RosterEntry,
} from '@rocket-arena/shared';
import { GameState } from '@rocket-arena/shared/schema';
import {
  PHYSICS,
  clearOverrides,
  getConstant,
  setOverride,
} from '@rocket-arena/shared/constants';
import {
  initializeAuthoritativeRapierWorld,
  type AuthoritativeRapierCar,
} from './rapier-room-world.js';
import {
  AuthoritativeRoomCore,
  type AuthoritativeRoomCoreOptions,
  type AuthoritativeRoomMutationFailure,
  type AuthoritativeRoomProjection,
  type AuthoritativeRoomWorldBundle,
} from './authoritative-room-core.js';
import { broadcastDueV2Snapshot } from './room-snapshot-transport.js';

const { Room } = colyseus;

/** The only capacity, assignment, and start policy accepted by Quick Match. */
export const QUICK_MATCH_POLICY = ROOM_POLICIES.quick;

type QuickCar = AuthoritativeRapierCar;

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

/** Create the shared staged Rapier runtime under the Quick policy. */
async function initializeQuickWorld(
  context: { readonly tuning: RoomPinnedTuningSnapshot },
): Promise<AuthoritativeRoomWorldBundle<RAPIER.World, QuickCar, RAPIER.RigidBody>> {
  return initializeAuthoritativeRapierWorld(context, {
    initialCarPosition: legacyKickoffPosition,
  });
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
      if (
        isRecord(candidate)
        && Object.prototype.hasOwnProperty.call(candidate, 'protocolVersion')
      ) {
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

    this.state.applyAuthoritativeProjection(projection);
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
