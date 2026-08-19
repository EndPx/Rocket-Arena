import assert from 'node:assert/strict';
import test from 'node:test';
import type { Room } from 'colyseus.js';
import * as THREE from 'three';
import {
  ROOM_POLICIES,
  SNAPSHOT_PROTOCOL_VERSION,
  type RoomMode,
} from '@rocket-arena/shared';
import { acceptedSnapshotStore } from '../src/networking/accepted-snapshot-store.js';
import {
  clearEntityMeshes,
  getBallMesh,
  getCarMeshes,
  getInterpolationStats,
  getLocalState,
  setupStateListener,
} from '../src/networking/state-listener.js';

type MessageHandler = (payload: unknown) => void;
type LeaveHandler = () => void;
type MutableRecord = Record<string, unknown>;

class FakeRoom {
  readonly name: string;
  private readonly messageHandlers = new Map<string, MessageHandler[]>();
  private readonly leaveHandlers: LeaveHandler[] = [];

  constructor(name: string) {
    this.name = name;
  }

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
    for (const handler of this.leaveHandlers) handler();
  }
}

class ControlledScene extends THREE.Scene {
  rejectedObjectName: string | null = null;

  override add(...objects: THREE.Object3D[]): this {
    if (objects.some((object) => object.name === this.rejectedObjectName)) {
      throw new Error(`injected scene failure for ${this.rejectedObjectName}`);
    }
    return super.add(...objects);
  }
}

function payload(
  roomMode: RoomMode,
  sessionIds: readonly string[],
  sequence: number,
): MutableRecord {
  const policy = ROOM_POLICIES[roomMode];
  const blueCount = Math.min(policy.teamCapacity, Math.ceil(sessionIds.length / 2));
  return {
    protocolVersion: SNAPSHOT_PROTOCOL_VERSION,
    policyVersion: policy.version,
    roomMode,
    totalCapacity: policy.totalCapacity,
    teamCapacity: policy.teamCapacity,
    sequence,
    serverTime: 10_000 + sequence * 33,
    simulationTime: 1_000 + sequence * 16,
    phase: 'playing',
    countdownKind: null,
    phaseSecondsRemaining: 0,
    regulationSecondsRemaining: 240,
    kickoffEpoch: 2,
    blueScore: sequence,
    orangeScore: 0,
    winner: null,
    terminalResult: null,
    latestTransition: null,
    cars: sessionIds.map((sessionId, index) => ({
      sessionId,
      team: index < blueCount ? 'blue' : 'orange',
      name: `Driver ${sessionId}`,
      isHost: roomMode === 'custom' && index === 0,
      position: [index + sequence, 0.5, -index],
      rotation: [0, 0, 0, 1],
      linearVelocity: [index, 0, 0],
      boost: Math.min(100, index * 10),
    })),
    ball: {
      position: [0, 0.9125, sequence],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 1],
    },
  };
}

function asRoom(room: FakeRoom): Room {
  return room as unknown as Room;
}

function simpleCarFactory(team: string): THREE.Group {
  const group = new THREE.Group();
  group.name = `test-car-${team}`;
  return group;
}

function simpleBallFactory(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'test-ball';
  return group;
}

function setup(
  room: FakeRoom,
  scene: THREE.Scene,
  roomMode: RoomMode,
  carMeshFactory: (team: string) => THREE.Group = simpleCarFactory,
): void {
  let time = 1_000;
  setupStateListener(asRoom(room), scene, {
    roomMode,
    carMeshFactory,
    ballMeshFactory: simpleBallFactory,
    clock: () => {
      time += 33;
      return time;
    },
  });
}

// **Validates: Requirements 6.9-6.12**
test('atomically reconciles zero-through-eight cars, removals, and identity reconnects', () => {
  const scene = new THREE.Scene();
  const room = new FakeRoom('custom');
  setup(room, scene, 'custom');
  const notifications: number[] = [];
  const unsubscribe = acceptedSnapshotStore.subscribe((change) => {
    if (change.type === 'commit' && change.current.snapshot) {
      notifications.push(change.current.snapshot.sequence);
    }
  });

  try {
    const ids = Array.from({ length: 8 }, (_, index) => `driver-${index}`);
    room.emit(payload('custom', ids, 1));

    assert.equal(getCarMeshes().size, 8);
    assert.equal(scene.children.length, 9, 'eight cars and one ball commit together');
    assert.equal(getLocalState()?.sequence, 1);
    assert.equal(acceptedSnapshotStore.getSnapshot()?.sequence, 1);
    assert.equal(getInterpolationStats().acceptedSnapshots, 1);
    assert.deepEqual(notifications, [1]);
    assert.equal(Object.isFrozen(getLocalState()), true);
    assert.ok(getBallMesh());
    const originalMeshes = new Map(getCarMeshes());

    room.emit(payload('custom', [], 2));
    assert.equal(getCarMeshes().size, 0);
    assert.equal(scene.children.length, 1, 'the ball remains represented by the accepted snapshot');
    assert.equal(getLocalState()?.sequence, 2);
    assert.equal(acceptedSnapshotStore.getSnapshot()?.cars.length, 0);
    for (const mesh of originalMeshes.values()) assert.equal(mesh.parent, null);

    room.emit(payload('custom', [...ids].reverse(), 3));
    assert.equal(getCarMeshes().size, 8);
    assert.equal(scene.children.length, 9);
    assert.equal(getLocalState()?.sequence, 3);
    assert.deepEqual(notifications, [1, 2, 3]);
    for (const sessionId of ids) {
      assert.notStrictEqual(getCarMeshes().get(sessionId), originalMeshes.get(sessionId));
    }
  } finally {
    unsubscribe();
    room.leave();
  }

  assert.equal(scene.children.length, 0);
  assert.equal(acceptedSnapshotStore.getSnapshot(), null);
});

test('decoder and mesh-preparation failures preserve every previously accepted subsystem', () => {
  const scene = new ControlledScene();
  const room = new FakeRoom('arena');
  let factoryCalls = 0;
  let failOnCall: number | null = null;
  let disposedPreparedEffects = 0;
  const factory = (team: string): THREE.Group => {
    factoryCalls += 1;
    if (factoryCalls === failOnCall) throw new Error('injected car preparation failure');

    const group = simpleCarFactory(team);
    const material = new THREE.MeshBasicMaterial();
    material.addEventListener('dispose', () => { disposedPreparedEffects += 1; });
    const effect = new THREE.Mesh(new THREE.BufferGeometry(), material);
    group.userData.visualRig = { boostFlames: [effect], boostTrails: [] };
    return group;
  };
  setup(room, scene, 'quick', factory);

  try {
    room.emit(payload('quick', ['stable'], 1));
    const beforeLocal = getLocalState();
    const beforeStore = acceptedSnapshotStore.getState();
    const beforeMeshes = new Map(getCarMeshes());
    const beforeChildren = [...scene.children];
    const beforeStats = getInterpolationStats();
    let notifications = 0;
    const unsubscribe = acceptedSnapshotStore.subscribe(() => { notifications += 1; });

    const unsupported = payload('quick', ['stable'], 2);
    unsupported.protocolVersion = 999;
    room.emit(unsupported);
    room.emit(payload('quick', ['stable'], 1));
    room.emit(payload('quick', Array.from({ length: 7 }, (_, index) => `too-many-${index}`), 2));
    room.emit(payload('quick', ['duplicate', 'duplicate'], 2));
    const malformed = payload('quick', ['stable'], 2);
    delete (malformed.ball as MutableRecord).rotation;
    room.emit(malformed);

    assert.strictEqual(getLocalState(), beforeLocal);
    assert.strictEqual(acceptedSnapshotStore.getState(), beforeStore);
    assert.deepEqual([...getCarMeshes()], [...beforeMeshes]);
    assert.deepEqual(scene.children, beforeChildren);
    assert.deepEqual(getInterpolationStats(), beforeStats);
    assert.equal(notifications, 0);

    failOnCall = factoryCalls + 2;
    room.emit(payload('quick', ['stable', 'new-a', 'new-b'], 2));
    assert.strictEqual(getLocalState(), beforeLocal);
    assert.strictEqual(acceptedSnapshotStore.getState(), beforeStore);
    assert.deepEqual([...getCarMeshes()], [...beforeMeshes]);
    assert.deepEqual(scene.children, beforeChildren);
    assert.deepEqual(getInterpolationStats(), beforeStats);
    assert.equal(notifications, 0);
    assert.equal(disposedPreparedEffects, 1, 'only the detached prepared car is disposed');

    failOnCall = null;
    scene.rejectedObjectName = 'test-car-orange';
    room.emit(payload('quick', ['stable', 'new-a', 'new-b'], 2));
    assert.strictEqual(getLocalState(), beforeLocal);
    assert.strictEqual(acceptedSnapshotStore.getState(), beforeStore);
    assert.deepEqual([...getCarMeshes()], [...beforeMeshes]);
    assert.deepEqual(scene.children, beforeChildren);
    assert.deepEqual(getInterpolationStats(), beforeStats);
    assert.equal(notifications, 0);
    assert.equal(disposedPreparedEffects, 3, 'all detached commit candidates are disposed');

    scene.rejectedObjectName = null;
    room.emit(payload('quick', ['stable', 'new-a', 'new-b'], 2));
    assert.equal(getLocalState()?.sequence, 2);
    assert.equal(acceptedSnapshotStore.getSnapshot()?.sequence, 2);
    assert.equal(getCarMeshes().size, 3);
    assert.equal(getInterpolationStats().acceptedSnapshots, 2);
    assert.equal(notifications, 1);
    unsubscribe();
  } finally {
    room.leave();
  }
});

test('a replacement room invalidates late snapshots and leave callbacks from the prior room', () => {
  const scene = new THREE.Scene();
  const firstRoom = new FakeRoom('arena');
  setup(firstRoom, scene, 'quick');
  firstRoom.emit(payload('quick', ['first-driver'], 5));
  assert.equal(getLocalState()?.sequence, 5);

  const secondRoom = new FakeRoom('arena');
  setup(secondRoom, scene, 'quick');
  secondRoom.emit(payload('quick', ['second-driver'], 1));
  const secondState = getLocalState();
  const secondStore = acceptedSnapshotStore.getState();
  const secondMeshes = new Map(getCarMeshes());

  firstRoom.emit(payload('quick', ['late-first'], 6));
  firstRoom.leave();
  assert.strictEqual(getLocalState(), secondState);
  assert.strictEqual(acceptedSnapshotStore.getState(), secondStore);
  assert.deepEqual([...getCarMeshes()], [...secondMeshes]);

  secondRoom.leave();
  assert.equal(scene.children.length, 0);
  assert.equal(acceptedSnapshotStore.getSnapshot(), null);
});

test('accepted same-identity updates retain meshes while all snapshot views advance', () => {
  const scene = new THREE.Scene();
  const room = new FakeRoom('arena');
  setup(room, scene, 'quick');

  try {
    room.emit(payload('quick', ['stable-driver'], 1));
    const retainedCar = getCarMeshes().get('stable-driver');
    const retainedBall = getBallMesh();
    assert.ok(retainedCar);
    assert.ok(retainedBall);

    const updated = payload('quick', ['stable-driver'], 2);
    const updatedCar = (updated.cars as MutableRecord[])[0];
    updatedCar.boost = 77;
    updatedCar.name = 'Updated Driver';
    room.emit(updated);

    assert.strictEqual(getCarMeshes().get('stable-driver'), retainedCar);
    assert.strictEqual(getBallMesh(), retainedBall);
    assert.equal(getLocalState()?.sequence, 2);
    assert.equal(getLocalState()?.players['stable-driver']?.x, 2);
    assert.equal(getLocalState()?.players['stable-driver']?.boost, 77);
    assert.equal(getLocalState()?.players['stable-driver']?.name, 'Updated Driver');
    assert.equal(acceptedSnapshotStore.getSnapshot()?.sequence, 2);
    assert.equal(acceptedSnapshotStore.getSnapshot()?.cars[0]?.boost, 77);
    assert.equal(getInterpolationStats().latestSequence, 2);
    assert.equal(getInterpolationStats().acceptedSnapshots, 2);
    assert.equal(scene.children.length, 2);
  } finally {
    room.leave();
  }
});

test('legacy V1 goal-reset snapshots retain their active wire timer', () => {
  const scene = new THREE.Scene();
  const room = new FakeRoom('arena');
  setup(room, scene, 'quick');

  const modern = payload('quick', ['legacy-driver'], 1);
  const modernCar = (modern.cars as MutableRecord[])[0];
  const position = modernCar.position as number[];
  const rotation = modernCar.rotation as number[];
  const velocity = modernCar.linearVelocity as number[];
  const modernBall = modern.ball as MutableRecord;
  const ballPosition = modernBall.position as number[];
  const ballRotation = modernBall.rotation as number[];
  const ballVelocity = modernBall.linearVelocity as number[];
  const legacy = {
    sequence: modern.sequence,
    serverTime: modern.serverTime,
    simulationTime: modern.simulationTime,
    players: {
      'legacy-driver': {
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
        boost: modernCar.boost,
        team: modernCar.team,
        name: modernCar.name,
        isHost: modernCar.isHost,
      },
    },
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
    blueScore: 1,
    orangeScore: 0,
    timeRemaining: 2.75,
    phase: 'goal-reset',
  };

  try {
    room.emit(legacy);
    assert.equal(acceptedSnapshotStore.getSnapshot()?.wireFormat, 'legacy-v1');
    assert.equal(getLocalState()?.phase, 'goal-reset');
    assert.equal(getLocalState()?.timeRemaining, 2.75);
  } finally {
    room.leave();
  }
});

test('an added callback can replace the room without resurrecting stale state', () => {
  const scene = new THREE.Scene();
  const firstRoom = new FakeRoom('arena');
  const secondRoom = new FakeRoom('arena');
  let replaceOnAdd = false;
  let replacementInstalled = false;
  const reentrantFactory = (team: string): THREE.Group => {
    const group = simpleCarFactory(team);
    group.addEventListener('added', () => {
      if (!replaceOnAdd || replacementInstalled) return;
      replacementInstalled = true;
      setup(secondRoom, scene, 'quick');
    });
    return group;
  };
  setup(firstRoom, scene, 'quick', reentrantFactory);

  firstRoom.emit(payload('quick', ['first-driver'], 1));
  assert.equal(getLocalState()?.sequence, 1);
  replaceOnAdd = true;
  firstRoom.emit(payload('quick', ['first-driver', 'stale-addition'], 2));

  assert.equal(replacementInstalled, true);
  assert.equal(getLocalState(), null);
  assert.equal(acceptedSnapshotStore.getSnapshot(), null);
  assert.equal(getCarMeshes().size, 0);
  assert.equal(getBallMesh(), null);
  assert.equal(scene.children.length, 0);
  assert.equal(getInterpolationStats().latestSequence, null);
  assert.equal(getInterpolationStats().acceptedSnapshots, 0);

  secondRoom.emit(payload('quick', ['second-driver'], 1));
  assert.equal(getLocalState()?.sequence, 1);
  assert.equal(acceptedSnapshotStore.getSnapshot()?.cars[0]?.sessionId, 'second-driver');
  assert.deepEqual([...getCarMeshes().keys()], ['second-driver']);
  assert.equal(scene.children.length, 2);

  firstRoom.leave();
  assert.equal(getLocalState()?.sequence, 1, 'stale leave cannot clear the replacement room');
  secondRoom.leave();
  assert.equal(scene.children.length, 0);
});

test('car removal disposes only per-instance effects and preserves shared model resources', () => {
  const scene = new THREE.Scene();
  const room = new FakeRoom('arena');
  const sharedGeometry = new THREE.BoxGeometry(1, 1, 1);
  const sharedMaterial = new THREE.MeshBasicMaterial();
  let sharedGeometryDisposals = 0;
  let sharedMaterialDisposals = 0;
  let effectDisposals = 0;
  sharedGeometry.addEventListener('dispose', () => { sharedGeometryDisposals += 1; });
  sharedMaterial.addEventListener('dispose', () => { sharedMaterialDisposals += 1; });

  const sharedResourceFactory = (team: string): THREE.Group => {
    const group = simpleCarFactory(team);
    group.add(new THREE.Mesh(sharedGeometry, sharedMaterial));
    const effectMaterial = new THREE.MeshBasicMaterial();
    effectMaterial.addEventListener('dispose', () => { effectDisposals += 1; });
    const effect = new THREE.Mesh(new THREE.BufferGeometry(), effectMaterial);
    group.add(effect);
    group.userData.visualRig = { boostFlames: [effect], boostTrails: [] };
    return group;
  };
  setup(room, scene, 'quick', sharedResourceFactory);

  try {
    room.emit(payload('quick', ['removed-driver'], 1));
    room.emit(payload('quick', [], 2));
    assert.equal(effectDisposals, 1);
    assert.equal(sharedGeometryDisposals, 0);
    assert.equal(sharedMaterialDisposals, 0);

    room.emit(payload('quick', ['departing-driver'], 3));
  } finally {
    room.leave();
  }

  assert.equal(effectDisposals, 2, 'leave disposes the remaining car effect once');
  assert.equal(sharedGeometryDisposals, 0, 'cached body geometry remains process-owned');
  assert.equal(sharedMaterialDisposals, 0, 'cached body material remains process-owned');
  sharedGeometry.dispose();
  sharedMaterial.dispose();
});

test('same-room payloads emitted from removed callbacks wait for a coherent commit', () => {
  const scene = new THREE.Scene();
  const room = new FakeRoom('arena');
  setup(room, scene, 'quick');

  try {
    room.emit(payload('quick', ['returning-driver'], 1));
    const removedMesh = getCarMeshes().get('returning-driver');
    assert.ok(removedMesh);
    let emitted = false;
    removedMesh.addEventListener('removed', () => {
      if (emitted) return;
      emitted = true;
      room.emit(payload('quick', ['returning-driver'], 3));
    });

    room.emit(payload('quick', [], 2));

    const acceptedMesh = getCarMeshes().get('returning-driver');
    assert.equal(emitted, true);
    assert.ok(acceptedMesh);
    assert.notStrictEqual(acceptedMesh, removedMesh);
    assert.strictEqual(acceptedMesh.parent, scene);
    assert.strictEqual(getBallMesh()?.parent, scene);
    assert.equal(getLocalState()?.sequence, 3);
    assert.equal(acceptedSnapshotStore.getSnapshot()?.sequence, 3);
    assert.equal(getInterpolationStats().latestSequence, 3);
    assert.equal(getInterpolationStats().acceptedSnapshots, 3);
    assert.equal(scene.children.length, 2);
  } finally {
    room.leave();
  }
});

test('payloads emitted by rollback callbacks run only after rollback completes', () => {
  const scene = new ControlledScene();
  const room = new FakeRoom('arena');
  let armRollbackEmission = false;
  let emitted = false;
  const rollbackFactory = (team: string): THREE.Group => {
    const group = simpleCarFactory(team);
    if (armRollbackEmission) {
      group.addEventListener('removed', () => {
        if (emitted) return;
        emitted = true;
        scene.rejectedObjectName = null;
        room.emit(payload('quick', ['stable', 'queued-driver'], 3));
      });
    }
    return group;
  };
  setup(room, scene, 'quick', rollbackFactory);

  try {
    room.emit(payload('quick', ['stable'], 1));
    const stableMesh = getCarMeshes().get('stable');
    assert.ok(stableMesh);

    armRollbackEmission = true;
    scene.rejectedObjectName = 'test-car-orange';
    room.emit(payload('quick', ['stable', 'prepared-blue', 'rejected-orange'], 2));

    assert.equal(emitted, true);
    assert.strictEqual(getCarMeshes().get('stable'), stableMesh);
    assert.strictEqual(stableMesh.parent, scene);
    assert.strictEqual(getCarMeshes().get('queued-driver')?.parent, scene);
    assert.strictEqual(getBallMesh()?.parent, scene);
    assert.equal(getLocalState()?.sequence, 3);
    assert.equal(acceptedSnapshotStore.getSnapshot()?.sequence, 3);
    assert.deepEqual(
      acceptedSnapshotStore.getSnapshot()?.cars.map((car) => car.sessionId),
      ['stable', 'queued-driver'],
    );
    assert.equal(getInterpolationStats().latestSequence, 3);
    assert.equal(getInterpolationStats().acceptedSnapshots, 2, 'sequence 2 was rolled back');
    assert.equal(scene.children.length, 3);
  } finally {
    room.leave();
  }
});