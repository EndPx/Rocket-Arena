import assert from 'node:assert/strict';
import test from 'node:test';
import type { Room } from 'colyseus.js';
import * as THREE from 'three';
import {
  ROOM_POLICIES,
  SNAPSHOT_PROTOCOL_VERSION,
  type RoomMode,
} from '@rocket-arena/shared';
import {
  acceptedSnapshotStore,
  type AcceptedSnapshotChange,
  type AcceptedSnapshotState,
} from '../src/networking/accepted-snapshot-store.js';
import {
  getBallMesh,
  getCarMeshes,
  getInterpolationStats,
  getLocalState,
  setupStateListener,
  type RuntimeInterpolationStats,
  type StateSync,
} from '../src/networking/state-listener.js';
import {
  decodeSnapshot,
  type DomainSnapshot,
  type SnapshotValidationErrorCode,
} from '../src/networking/snapshot-validator.js';
import {
  assertGeneratedCases,
  generateCases,
  replayCase,
  type SeededRandom,
} from '../../shared/tests/support/generated-cases.js';

const RECORDED_SEED = 'rocket-arena-property-8-snapshot-acceptance-v1';
const GENERATED_BUNDLE_COUNT = 128;

type Team = 'blue' | 'orange';
type MutableRecord = Record<string, unknown>;
type PreparationFailureMode = 'throw' | 'invalid-group';

const REJECTION_KINDS = Object.freeze([
  'malformed',
  'version',
  'mode',
  'policy',
  'capacity',
  'team',
  'duplicate',
  'non-finite',
  'quaternion',
  'missing-field',
  'sequence',
  'time',
  'epoch',
  'terminal',
  'protocol-downgrade',
  'mesh-preparation',
  'scene-commit',
] as const);

type RejectionKind = (typeof REJECTION_KINDS)[number];

interface CarPlan {
  readonly sessionId: string;
  readonly team: Team;
}

interface OperationBundle {
  readonly caseIndex: number;
  readonly rejectionKind: RejectionKind;
  readonly roomMode: RoomMode;
  readonly baselineCars: readonly CarPlan[];
  readonly acceptedCars: readonly CarPlan[];
  readonly baselineSequence: number;
  readonly baselineServerTime: number;
  readonly baselineSimulationTime: number;
  readonly baselineKickoffEpoch: number;
  readonly acceptedKickoffEpoch: number;
  readonly coordinateBias: number;
  readonly preparationFailureMode: PreparationFailureMode;
}

interface RejectedCandidate {
  readonly payload: unknown;
  readonly expectedDecoderError: SnapshotValidationErrorCode | null;
  readonly preparationFailureMode?: PreparationFailureMode;
  readonly sceneCommitFailure?: true;
}

interface PublicationObservation {
  readonly change: AcceptedSnapshotChange;
  readonly storeState: AcceptedSnapshotState;
  readonly generation: AcceptedSnapshotState['generation'];
  readonly localState: Readonly<StateSync> | null;
  readonly carMap: ReadonlyMap<string, THREE.Group>;
  readonly carKeys: readonly string[];
  readonly carMeshes: readonly THREE.Group[];
  readonly ball: THREE.Group | null;
  readonly orderedSceneChildren: readonly THREE.Object3D[];
  readonly stats: RuntimeInterpolationStats;
}

interface CapturedObjectState {
  readonly object: THREE.Group;
  readonly parent: THREE.Object3D | null;
  readonly position: readonly number[];
  readonly quaternion: readonly number[];
  readonly scale: readonly number[];
  readonly matrix: readonly number[];
  readonly matrixWorld: readonly number[];
  readonly userData: Record<string, unknown>;
  readonly userDataValue: unknown;
  readonly syncedVelocity: THREE.Vector3 | null;
  readonly visualRig: unknown;
  readonly boostFlames: unknown;
  readonly boostTrails: unknown;
}

interface CapturedCommittedSubsystems {
  readonly storeState: AcceptedSnapshotState;
  readonly storeGeneration: AcceptedSnapshotState['generation'];
  readonly storeGenerationId: number;
  readonly storeSnapshot: Readonly<DomainSnapshot> | null;
  readonly storeSnapshotValue: unknown;
  readonly localState: Readonly<StateSync> | null;
  readonly localStateValue: unknown;
  readonly carMap: ReadonlyMap<string, THREE.Group>;
  readonly carKeys: readonly string[];
  readonly cars: readonly Readonly<{
    sessionId: string;
    state: CapturedObjectState;
  }>[];
  readonly ball: CapturedObjectState | null;
  readonly orderedSceneChildren: readonly THREE.Object3D[];
  readonly sceneChildNames: readonly string[];
  readonly stats: RuntimeInterpolationStats;
  readonly notificationCount: number;
}

type MessageHandler = (payload: unknown) => void;
type LeaveHandler = () => void;

class FakeRoom {
  private readonly messageHandlers = new Map<string, MessageHandler[]>();
  private readonly leaveHandlers: LeaveHandler[] = [];
  leaveCount = 0;

  onMessage(type: string, handler: MessageHandler): void {
    const handlers = this.messageHandlers.get(type) ?? [];
    handlers.push(handler);
    this.messageHandlers.set(type, handlers);
  }

  onLeave(handler: LeaveHandler): void {
    this.leaveHandlers.push(handler);
  }

  emit(payload: unknown): void {
    for (const handler of this.messageHandlers.get('state-sync') ?? []) handler(payload);
  }

  leave(): void {
    this.leaveCount += 1;
    for (const handler of this.leaveHandlers) handler();
  }
}

class ControlledScene extends THREE.Scene {
  private remainingCarAddsBeforeFailure: number | null = null;
  rejectedCarAdds = 0;

  rejectCarAdd(ordinal: number): void {
    this.remainingCarAddsBeforeFailure = ordinal;
  }

  override add(...objects: THREE.Object3D[]): this {
    for (const object of objects) {
      if (
        this.remainingCarAddsBeforeFailure !== null
        && object.userData.factoryKind === 'car'
      ) {
        this.remainingCarAddsBeforeFailure -= 1;
        if (this.remainingCarAddsBeforeFailure === 0) {
          this.remainingCarAddsBeforeFailure = null;
          this.rejectedCarAdds += 1;
          throw new Error('injected generated scene-commit failure');
        }
      }
    }
    return super.add(...objects);
  }
}

interface FactoryControls {
  preparationFailure: {
    remainingCalls: number;
    mode: PreparationFailureMode;
  } | null;
  preparationFailures: number;
  factoryOrdinal: number;
}

function asRoom(room: FakeRoom): Room {
  return room as unknown as Room;
}

function immutableCars(cars: readonly CarPlan[]): readonly CarPlan[] {
  return Object.freeze(cars.map((car) => Object.freeze({ ...car })));
}

function fullRoster(roomMode: RoomMode, prefix: string): readonly CarPlan[] {
  const policy = ROOM_POLICIES[roomMode];
  return immutableCars(Array.from({ length: policy.totalCapacity }, (_, slot) => ({
    sessionId: `${prefix}-${slot}`,
    team: slot < policy.teamCapacity ? 'blue' : 'orange',
  })));
}

function generatedRosters(
  roomMode: RoomMode,
  caseIndex: number,
): Readonly<{ baseline: readonly CarPlan[]; accepted: readonly CarPlan[] }> {
  const stable = Object.freeze({
    sessionId: `stable-${caseIndex}`,
    team: 'blue' as const,
  });

  switch (caseIndex % 6) {
    case 0:
      return Object.freeze({ baseline: Object.freeze([]), accepted: Object.freeze([]) });
    case 1:
      return Object.freeze({
        baseline: fullRoster(roomMode, `baseline-full-${caseIndex}`),
        accepted: Object.freeze([]),
      });
    case 2:
      return Object.freeze({
        baseline: Object.freeze([]),
        accepted: fullRoster(roomMode, `accepted-full-${caseIndex}`),
      });
    case 3:
      return Object.freeze({
        baseline: immutableCars([stable]),
        accepted: immutableCars([stable]),
      });
    case 4:
      return Object.freeze({
        baseline: immutableCars([stable]),
        accepted: immutableCars([{
          sessionId: `replacement-${caseIndex}`,
          team: 'blue',
        }]),
      });
    default:
      return Object.freeze({
        baseline: immutableCars([stable]),
        accepted: immutableCars([{
          sessionId: stable.sessionId,
          team: 'orange',
        }]),
      });
  }
}

function generateOperationBundle(random: SeededRandom, caseIndex: number): OperationBundle {
  const roomMode: RoomMode = caseIndex % 2 === 0 ? 'quick' : 'custom';
  const rosters = generatedRosters(roomMode, caseIndex);
  const baselineKickoffEpoch = 2 + random.integer(0, 4);

  return Object.freeze({
    caseIndex,
    rejectionKind: REJECTION_KINDS[caseIndex % REJECTION_KINDS.length],
    roomMode,
    baselineCars: rosters.baseline,
    acceptedCars: rosters.accepted,
    baselineSequence: caseIndex * 4 + 1,
    baselineServerTime: 20_000 + caseIndex * 100,
    baselineSimulationTime: 1_000 + caseIndex * 40,
    baselineKickoffEpoch,
    acceptedKickoffEpoch: baselineKickoffEpoch + random.integer(0, 2),
    coordinateBias: random.integer(-400, 400) / 4,
    preparationFailureMode: Math.floor(caseIndex / REJECTION_KINDS.length) % 2 === 0
      ? 'throw'
      : 'invalid-group',
  });
}

function payloadTiming(
  bundle: OperationBundle,
  stage: 0 | 1,
): Readonly<{
  sequence: number;
  serverTime: number;
  simulationTime: number;
  kickoffEpoch: number;
}> {
  return Object.freeze({
    sequence: bundle.baselineSequence + stage,
    serverTime: bundle.baselineServerTime + stage * 33,
    simulationTime: bundle.baselineSimulationTime + stage * 16,
    kickoffEpoch: stage === 0
      ? bundle.baselineKickoffEpoch
      : bundle.acceptedKickoffEpoch,
  });
}

function buildPayload(
  bundle: OperationBundle,
  cars: readonly CarPlan[],
  stage: 0 | 1,
  roomMode: RoomMode = bundle.roomMode,
): MutableRecord {
  const policy = ROOM_POLICIES[roomMode];
  const timing = payloadTiming(bundle, stage);
  const coordinateOffset = bundle.coordinateBias + stage * 0.25;

  return {
    protocolVersion: SNAPSHOT_PROTOCOL_VERSION,
    policyVersion: policy.version,
    roomMode,
    totalCapacity: policy.totalCapacity,
    teamCapacity: policy.teamCapacity,
    sequence: timing.sequence,
    serverTime: timing.serverTime,
    simulationTime: timing.simulationTime,
    phase: 'playing',
    countdownKind: null,
    phaseSecondsRemaining: 0,
    regulationSecondsRemaining: 240 - (bundle.caseIndex % 120),
    kickoffEpoch: timing.kickoffEpoch,
    blueScore: (bundle.caseIndex + stage) % 5,
    orangeScore: bundle.caseIndex % 3,
    winner: null,
    terminalResult: null,
    latestTransition: null,
    cars: cars.map((car, carIndex) => ({
      sessionId: car.sessionId,
      team: car.team,
      name: `Generated Driver ${bundle.caseIndex}-${carIndex}-${stage}`,
      isHost: roomMode === 'custom' && carIndex === 0,
      position: [coordinateOffset + carIndex, 0.5, stage - carIndex],
      rotation: [0, 0, 0, 1],
      linearVelocity: [carIndex + stage, 0, -stage],
      boost: (bundle.caseIndex * 7 + carIndex * 13 + stage) % 101,
    })),
    ball: {
      position: [coordinateOffset, 0.9125, stage * 2],
      rotation: [0, 0, 0, 1],
      linearVelocity: [stage, 0, 1],
    },
  };
}

function payloadCars(payload: MutableRecord): MutableRecord[] {
  return payload.cars as MutableRecord[];
}

function payloadBall(payload: MutableRecord): MutableRecord {
  return payload.ball as MutableRecord;
}

function legacyPayloadFrom(payload: MutableRecord): MutableRecord {
  const players: MutableRecord = {};
  for (const car of payloadCars(payload)) {
    const position = car.position as number[];
    const rotation = car.rotation as number[];
    const velocity = car.linearVelocity as number[];
    players[car.sessionId as string] = {
      x: position[0],
      y: position[1],
      z: position[2],
      qx: rotation[0],
      qy: rotation[1],
      qz: rotation[2],
      qw: rotation[3],
      vx: velocity[0],
      vy: velocity[1],
      vz: velocity[2],
      boost: car.boost,
      team: car.team,
      name: car.name,
      isHost: car.isHost,
    };
  }

  const ball = payloadBall(payload);
  const ballPosition = ball.position as number[];
  const ballRotation = ball.rotation as number[];
  const ballVelocity = ball.linearVelocity as number[];
  return {
    sequence: payload.sequence,
    serverTime: payload.serverTime,
    simulationTime: payload.simulationTime,
    players,
    ball: {
      x: ballPosition[0],
      y: ballPosition[1],
      z: ballPosition[2],
      qx: ballRotation[0],
      qy: ballRotation[1],
      qz: ballRotation[2],
      qw: ballRotation[3],
      vx: ballVelocity[0],
      vy: ballVelocity[1],
      vz: ballVelocity[2],
    },
    blueScore: payload.blueScore,
    orangeScore: payload.orangeScore,
    timeRemaining: payload.regulationSecondsRemaining,
    phase: payload.phase,
  };
}

function failureCars(bundle: OperationBundle): readonly CarPlan[] {
  return immutableCars([
    { sessionId: `failure-blue-${bundle.caseIndex}`, team: 'blue' },
    { sessionId: `failure-orange-${bundle.caseIndex}`, team: 'orange' },
  ]);
}

function createRejectedCandidate(
  bundle: OperationBundle,
  baseline: Readonly<DomainSnapshot>,
): RejectedCandidate {
  const base = buildPayload(bundle, bundle.acceptedCars, 1);

  switch (bundle.rejectionKind) {
    case 'malformed':
      base.cars = { not: 'an-array' };
      return { payload: base, expectedDecoderError: 'malformed-snapshot' };
    case 'version':
      base.protocolVersion = SNAPSHOT_PROTOCOL_VERSION + 1;
      return { payload: base, expectedDecoderError: 'unsupported-protocol-version' };
    case 'mode': {
      const otherMode: RoomMode = bundle.roomMode === 'quick' ? 'custom' : 'quick';
      return {
        payload: buildPayload(bundle, [{
          sessionId: `wrong-mode-${bundle.caseIndex}`,
          team: 'blue',
        }], 1, otherMode),
        expectedDecoderError: 'room-mode-mismatch',
      };
    }
    case 'policy':
      base.policyVersion = (base.policyVersion as number) + 1;
      return { payload: base, expectedDecoderError: 'policy-mismatch' };
    case 'capacity': {
      const policy = ROOM_POLICIES[bundle.roomMode];
      const overCapacity = immutableCars(Array.from(
        { length: policy.totalCapacity + 1 },
        (_, index) => ({
          sessionId: `over-capacity-${bundle.caseIndex}-${index}`,
          team: index % 2 === 0 ? 'blue' : 'orange',
        }),
      ));
      return {
        payload: buildPayload(bundle, overCapacity, 1),
        expectedDecoderError: 'capacity-exceeded',
      };
    }
    case 'team': {
      const payload = buildPayload(bundle, [{
        sessionId: `invalid-team-${bundle.caseIndex}`,
        team: 'blue',
      }], 1);
      payloadCars(payload)[0]!.team = 'green';
      return { payload, expectedDecoderError: 'invalid-team' };
    }
    case 'duplicate':
      return {
        payload: buildPayload(bundle, [
          { sessionId: `duplicate-${bundle.caseIndex}`, team: 'blue' },
          { sessionId: `duplicate-${bundle.caseIndex}`, team: 'orange' },
        ], 1),
        expectedDecoderError: 'duplicate-identity',
      };
    case 'non-finite':
      (payloadBall(base).position as number[])[0] = Number.NaN;
      return { payload: base, expectedDecoderError: 'non-finite-number' };
    case 'quaternion':
      payloadBall(base).rotation = [0, 0, 0, 0];
      return { payload: base, expectedDecoderError: 'invalid-quaternion' };
    case 'missing-field':
      delete payloadBall(base).rotation;
      return { payload: base, expectedDecoderError: 'malformed-snapshot' };
    case 'sequence':
      base.sequence = baseline.sequence;
      return { payload: base, expectedDecoderError: 'sequence-regression' };
    case 'time':
      base.simulationTime = baseline.simulationTime - 1;
      return { payload: base, expectedDecoderError: 'simulation-time-regression' };
    case 'epoch':
      base.kickoffEpoch = baseline.kickoffEpoch - 1;
      return { payload: base, expectedDecoderError: null };
    case 'terminal':
      base.phase = 'ended';
      return { payload: base, expectedDecoderError: 'terminal-coherence' };
    case 'protocol-downgrade':
      return {
        payload: legacyPayloadFrom(base),
        expectedDecoderError: 'protocol-downgrade',
      };
    case 'mesh-preparation':
      return {
        payload: buildPayload(bundle, failureCars(bundle), 1),
        expectedDecoderError: null,
        preparationFailureMode: bundle.preparationFailureMode,
      };
    case 'scene-commit':
      return {
        payload: buildPayload(bundle, failureCars(bundle), 1),
        expectedDecoderError: null,
        sceneCommitFailure: true,
      };
  }
}

function createCarFactory(controls: FactoryControls): (team: string) => THREE.Group {
  return (team: string): THREE.Group => {
    controls.factoryOrdinal += 1;
    if (controls.preparationFailure !== null) {
      controls.preparationFailure.remainingCalls -= 1;
      if (controls.preparationFailure.remainingCalls === 0) {
        const mode = controls.preparationFailure.mode;
        controls.preparationFailure = null;
        controls.preparationFailures += 1;
        if (mode === 'throw') throw new Error('injected generated mesh-preparation failure');

        const invalid = new THREE.Object3D();
        invalid.name = `invalid-property-car-${controls.factoryOrdinal}`;
        invalid.userData.factoryKind = 'invalid-car';
        return invalid as unknown as THREE.Group;
      }
    }

    const group = new THREE.Group();
    group.name = `property-car-${team}-${controls.factoryOrdinal}`;
    group.userData.factoryKind = 'car';
    group.userData.factoryOrdinal = controls.factoryOrdinal;
    group.userData.visualRig = { boostFlames: [], boostTrails: [] };
    return group;
  };
}

function createBallFactory(): () => THREE.Group {
  return (): THREE.Group => {
    const group = new THREE.Group();
    group.name = 'property-ball';
    group.userData.factoryKind = 'ball';
    return group;
  };
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function captureObjectState(object: THREE.Group): CapturedObjectState {
  const syncedVelocity = object.userData.syncedVelocity instanceof THREE.Vector3
    ? object.userData.syncedVelocity
    : null;
  const visualRig = object.userData.visualRig as {
    boostFlames?: unknown;
    boostTrails?: unknown;
  } | undefined;

  return {
    object,
    parent: object.parent,
    position: Object.freeze(object.position.toArray()),
    quaternion: Object.freeze(object.quaternion.toArray()),
    scale: Object.freeze(object.scale.toArray()),
    matrix: Object.freeze(object.matrix.toArray()),
    matrixWorld: Object.freeze(object.matrixWorld.toArray()),
    userData: object.userData as Record<string, unknown>,
    userDataValue: cloneValue(object.userData),
    syncedVelocity,
    visualRig: visualRig ?? null,
    boostFlames: visualRig?.boostFlames ?? null,
    boostTrails: visualRig?.boostTrails ?? null,
  };
}

function captureCommittedSubsystems(
  scene: THREE.Scene,
  notificationCount: number,
): CapturedCommittedSubsystems {
  const storeState = acceptedSnapshotStore.getState();
  const storeGeneration = acceptedSnapshotStore.getGeneration();
  const storeSnapshot = acceptedSnapshotStore.getSnapshot();
  const localState = getLocalState();
  const carMap = getCarMeshes();
  const ball = getBallMesh();

  return {
    storeState,
    storeGeneration,
    storeGenerationId: storeGeneration.id,
    storeSnapshot,
    storeSnapshotValue: cloneValue(storeSnapshot),
    localState,
    localStateValue: cloneValue(localState),
    carMap,
    carKeys: Object.freeze([...carMap.keys()]),
    cars: Object.freeze([...carMap].map(([sessionId, car]) => Object.freeze({
      sessionId,
      state: captureObjectState(car),
    }))),
    ball: ball === null ? null : captureObjectState(ball),
    orderedSceneChildren: Object.freeze([...scene.children]),
    sceneChildNames: Object.freeze(scene.children.map((child) => child.name)),
    stats: getInterpolationStats(),
    notificationCount,
  };
}

function assertIdentitySequence<T>(
  actual: readonly T[],
  expected: readonly T[],
  message: string,
): void {
  assert.equal(actual.length, expected.length, `${message}: length`);
  for (let index = 0; index < expected.length; index += 1) {
    assert.strictEqual(actual[index], expected[index], `${message}: identity at ${index}`);
  }
}

function assertObjectPreserved(
  actual: CapturedObjectState,
  expected: CapturedObjectState,
  label: string,
): void {
  assert.strictEqual(actual.object, expected.object, `${label}: object identity`);
  assert.strictEqual(actual.parent, expected.parent, `${label}: parent identity`);
  assert.deepEqual(actual.position, expected.position, `${label}: position`);
  assert.deepEqual(actual.quaternion, expected.quaternion, `${label}: quaternion`);
  assert.deepEqual(actual.scale, expected.scale, `${label}: scale`);
  assert.deepEqual(actual.matrix, expected.matrix, `${label}: local matrix`);
  assert.deepEqual(actual.matrixWorld, expected.matrixWorld, `${label}: world matrix`);
  assert.strictEqual(actual.userData, expected.userData, `${label}: userData identity`);
  assert.deepEqual(actual.userDataValue, expected.userDataValue, `${label}: userData value`);
  assert.strictEqual(
    actual.syncedVelocity,
    expected.syncedVelocity,
    `${label}: synced velocity identity`,
  );
  assert.strictEqual(actual.visualRig, expected.visualRig, `${label}: visual rig identity`);
  assert.strictEqual(
    actual.boostFlames,
    expected.boostFlames,
    `${label}: boost flame list identity`,
  );
  assert.strictEqual(
    actual.boostTrails,
    expected.boostTrails,
    `${label}: boost trail list identity`,
  );
}

function assertCommittedSubsystemsPreserved(
  actual: CapturedCommittedSubsystems,
  expected: CapturedCommittedSubsystems,
): void {
  assert.strictEqual(actual.storeState, expected.storeState, 'accepted store state identity');
  assert.strictEqual(
    actual.storeGeneration,
    expected.storeGeneration,
    'accepted store generation identity',
  );
  assert.equal(actual.storeGenerationId, expected.storeGenerationId, 'store generation value');
  assert.strictEqual(
    actual.storeSnapshot,
    expected.storeSnapshot,
    'accepted domain snapshot identity',
  );
  assert.deepEqual(
    actual.storeSnapshotValue,
    expected.storeSnapshotValue,
    'accepted domain snapshot value',
  );
  assert.strictEqual(actual.localState, expected.localState, 'local state identity');
  assert.deepEqual(actual.localStateValue, expected.localStateValue, 'local state value');
  assert.strictEqual(actual.carMap, expected.carMap, 'car map identity');
  assert.deepEqual(actual.carKeys, expected.carKeys, 'ordered car map keys');
  assert.equal(actual.cars.length, expected.cars.length, 'car snapshot count');
  for (let index = 0; index < expected.cars.length; index += 1) {
    const expectedCar = expected.cars[index]!;
    const actualCar = actual.cars[index]!;
    assert.equal(actualCar.sessionId, expectedCar.sessionId, `car key ${index}`);
    assertObjectPreserved(actualCar.state, expectedCar.state, `car ${expectedCar.sessionId}`);
  }

  assert.equal(actual.ball === null, expected.ball === null, 'ball presence');
  if (actual.ball !== null && expected.ball !== null) {
    assertObjectPreserved(actual.ball, expected.ball, 'ball');
  }
  assertIdentitySequence(
    actual.orderedSceneChildren,
    expected.orderedSceneChildren,
    'ordered scene children',
  );
  assert.deepEqual(actual.sceneChildNames, expected.sceneChildNames, 'scene child values');
  assert.deepEqual(actual.stats, expected.stats, 'interpolation and arrival statistics');
  assert.equal(actual.notificationCount, expected.notificationCount, 'notification count');
}

function assertLocalStateMatchesDomain(
  localState: Readonly<StateSync>,
  snapshot: Readonly<DomainSnapshot>,
): void {
  assert.equal(localState.sequence, snapshot.sequence);
  assert.equal(localState.serverTime, snapshot.serverTime);
  assert.equal(localState.simulationTime, snapshot.simulationTime);
  assert.equal(localState.blueScore, snapshot.blueScore);
  assert.equal(localState.orangeScore, snapshot.orangeScore);
  assert.equal(localState.timeRemaining, snapshot.regulationSecondsRemaining);
  assert.equal(localState.phase, snapshot.phase);
  assert.deepEqual(
    Object.keys(localState.players),
    snapshot.cars.map((car) => car.sessionId),
  );

  for (const car of snapshot.cars) {
    const player = localState.players[car.sessionId];
    assert.ok(player, `missing local player ${car.sessionId}`);
    assert.deepEqual(
      [player.x, player.y, player.z],
      car.position,
      `local position for ${car.sessionId}`,
    );
    assert.deepEqual(
      [player.qx, player.qy, player.qz, player.qw],
      car.rotation,
      `local rotation for ${car.sessionId}`,
    );
    assert.deepEqual(
      [player.vx, player.vy, player.vz],
      car.linearVelocity,
      `local velocity for ${car.sessionId}`,
    );
    assert.equal(player.boost, car.boost);
    assert.equal(player.team, car.team);
    assert.equal(player.name, car.name);
    assert.equal(player.isHost, car.isHost);
  }

  assert.deepEqual(
    [localState.ball.x, localState.ball.y, localState.ball.z],
    snapshot.ball.position,
  );
  assert.deepEqual(
    [localState.ball.qx, localState.ball.qy, localState.ball.qz, localState.ball.qw],
    snapshot.ball.rotation,
  );
  assert.deepEqual(
    [localState.ball.vx, localState.ball.vy, localState.ball.vz],
    snapshot.ball.linearVelocity,
  );
}

function assertSceneMembership(
  scene: THREE.Scene,
  carMap: ReadonlyMap<string, THREE.Group>,
  ball: THREE.Group,
): void {
  const expected = new Set<THREE.Object3D>([ball, ...carMap.values()]);
  assert.equal(scene.children.length, expected.size, 'scene entity count');
  assert.equal(new Set(scene.children).size, scene.children.length, 'scene child uniqueness');
  for (const child of scene.children) {
    assert.equal(expected.has(child), true, `unexpected scene child ${child.name}`);
    assert.strictEqual(child.parent, scene);
  }
  for (const child of expected) assert.equal(scene.children.includes(child), true);
}

function assertAtomicPublication(
  observation: PublicationObservation,
  previousStoreState: AcceptedSnapshotState,
  currentStoreState: AcceptedSnapshotState,
  currentLocalState: Readonly<StateSync>,
  currentCarMap: ReadonlyMap<string, THREE.Group>,
  currentBall: THREE.Group,
  scene: THREE.Scene,
  currentStats: RuntimeInterpolationStats,
): void {
  assert.equal(observation.change.type, 'commit');
  assert.strictEqual(observation.change.previous, previousStoreState);
  assert.strictEqual(observation.change.current, currentStoreState);
  assert.strictEqual(observation.storeState, currentStoreState);
  assert.strictEqual(observation.generation, currentStoreState.generation);
  assert.strictEqual(observation.localState, currentLocalState);
  assert.strictEqual(observation.carMap, currentCarMap);
  assert.deepEqual(observation.carKeys, [...currentCarMap.keys()]);
  assertIdentitySequence(observation.carMeshes, [...currentCarMap.values()], 'published car meshes');
  assert.strictEqual(observation.ball, currentBall);
  assertIdentitySequence(
    observation.orderedSceneChildren,
    scene.children,
    'published scene children',
  );
  assert.deepEqual(observation.stats, currentStats);
  assert.equal(observation.storeState.snapshot?.sequence, currentLocalState.sequence);
  assert.equal(observation.stats.latestSequence, currentLocalState.sequence);
}

function assertAcceptedPayload(
  room: FakeRoom,
  scene: THREE.Scene,
  roomMode: RoomMode,
  payload: MutableRecord,
  notifications: PublicationObservation[],
): Readonly<DomainSnapshot> {
  const previousStoreState = acceptedSnapshotStore.getState();
  const previousLocalState = getLocalState();
  const previousCarMap = getCarMeshes();
  const previousCars = new Map(previousCarMap);
  const previousBall = getBallMesh();
  const previousStats = getInterpolationStats();
  const previousNotificationCount = notifications.length;
  const payloadValue = cloneValue(payload);
  const decoded = decodeSnapshot(payload, {
    roomMode,
    previousSnapshot: previousStoreState.snapshot,
  });
  assert.equal(decoded.ok, true, 'generated accepted payload must decode');
  if (!decoded.ok) throw decoded.error;

  room.emit(payload);

  assert.deepEqual(payload, payloadValue, 'accepted input payload must remain unchanged');
  const currentStoreState = acceptedSnapshotStore.getState();
  const currentLocalState = getLocalState();
  const currentCarMap = getCarMeshes();
  const currentBall = getBallMesh();
  const currentStats = getInterpolationStats();
  assert.notStrictEqual(currentStoreState, previousStoreState, 'store state must advance once');
  assert.strictEqual(
    currentStoreState.generation,
    previousStoreState.generation,
    'acceptance must retain the joined-room generation',
  );
  assert.deepEqual(currentStoreState.snapshot, decoded.snapshot);
  assert.equal(Object.isFrozen(currentStoreState.snapshot), true);
  assert.ok(currentLocalState, 'accepted payload must publish local state');
  assert.notStrictEqual(currentLocalState, previousLocalState, 'local state identity must advance');
  assert.equal(Object.isFrozen(currentLocalState), true);
  assertLocalStateMatchesDomain(currentLocalState, decoded.snapshot);
  assert.notStrictEqual(currentCarMap, previousCarMap, 'car map identity must advance');
  assert.ok(currentBall, 'accepted payload must publish a ball mesh');
  assertSceneMembership(scene, currentCarMap, currentBall);
  assert.deepEqual(
    [...currentCarMap.keys()].sort(),
    decoded.snapshot.cars.map((car) => car.sessionId).sort(),
  );

  for (const car of decoded.snapshot.cars) {
    const mesh = currentCarMap.get(car.sessionId);
    assert.ok(mesh, `missing committed car mesh ${car.sessionId}`);
    const previousMesh = previousCars.get(car.sessionId);
    const previousTeam = previousLocalState?.players[car.sessionId]?.team;
    if (previousMesh !== undefined && previousTeam === car.team) {
      assert.strictEqual(mesh, previousMesh, `same-team identity ${car.sessionId} must be retained`);
    } else {
      if (previousMesh !== undefined) assert.notStrictEqual(mesh, previousMesh);
      assert.deepEqual(mesh.position.toArray(), car.position);
      assert.deepEqual(mesh.quaternion.toArray(), car.rotation);
      assert.equal(mesh.userData.team, car.team);
      assert.equal(mesh.userData.lastBoost, car.boost);
      assert.deepEqual(
        (mesh.userData.syncedVelocity as THREE.Vector3).toArray(),
        car.linearVelocity,
      );
    }
    assert.strictEqual(mesh.parent, scene);
  }

  for (const [sessionId, previousMesh] of previousCars) {
    const nextCar = decoded.snapshot.cars.find((car) => car.sessionId === sessionId);
    const retained = nextCar !== undefined
      && previousLocalState?.players[sessionId]?.team === nextCar.team;
    assert.strictEqual(previousMesh.parent, retained ? scene : null);
  }

  if (previousBall === null) {
    assert.deepEqual(currentBall.position.toArray(), decoded.snapshot.ball.position);
    assert.deepEqual(currentBall.quaternion.toArray(), decoded.snapshot.ball.rotation);
    assert.deepEqual(
      (currentBall.userData.syncedVelocity as THREE.Vector3).toArray(),
      decoded.snapshot.ball.linearVelocity,
    );
  } else {
    assert.strictEqual(currentBall, previousBall, 'ball identity must be retained');
  }
  assert.strictEqual(currentBall.parent, scene);

  assert.equal(currentStats.acceptedSnapshots, previousStats.acceptedSnapshots + 1);
  assert.equal(currentStats.rejectedSnapshots, previousStats.rejectedSnapshots);
  assert.equal(currentStats.latestSequence, decoded.snapshot.sequence);
  assert.equal(notifications.length, previousNotificationCount + 1);
  assertAtomicPublication(
    notifications[previousNotificationCount]!,
    previousStoreState,
    currentStoreState,
    currentLocalState,
    currentCarMap,
    currentBall,
    scene,
    currentStats,
  );
  return currentStoreState.snapshot!;
}

function noteValidTransitionCoverage(
  coverage: Set<string>,
  baseline: readonly CarPlan[],
  accepted: readonly CarPlan[],
): void {
  if (accepted.length === 0) coverage.add('empty');
  const baselineById = new Map(baseline.map((car) => [car.sessionId, car]));
  const acceptedById = new Map(accepted.map((car) => [car.sessionId, car]));
  if (accepted.some((car) => !baselineById.has(car.sessionId))) coverage.add('addition');
  if (baseline.some((car) => !acceptedById.has(car.sessionId))) coverage.add('removal');
  if (accepted.some((car) => baselineById.get(car.sessionId)?.team === car.team)) {
    coverage.add('retention');
  }
  if (
    baseline.length === 1
    && accepted.length === 1
    && baseline[0]!.sessionId !== accepted[0]!.sessionId
  ) {
    coverage.add('identity-replacement');
  }
  if (accepted.some((car) => {
    const prior = baselineById.get(car.sessionId);
    return prior !== undefined && prior.team !== car.team;
  })) {
    coverage.add('team-replacement');
  }
}

// **Validates: Requirements 6.9-6.12, 18.25**
test('Property 8: generated client snapshot acceptance and rejection is atomic', () => {
  const generated = generateCases({
    seed: RECORDED_SEED,
    count: GENERATED_BUNDLE_COUNT,
    generate: generateOperationBundle,
  });
  const regenerated = generateCases({
    seed: RECORDED_SEED,
    count: GENERATED_BUNDLE_COUNT,
    generate: generateOperationBundle,
  });

  assert.ok(GENERATED_BUNDLE_COUNT >= 100);
  assert.deepEqual(regenerated, generated, 'recorded-seed generation must be deterministic');
  const replayIndexes = new Set<number>([
    ...REJECTION_KINDS.map((_, index) => index),
    Math.floor(GENERATED_BUNDLE_COUNT / 2),
    GENERATED_BUNDLE_COUNT - 1,
  ]);
  for (const index of replayIndexes) {
    assert.deepEqual(
      replayCase(RECORDED_SEED, index, generateOperationBundle),
      generated[index],
      `recorded seed must replay generated bundle ${index}`,
    );
  }

  const rejectionCoverage = new Set<RejectionKind>();
  const validTransitionCoverage = new Set<string>();
  let acceptedPayloadCount = 0;
  let decoderRejectedPayloadCount = 0;

  assertGeneratedCases(generated, (bundle, generatedCase) => {
    assert.equal(generatedCase.seed, RECORDED_SEED);
    assert.equal(generatedCase.index, bundle.caseIndex);

    const scene = new ControlledScene();
    const room = new FakeRoom();
    const controls: FactoryControls = {
      preparationFailure: null,
      preparationFailures: 0,
      factoryOrdinal: 0,
    };
    let clock = 50_000 + bundle.caseIndex * 100;
    setupStateListener(asRoom(room), scene, {
      roomMode: bundle.roomMode,
      carMeshFactory: createCarFactory(controls),
      ballMeshFactory: createBallFactory(),
      clock: () => {
        clock += 11;
        return clock;
      },
    });

    const notifications: PublicationObservation[] = [];
    const unsubscribe = acceptedSnapshotStore.subscribe((change) => {
      const carMap = getCarMeshes();
      notifications.push({
        change,
        storeState: acceptedSnapshotStore.getState(),
        generation: acceptedSnapshotStore.getGeneration(),
        localState: getLocalState(),
        carMap,
        carKeys: Object.freeze([...carMap.keys()]),
        carMeshes: Object.freeze([...carMap.values()]),
        ball: getBallMesh(),
        orderedSceneChildren: Object.freeze([...scene.children]),
        stats: getInterpolationStats(),
      });
    });

    try {
      assert.equal(acceptedSnapshotStore.getSnapshot(), null);
      assert.equal(getLocalState(), null);
      assert.equal(getCarMeshes().size, 0);
      assert.equal(getBallMesh(), null);
      assert.equal(scene.children.length, 0);

      const baselinePayload = buildPayload(bundle, bundle.baselineCars, 0);
      const baseline = assertAcceptedPayload(
        room,
        scene,
        bundle.roomMode,
        baselinePayload,
        notifications,
      );
      acceptedPayloadCount += 1;

      const beforeRejection = captureCommittedSubsystems(scene, notifications.length);
      const candidate = createRejectedCandidate(bundle, baseline);
      const candidateValue = cloneValue(candidate.payload);
      const validation = decodeSnapshot(candidate.payload, {
        roomMode: bundle.roomMode,
        previousSnapshot: baseline,
      });
      if (candidate.expectedDecoderError === null) {
        assert.equal(validation.ok, true, 'listener-stage rejection must pass decoding');
      } else {
        assert.equal(validation.ok, false, 'decoder rejection must fail decoding');
        if (validation.ok) throw new Error('expected generated decoder rejection');
        assert.equal(validation.error.code, candidate.expectedDecoderError);
        decoderRejectedPayloadCount += 1;
      }

      const preparationFailuresBefore = controls.preparationFailures;
      const sceneFailuresBefore = scene.rejectedCarAdds;
      if (candidate.preparationFailureMode !== undefined) {
        controls.preparationFailure = {
          remainingCalls: 2,
          mode: candidate.preparationFailureMode,
        };
      }
      if (candidate.sceneCommitFailure) scene.rejectCarAdd(2);

      room.emit(candidate.payload);

      assert.deepEqual(candidate.payload, candidateValue, 'rejected input payload must remain unchanged');
      if (candidate.preparationFailureMode !== undefined) {
        assert.equal(controls.preparationFailures, preparationFailuresBefore + 1);
        assert.equal(controls.preparationFailure, null);
      } else {
        assert.equal(controls.preparationFailures, preparationFailuresBefore);
      }
      if (candidate.sceneCommitFailure) {
        assert.equal(scene.rejectedCarAdds, sceneFailuresBefore + 1);
      } else {
        assert.equal(scene.rejectedCarAdds, sceneFailuresBefore);
      }

      const afterRejection = captureCommittedSubsystems(scene, notifications.length);
      assertCommittedSubsystemsPreserved(afterRejection, beforeRejection);
      rejectionCoverage.add(bundle.rejectionKind);

      const acceptedPayload = buildPayload(bundle, bundle.acceptedCars, 1);
      assertAcceptedPayload(
        room,
        scene,
        bundle.roomMode,
        acceptedPayload,
        notifications,
      );
      acceptedPayloadCount += 1;
      noteValidTransitionCoverage(
        validTransitionCoverage,
        bundle.baselineCars,
        bundle.acceptedCars,
      );
    } finally {
      try {
        unsubscribe();
      } finally {
        room.leave();
      }
    }
  });

  assert.deepEqual(
    [...rejectionCoverage].sort(),
    [...REJECTION_KINDS].sort(),
    'every required rejection and transaction-failure class must be generated',
  );
  assert.deepEqual(
    [...validTransitionCoverage].sort(),
    [
      'addition',
      'empty',
      'identity-replacement',
      'removal',
      'retention',
      'team-replacement',
    ],
    'generated valid acceptance must cover each reconciliation shape',
  );
  assert.ok(acceptedPayloadCount >= 100, 'at least 100 generated valid payloads must commit');
  assert.ok(
    decoderRejectedPayloadCount >= 100,
    'at least 100 generated malformed/stream-invalid payloads must be rejected',
  );
  assert.equal(acceptedSnapshotStore.getSnapshot(), null);
  assert.equal(getLocalState(), null);
  assert.equal(getCarMeshes().size, 0);
  assert.equal(getBallMesh(), null);
});
