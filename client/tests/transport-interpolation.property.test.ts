import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FixedStepScheduler,
  type FixedStepSchedulerOptions,
  type SnapshotScheduleDecision,
} from '../../server/src/rooms/fixed-step-scheduler.js';
import {
  SnapshotBuffer,
  slerpShortest,
  type EntitySnapshot,
  type ValidatedTimelineSnapshot,
} from '../src/networking/interpolation-buffer.js';
import {
  assertGeneratedCases,
  generateCases,
  replayCase,
  type SeededRandom,
} from '../../shared/tests/support/generated-cases.js';

const RECORDED_SEED = 'rocket-arena-property-25-transport-interpolation-v1';
const GENERATED_CASE_COUNT = 144;
const REPLAY_CASE_INDICES = Object.freeze([0, 73, GENERATED_CASE_COUNT - 1]);
const DIAGNOSTIC_CASE_INDEX = 91;
const FLOAT_EPSILON = 1e-9;

interface Quaternion {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

interface SnapshotPoint {
  readonly sequence: number;
  readonly simulationTimeMs: number;
}

interface RotationScenario {
  readonly axis: readonly [number, number, number];
  readonly startAngle: number;
  readonly shortestArc: number;
  readonly startScale: number;
  readonly endScale: number;
  readonly amount: number;
  readonly baseSimulationTimeMs: number;
  readonly localTimelineOffsetMs: number;
  readonly startX: number;
  readonly endX: number;
}

interface ExtrapolationScenario {
  readonly simulationTimeMs: number;
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
  readonly laterOffsetMs: number;
}

interface KickoffBoundaryScenario {
  readonly simulationTimeMs: number;
  readonly spanMs: number;
  readonly interiorOffsetMs: number;
  readonly kickoffEpoch: number;
  readonly beforePosition: readonly [number, number, number];
  readonly afterPosition: readonly [number, number, number];
}

interface GeneratedTransportInterpolationCase {
  readonly caseIndex: number;
  readonly roomSize: number;
  readonly maxSubsteps: number;
  readonly snapshotTargetMs: number;
  readonly snapshotToleranceMs: number;
  readonly callbackPartitions: readonly (readonly number[])[];
  readonly snapshotStream: readonly SnapshotPoint[];
  readonly streamKickoffEpoch: number;
  readonly rotation: RotationScenario;
  readonly extrapolation: ExtrapolationScenario;
  readonly kickoffBoundary: KickoffBoundaryScenario;
}

interface CadenceObservation {
  readonly callbackDeltaMs: number;
  readonly fixedSteps: number;
  readonly decision: SnapshotScheduleDecision;
}

interface CadenceTrace {
  readonly initialDecision: SnapshotScheduleDecision;
  readonly observations: readonly CadenceObservation[];
  readonly totalFixedSteps: number;
  readonly simulatedCarUpdates: number;
}

function partitionPositiveTotal(
  random: SeededRandom,
  total: number,
  partCount: number,
): readonly number[] {
  const weights = Array.from(
    { length: partCount },
    () => 0.25 + random.next(),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const parts: number[] = [];
  let assigned = 0;

  for (let index = 0; index < partCount - 1; index += 1) {
    const part = total * weights[index]! / totalWeight;
    parts.push(part);
    assigned += part;
  }
  parts.push(total - assigned);
  return parts;
}

function generateCadencePartition(
  random: SeededRandom,
  targetIntervalMs: number,
  toleranceMs: number,
): readonly number[] {
  const earliestDueMs = targetIntervalMs - toleranceMs;
  const dueElapsedMs = toleranceMs === 0
    ? targetIntervalMs
    : earliestDueMs + toleranceMs * (0.1 + random.next() * 0.8);
  const pendingTotalMs = earliestDueMs * (0.25 + random.next() * 0.5);
  const pendingParts = partitionPositiveTotal(
    random,
    pendingTotalMs,
    random.integer(1, 5),
  );
  return Object.freeze([...pendingParts, dueElapsedMs - pendingTotalMs]);
}

function generateTransportInterpolationCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedTransportInterpolationCase {
  const usesNominalCadence = caseIndex % 4 === 0;
  const snapshotTargetMs = usesNominalCadence
    ? 33
    : random.integer(20, 60);
  const snapshotToleranceMs = usesNominalCadence
    ? 1
    : random.integer(0, Math.min(8, snapshotTargetMs - 1));
  const callbackPartitions = Array.from(
    { length: random.integer(5, 9) },
    () => generateCadencePartition(
      random,
      snapshotTargetMs,
      snapshotToleranceMs,
    ),
  );

  const snapshotStream: SnapshotPoint[] = [];
  let sequence = random.integer(0, 10_000);
  let simulationTimeMs = random.integer(1_000, 20_000);
  const streamLength = random.integer(25, 52);
  for (let index = 0; index < streamLength; index += 1) {
    sequence += random.integer(1, 9);
    simulationTimeMs += random.integer(8, 50);
    snapshotStream.push(Object.freeze({ sequence, simulationTimeMs }));
  }

  const azimuth = random.next() * Math.PI * 2;
  const axisZ = random.next() * 2 - 1;
  const axisRadius = Math.sqrt(1 - axisZ * axisZ);
  const startX = random.integer(-100, 100) / 10;
  let positionDelta = random.integer(-60, 60) / 10;
  if (positionDelta === 0) positionDelta = 1;

  const extrapolationVelocity: [number, number, number] = [
    random.integer(-200, 200) / 10,
    random.integer(-200, 200) / 10,
    random.integer(-200, 200) / 10,
  ];
  if (extrapolationVelocity.every((component) => component === 0)) {
    extrapolationVelocity[0] = 1;
  }

  const kickoffSimulationTimeMs = random.integer(5_000, 50_000);
  const kickoffSpanMs = random.integer(20, 500);
  const beforeX = random.integer(-500, 500) / 10;

  return Object.freeze({
    caseIndex,
    roomSize: caseIndex % 9,
    maxSubsteps: random.integer(1, 5),
    snapshotTargetMs,
    snapshotToleranceMs,
    callbackPartitions: Object.freeze(callbackPartitions),
    snapshotStream: Object.freeze(snapshotStream),
    streamKickoffEpoch: random.integer(0, 100),
    rotation: Object.freeze({
      axis: Object.freeze([
        axisRadius * Math.cos(azimuth),
        axisRadius * Math.sin(azimuth),
        axisZ,
      ]) as readonly [number, number, number],
      startAngle: -Math.PI + random.next() * Math.PI * 2,
      shortestArc: 0.1 + random.next() * (Math.PI - 0.2),
      startScale: 2 + random.next() * 6,
      endScale: 2 + random.next() * 6,
      amount: random.integer(100, 900) / 1_000,
      baseSimulationTimeMs: random.integer(30_000, 80_000),
      localTimelineOffsetMs: random.integer(100, 10_000),
      startX,
      endX: startX + positionDelta,
    }),
    extrapolation: Object.freeze({
      simulationTimeMs: random.integer(20_000, 70_000),
      position: Object.freeze([
        random.integer(-1_000, 1_000) / 10,
        random.integer(-1_000, 1_000) / 10,
        random.integer(-1_000, 1_000) / 10,
      ]) as readonly [number, number, number],
      velocity: Object.freeze(extrapolationVelocity),
      laterOffsetMs: random.integer(1, 1_000_000),
    }),
    kickoffBoundary: Object.freeze({
      simulationTimeMs: kickoffSimulationTimeMs,
      spanMs: kickoffSpanMs,
      interiorOffsetMs: random.integer(1, kickoffSpanMs - 1),
      kickoffEpoch: random.integer(0, 1_000),
      beforePosition: Object.freeze([
        beforeX,
        random.integer(-500, 500) / 10,
        random.integer(-500, 500) / 10,
      ]) as readonly [number, number, number],
      afterPosition: Object.freeze([
        beforeX + random.integer(20, 100),
        random.integer(600, 1_000) / 10,
        random.integer(600, 1_000) / 10,
      ]) as readonly [number, number, number],
    }),
  });
}

function makeEntity(
  position: readonly [number, number, number],
  velocity: readonly [number, number, number],
  rotation: Quaternion,
): EntitySnapshot {
  return {
    x: position[0],
    y: position[1],
    z: position[2],
    qx: rotation.x,
    qy: rotation.y,
    qz: rotation.z,
    qw: rotation.w,
    vx: velocity[0],
    vy: velocity[1],
    vz: velocity[2],
  };
}

function makeSnapshot(
  sequence: number,
  simulationTime: number,
  kickoffEpoch: number,
  entities: Readonly<Record<string, EntitySnapshot>>,
): ValidatedTimelineSnapshot {
  return {
    sequence,
    serverTime: 1_700_000_000_000 + simulationTime,
    simulationTime,
    kickoffEpoch,
    entities,
  };
}

function quaternionFromAxisAngle(
  axis: readonly [number, number, number],
  angle: number,
): Quaternion {
  const halfAngle = angle / 2;
  const sine = Math.sin(halfAngle);
  return {
    x: axis[0] * sine,
    y: axis[1] * sine,
    z: axis[2] * sine,
    w: Math.cos(halfAngle),
  };
}

function scaleQuaternion(quaternion: Quaternion, scale: number): Quaternion {
  return {
    x: quaternion.x * scale,
    y: quaternion.y * scale,
    z: quaternion.z * scale,
    w: quaternion.w * scale,
  };
}

function entityQuaternion(entity: EntitySnapshot): Quaternion {
  return { x: entity.qx, y: entity.qy, z: entity.qz, w: entity.qw };
}

function quaternionDot(left: Quaternion, right: Quaternion): number {
  return left.x * right.x
    + left.y * right.y
    + left.z * right.z
    + left.w * right.w;
}

function assertClose(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) <= FLOAT_EPSILON,
    `${message}: expected ${expected}, received ${actual}`,
  );
}

function assertFiniteUnitQuaternion(
  quaternion: Quaternion,
  message: string,
): void {
  const components = [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
  assert.ok(components.every(Number.isFinite), `${message} must be finite`);
  assertClose(Math.hypot(...components), 1, `${message} length`);
}

function assertSameQuaternionPath(
  actual: Quaternion,
  expected: Quaternion,
  message: string,
): void {
  assert.ok(
    quaternionDot(actual, expected) >= 1 - FLOAT_EPSILON,
    `${message} did not follow the same signed shortest path`,
  );
}

function runCadence(
  options: FixedStepSchedulerOptions,
  callbackPartitions: readonly (readonly number[])[],
  simulatedCarCount: number,
): CadenceTrace {
  const scheduler = new FixedStepScheduler(options);
  const initialDecision = scheduler.advance(0).snapshotDecision;
  const observations: CadenceObservation[] = [];
  let totalFixedSteps = 0;
  let simulatedCarUpdates = 0;

  for (const partition of callbackPartitions) {
    for (const callbackDeltaMs of partition) {
      const frame = scheduler.advance(callbackDeltaMs);
      totalFixedSteps += frame.fixedSteps;
      for (let step = 0; step < frame.fixedSteps; step += 1) {
        for (let carIndex = 0; carIndex < simulatedCarCount; carIndex += 1) {
          simulatedCarUpdates += 1;
        }
      }
      observations.push({
        callbackDeltaMs,
        fixedSteps: frame.fixedSteps,
        decision: frame.snapshotDecision,
      });
    }
  }

  return {
    initialDecision,
    observations,
    totalFixedSteps,
    simulatedCarUpdates,
  };
}

function cadenceDecisions(trace: CadenceTrace): readonly SnapshotScheduleDecision[] {
  return [trace.initialDecision, ...trace.observations.map(({ decision }) => decision)];
}

function verifyCadence(
  generated: GeneratedTransportInterpolationCase,
): Readonly<Record<string, unknown>> {
  const options: FixedStepSchedulerOptions = {
    fixedStepSeconds: 1 / 60,
    maxFrameDeltaSeconds: 0.1,
    maxSubsteps: generated.maxSubsteps,
    snapshotIntervalMs: generated.snapshotTargetMs,
    snapshotSchedulingToleranceMs: generated.snapshotToleranceMs,
  };
  const roomTrace = runCadence(
    options,
    generated.callbackPartitions,
    generated.roomSize,
  );
  const emptyRoomTrace = runCadence(options, generated.callbackPartitions, 0);
  const fullRoomTrace = runCadence(options, generated.callbackPartitions, 8);
  const differentFixedStepTrace = runCadence({
    ...options,
    fixedStepSeconds: 0.001,
    maxSubsteps: 100,
  }, generated.callbackPartitions, generated.roomSize);

  const roomDecisions = cadenceDecisions(roomTrace);
  assert.deepEqual(roomDecisions, cadenceDecisions(emptyRoomTrace));
  assert.deepEqual(roomDecisions, cadenceDecisions(fullRoomTrace));
  assert.deepEqual(roomDecisions, cadenceDecisions(differentFixedStepTrace));
  assert.ok(
    differentFixedStepTrace.totalFixedSteps > roomTrace.totalFixedSteps,
    'the comparison schedule must execute a different fixed-step count',
  );
  assert.equal(
    roomTrace.simulatedCarUpdates,
    roomTrace.totalFixedSteps * generated.roomSize,
  );
  assert.equal(
    fullRoomTrace.simulatedCarUpdates,
    fullRoomTrace.totalFixedSteps * 8,
  );

  const earliestDueMs = generated.snapshotTargetMs - generated.snapshotToleranceMs;
  assert.deepEqual(roomTrace.initialDecision, {
    due: true,
    reason: 'initial',
    elapsedMs: 0,
    targetIntervalMs: generated.snapshotTargetMs,
    toleranceMs: generated.snapshotToleranceMs,
    earliestDueMs,
  });

  const intervalDecisions = roomTrace.observations
    .map(({ decision }) => decision)
    .filter(({ due }) => due);
  assert.equal(intervalDecisions.length, generated.callbackPartitions.length);

  for (const observation of roomTrace.observations) {
    const { decision } = observation;
    assert.equal(decision.targetIntervalMs, generated.snapshotTargetMs);
    assert.equal(decision.toleranceMs, generated.snapshotToleranceMs);
    assert.equal(decision.earliestDueMs, earliestDueMs);
    assert.ok(observation.callbackDeltaMs > 0);

    if (decision.due) {
      assert.equal(decision.reason, 'interval');
      assert.ok(
        decision.elapsedMs + FLOAT_EPSILON >= earliestDueMs,
        'due elapsed time must reach the earliest admissible tolerance boundary',
      );
      assert.ok(
        decision.elapsedMs <= generated.snapshotTargetMs + FLOAT_EPSILON,
        'generated due observation must remain within the target/tolerance window',
      );
    } else {
      assert.equal(decision.reason, 'pending');
      assert.ok(
        decision.elapsedMs < earliestDueMs + FLOAT_EPSILON,
        'pending elapsed time must remain before the admissible window',
      );
    }
  }

  return {
    dueElapsedMs: intervalDecisions.map(({ elapsedMs }) => elapsedMs),
    nominalFixedSteps: roomTrace.totalFixedSteps,
    alternateFixedSteps: differentFixedStepTrace.totalFixedSteps,
    simulatedCarUpdates: roomTrace.simulatedCarUpdates,
  };
}

function streamEntities(
  roomSize: number,
  caseIndex: number,
  pointIndex: number,
): Readonly<Record<string, EntitySnapshot>> {
  const entities: Record<string, EntitySnapshot> = {};
  for (let carIndex = 0; carIndex < roomSize; carIndex += 1) {
    entities[`car-${carIndex}`] = makeEntity(
      [carIndex * 3 + pointIndex / 100, caseIndex / 10, carIndex - pointIndex / 200],
      [(carIndex % 3) - 1, 0, (caseIndex % 5) - 2],
      { x: 0, y: 0, z: 0, w: 1 },
    );
  }
  return entities;
}

function verifyGreatestSequenceRetention(
  generated: GeneratedTransportInterpolationCase,
): readonly number[] {
  const buffer = new SnapshotBuffer();
  let previousSequence = -1;
  let previousSimulationTime = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < generated.snapshotStream.length; index += 1) {
    const point = generated.snapshotStream[index]!;
    assert.ok(point.sequence > previousSequence);
    assert.ok(point.simulationTimeMs > previousSimulationTime);
    const entities = streamEntities(generated.roomSize, generated.caseIndex, index);
    assert.equal(Object.keys(entities).length, generated.roomSize);
    assert.equal(buffer.accept(makeSnapshot(
      point.sequence,
      point.simulationTimeMs,
      generated.streamKickoffEpoch,
      entities,
    ), point.simulationTimeMs + 500 + generated.caseIndex), true);
    previousSequence = point.sequence;
    previousSimulationTime = point.simulationTimeMs;
  }

  const expectedGreatestSequences = generated.snapshotStream
    .map(({ sequence }) => sequence)
    .sort((left, right) => right - left)
    .slice(0, 24)
    .sort((left, right) => left - right);
  assert.equal(generated.snapshotStream.length > 24, true);
  assert.deepEqual(buffer.getSnapshotSequences(), expectedGreatestSequences);
  assert.equal(buffer.getStats().size, 24);
  assert.equal(buffer.getStats().acceptedSnapshots, generated.snapshotStream.length);
  assert.equal(buffer.getStats().rejectedSnapshots, 0);
  return expectedGreatestSequences;
}

function verifyDelayedShortestPathInterpolation(
  generated: GeneratedTransportInterpolationCase,
): Readonly<Record<string, unknown>> {
  const scenario = generated.rotation;
  const startUnit = quaternionFromAxisAngle(scenario.axis, scenario.startAngle);
  const endUnit = quaternionFromAxisAngle(
    scenario.axis,
    scenario.startAngle + scenario.shortestArc,
  );
  const nonUnitStart = scaleQuaternion(startUnit, scenario.startScale);
  const nonUnitCanonicalEnd = scaleQuaternion(endUnit, scenario.endScale);
  const nonUnitEquivalentSignEnd = scaleQuaternion(endUnit, -scenario.endScale);
  const canonicalPath = slerpShortest(
    nonUnitStart,
    nonUnitCanonicalEnd,
    scenario.amount,
  );
  const equivalentSignPath = slerpShortest(
    nonUnitStart,
    nonUnitEquivalentSignEnd,
    scenario.amount,
  );
  const expectedPath = quaternionFromAxisAngle(
    scenario.axis,
    scenario.startAngle + scenario.shortestArc * scenario.amount,
  );

  assert.ok(Math.abs(Math.hypot(
    nonUnitStart.x,
    nonUnitStart.y,
    nonUnitStart.z,
    nonUnitStart.w,
  ) - 1) > 0.5);
  assert.ok(Math.abs(Math.hypot(
    nonUnitEquivalentSignEnd.x,
    nonUnitEquivalentSignEnd.y,
    nonUnitEquivalentSignEnd.z,
    nonUnitEquivalentSignEnd.w,
  ) - 1) > 0.5);
  assert.ok(quaternionDot(startUnit, nonUnitEquivalentSignEnd) < 0);
  assertFiniteUnitQuaternion(canonicalPath, 'canonical quaternion interpolation');
  assertFiniteUnitQuaternion(equivalentSignPath, 'equivalent-sign quaternion interpolation');
  assertSameQuaternionPath(equivalentSignPath, canonicalPath, 'equivalent-sign interpolation');
  assertSameQuaternionPath(equivalentSignPath, expectedPath, 'shortest-path interpolation');

  const spanMs = 1_000;
  const queryOffsetMs = scenario.amount * spanMs;
  const querySimulationTimeMs = scenario.baseSimulationTimeMs + queryOffsetMs;
  const startEntity = makeEntity(
    [scenario.startX, 0, 0],
    [0, 0, 0],
    nonUnitStart,
  );
  const endEntity = makeEntity(
    [scenario.endX, 0, 0],
    [0, 0, 0],
    nonUnitEquivalentSignEnd,
  );
  const buffer = new SnapshotBuffer();
  assert.equal(buffer.accept(makeSnapshot(
    1,
    scenario.baseSimulationTimeMs,
    0,
    { car: startEntity },
  ), scenario.baseSimulationTimeMs + scenario.localTimelineOffsetMs), true);
  assert.equal(buffer.accept(makeSnapshot(
    2,
    scenario.baseSimulationTimeMs + spanMs,
    0,
    { car: endEntity },
  ), scenario.baseSimulationTimeMs + spanMs + scenario.localTimelineOffsetMs), true);

  const localNowMs = scenario.localTimelineOffsetMs + querySimulationTimeMs + 100;
  const delayedFrame = buffer.sample(localNowMs);
  const directFrame = buffer.sampleAt(querySimulationTimeMs);
  const oneMillisecondEarlier = buffer.sample(localNowMs - 1);
  assert.ok(delayedFrame && directFrame && oneMillisecondEarlier);
  assert.equal(buffer.getStats().delayMs, 100);
  assert.deepEqual(delayedFrame, directFrame);
  assert.equal(delayedFrame.simulationTime, querySimulationTimeMs);
  assert.equal(oneMillisecondEarlier.simulationTime, querySimulationTimeMs - 1);
  assert.equal(delayedFrame.mode, 'interpolated');

  const renderedEntity = delayedFrame.entities.car;
  assert.ok(renderedEntity);
  const renderedQuaternion = entityQuaternion(renderedEntity);
  assertFiniteUnitQuaternion(renderedQuaternion, 'buffer quaternion interpolation');
  assertSameQuaternionPath(
    renderedQuaternion,
    equivalentSignPath,
    'buffer equivalent-sign interpolation',
  );
  assertClose(
    renderedEntity.x,
    scenario.startX + (scenario.endX - scenario.startX) * scenario.amount,
    'delayed interpolated position',
  );

  return {
    querySimulationTimeMs,
    renderedEntity,
    equivalentSignPath,
  };
}

function verifyBoundedExtrapolation(
  generated: GeneratedTransportInterpolationCase,
): EntitySnapshot {
  const scenario = generated.extrapolation;
  const entity = makeEntity(
    scenario.position,
    scenario.velocity,
    { x: 0, y: 0, z: 0, w: 3 },
  );
  const buffer = new SnapshotBuffer();
  assert.equal(buffer.accept(makeSnapshot(
    1,
    scenario.simulationTimeMs,
    0,
    { car: entity },
  ), scenario.simulationTimeMs), true);

  const atBound = buffer.sampleAt(scenario.simulationTimeMs + 80);
  const arbitrarilyLater = buffer.sampleAt(
    scenario.simulationTimeMs + 80 + scenario.laterOffsetMs,
  );
  assert.ok(atBound && arbitrarilyLater);
  assert.equal(atBound.mode, 'extrapolated');
  assert.equal(atBound.underrun, true);
  assert.equal(atBound.simulationTime, scenario.simulationTimeMs + 80);
  assert.deepEqual(arbitrarilyLater, atBound);

  const heldEntity = atBound.entities.car;
  assert.ok(heldEntity);
  assert.ok(Object.values(heldEntity).every(Number.isFinite));
  assertClose(heldEntity.x, scenario.position[0] + scenario.velocity[0] * 0.08, 'held x');
  assertClose(heldEntity.y, scenario.position[1] + scenario.velocity[1] * 0.08, 'held y');
  assertClose(heldEntity.z, scenario.position[2] + scenario.velocity[2] * 0.08, 'held z');
  assertFiniteUnitQuaternion(entityQuaternion(heldEntity), 'held extrapolation quaternion');
  return heldEntity;
}

function verifyKickoffEpochBoundary(
  generated: GeneratedTransportInterpolationCase,
): Readonly<Record<string, unknown>> {
  const scenario = generated.kickoffBoundary;
  const beforeEntity = makeEntity(
    scenario.beforePosition,
    [1, 2, 3],
    { x: 0, y: 0, z: 0, w: 1 },
  );
  const afterEntity = makeEntity(
    scenario.afterPosition,
    [-4, -5, -6],
    { x: 0, y: 0, z: 1, w: 0 },
  );
  const endpointTimeMs = scenario.simulationTimeMs + scenario.spanMs;
  const buffer = new SnapshotBuffer({ teleportThreshold: 1_000_000 });
  assert.equal(buffer.accept(makeSnapshot(
    1,
    scenario.simulationTimeMs,
    scenario.kickoffEpoch,
    { car: beforeEntity },
  ), scenario.simulationTimeMs), true);
  assert.equal(buffer.accept(makeSnapshot(
    2,
    endpointTimeMs,
    scenario.kickoffEpoch + 1,
    { car: afterEntity },
  ), endpointTimeMs), true);

  const interiorTimes = new Set([
    scenario.simulationTimeMs + 1,
    scenario.simulationTimeMs + scenario.interiorOffsetMs,
    endpointTimeMs - 1,
  ]);
  for (const interiorTimeMs of interiorTimes) {
    const frame = buffer.sampleAt(interiorTimeMs);
    assert.ok(frame);
    assert.equal(frame.mode, 'teleport');
    assert.equal(frame.kickoffEpoch, scenario.kickoffEpoch);
    assert.deepEqual(frame.entities.car, beforeEntity);
  }

  const endpointFrame = buffer.sampleAt(endpointTimeMs);
  assert.ok(endpointFrame);
  assert.equal(endpointFrame.mode, 'teleport');
  assert.equal(endpointFrame.kickoffEpoch, scenario.kickoffEpoch + 1);
  assert.deepEqual(endpointFrame.entities.car, afterEntity);

  return {
    interiorTimes: [...interiorTimes],
    beforeEntity,
    endpointEntity: endpointFrame.entities.car,
  };
}

function verifyGeneratedCase(
  generated: GeneratedTransportInterpolationCase,
): Readonly<Record<string, unknown>> {
  return {
    cadence: verifyCadence(generated),
    retainedSequences: verifyGreatestSequenceRetention(generated),
    interpolation: verifyDelayedShortestPathInterpolation(generated),
    extrapolation: verifyBoundedExtrapolation(generated),
    kickoffBoundary: verifyKickoffEpochBoundary(generated),
  };
}

/**
 * Feature: rocket-arena, Property 25: Bounded transport and interpolation baseline
 * **Validates: Requirements 1.8-1.12, 6.8**
 */
test(
  `Property 25: bounded transport and interpolation baseline (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  () => {
    const generatedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateTransportInterpolationCase,
    });

    assert.ok(GENERATED_CASE_COUNT >= 100);
    assert.equal(generatedCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(generatedCases, generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateTransportInterpolationCase,
    }));
    for (const replayIndex of REPLAY_CASE_INDICES) {
      assert.deepEqual(
        replayCase(RECORDED_SEED, replayIndex, generateTransportInterpolationCase),
        generatedCases[replayIndex],
      );
    }

    assert.deepEqual(
      [...new Set(generatedCases.map(({ value }) => value.roomSize))]
        .sort((left, right) => left - right),
      Array.from({ length: 9 }, (_, index) => index),
    );
    assert.ok(generatedCases.some(({ value }) => (
      value.snapshotTargetMs === 33 && value.snapshotToleranceMs === 1
    )));

    assertGeneratedCases(generatedCases, (generated, generatedCase) => {
      assert.equal(generatedCase.seed, RECORDED_SEED);
      assert.equal(generatedCase.index, generated.caseIndex);
      assert.ok(generated.snapshotStream.length > 24);
      assert.ok(generated.callbackPartitions.length > 0);
      assert.ok(generated.callbackPartitions.every((partition) => partition.length >= 2));

      const firstResult = verifyGeneratedCase(generated);
      const repeatedResult = verifyGeneratedCase(generated);
      assert.deepEqual(repeatedResult, firstResult);
    });
  },
);

test('Property 25 generated failures report their recorded seed and case index', () => {
  const generatedCase = replayCase(
    RECORDED_SEED,
    DIAGNOSTIC_CASE_INDEX,
    generateTransportInterpolationCase,
  );
  const sentinel = new Error('property-25 diagnostic sentinel');
  let caught: unknown;

  try {
    assertGeneratedCases([generatedCase], () => {
      throw sentinel;
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof Error);
  assert.ok(caught.message.includes(`seed=${JSON.stringify(RECORDED_SEED)}`));
  assert.ok(caught.message.includes(`index=${DIAGNOSTIC_CASE_INDEX}`));
  assert.equal(caught.cause, sentinel);
});
