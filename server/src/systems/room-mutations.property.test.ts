import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROOM_POLICIES,
  ROOM_REJECTION_CODES,
  type MatchPhase,
  type RoomMode,
  type RoomMutationErrorCode,
  type RoomPolicy,
  type RosterEntry,
  type Team,
} from '@rocket-arena/shared';
import {
  createRoomMutationState,
  planRoomMutation,
  prepareRoomMutation,
  type RoomMutationRequest,
  type RoomMutationResourcePreparer,
  type RoomMutationState,
} from './room-mutations.js';

interface SeededRandom {
  integer(minInclusive: number, maxInclusive: number): number;
}

interface GeneratedCase<T> {
  readonly seed: string;
  readonly index: number;
  readonly value: T;
}

type CaseGenerator<T> = (random: SeededRandom, index: number) => T;

interface GeneratedCasesModule {
  generateCases<T>(options: {
    readonly seed: string | number;
    readonly count: number;
    readonly generate: CaseGenerator<T>;
  }): readonly GeneratedCase<T>[];
  replayCase<T>(
    seed: string | number,
    index: number,
    generate: CaseGenerator<T>,
  ): GeneratedCase<T>;
  assertGeneratedCases<T>(
    cases: readonly GeneratedCase<T>[],
    assertion: (value: T, generatedCase: GeneratedCase<T>) => void,
  ): void;
}

// Shared generated-case support lives outside server/src. Runtime loading reuses
// that implementation without expanding the production server emit root.
const generatedCasesModuleUrl = new URL(
  '../../../shared/tests/support/generated-cases.ts',
  import.meta.url,
).href;
const {
  assertGeneratedCases,
  generateCases,
  replayCase,
} = await import(generatedCasesModuleUrl) as unknown as GeneratedCasesModule;

const RECORDED_SEED = 'rocket-arena-property-3-atomic-roster-v1';
const GENERATED_CASE_COUNT = 400;
const CASES_PER_OPERATION = 100;
const CASES_PER_OPERATION_AND_MODE = 50;
const REPLAY_CASE_INDEX = 317;

const OPERATIONS = Object.freeze([
  'join',
  'leave',
  'switch-team',
  'start',
] as const satisfies readonly RoomMutationRequest['kind'][]);

type MutationOperation = (typeof OPERATIONS)[number];
type PreparationMode = 'normal' | 'failure' | 'missing';

interface GeneratedMutationCase {
  readonly caseIndex: number;
  readonly mode: RoomMode;
  readonly operation: MutationOperation;
  readonly scenario: string;
  readonly nonce: number;
}

interface TestBodyState {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly linearVelocity: readonly [number, number, number];
  readonly angularVelocity: readonly [number, number, number];
  readonly sleeping: boolean;
  readonly enabled: boolean;
  readonly contactEpoch: number;
}

interface TestCar {
  readonly id: string;
  readonly body: TestBodyState;
  readonly boost: number;
  removed: boolean;
}

interface TestInput {
  readonly protocolVersion: 2;
  readonly throttle: number;
  readonly steer: number;
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
  readonly jumpHeld: boolean;
  readonly jumpSequence: number;
  readonly boostHeld: boolean;
  readonly powerslideHeld: boolean;
  readonly cameraToggleSequence: number;
}

interface TestBall {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly linearVelocity: readonly [number, number, number];
  readonly angularVelocity: readonly [number, number, number];
  readonly lastTouchedBy: string | null;
  readonly kickoffEpoch: number;
}

interface TestKickoffAssignment {
  readonly slotId: string;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly epoch: number;
}

type TestState = Readonly<RoomMutationState<
  TestCar,
  TestInput,
  TestBall,
  TestKickoffAssignment
>>;

type ExpectedOutcome =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly code: RoomMutationErrorCode };

interface ExecutableScenario {
  readonly state: TestState;
  readonly request: RoomMutationRequest;
  readonly physicsReady: boolean;
  readonly preparationMode: PreparationMode;
  readonly expected: ExpectedOutcome;
}

interface CaseCoverage {
  readonly operation: MutationOperation;
  readonly mode: RoomMode;
  readonly scenario: string;
  readonly accepted: boolean;
  readonly rejectionCode: RoomMutationErrorCode | null;
}

interface MakeStateOptions {
  readonly phase?: MatchPhase;
  readonly tombstones?: readonly string[];
}

const JOIN_SCENARIOS = Object.freeze([
  'accepted-empty',
  'accepted-prefix',
  'duplicate',
  'total-capacity',
  'wrong-phase-countdown',
  'wrong-phase-playing',
  'physics-not-ready',
  'preparation-failure',
  'empty-identity',
  'policy-mismatch',
]);

const QUICK_LEAVE_SCENARIOS = Object.freeze([
  'accepted-waiting',
  'accepted-countdown',
  'accepted-playing',
  'not-represented',
  'missing-preparer',
  'preparation-failure',
  'policy-mismatch',
]);

const CUSTOM_LEAVE_SCENARIOS = Object.freeze([
  'accepted-guest-waiting',
  'accepted-host-waiting',
  'accepted-host-countdown',
  'accepted-guest-playing',
  'accepted-final',
  'not-represented',
  'missing-preparer',
  'preparation-failure',
  'policy-mismatch',
]);

const QUICK_SWITCH_SCENARIOS = Object.freeze([
  'disabled-opposite',
  'same-team',
  'wrong-phase-countdown',
  'wrong-phase-playing',
  'not-represented',
  'policy-mismatch',
]);

const CUSTOM_SWITCH_SCENARIOS = Object.freeze([
  'accepted-host',
  'accepted-guest',
  'team-capacity',
  'same-team',
  'wrong-phase-countdown',
  'wrong-phase-playing',
  'not-represented',
  'policy-mismatch',
]);

const QUICK_START_SCENARIOS = Object.freeze([
  'not-host-waiting',
  'wrong-phase-countdown',
  'wrong-phase-playing',
  'not-represented',
  'policy-mismatch',
  'invalid-roster',
]);

const CUSTOM_START_SCENARIOS = Object.freeze([
  'accepted-host',
  'non-host',
  'wrong-phase-countdown',
  'wrong-phase-playing',
  'not-represented',
  'physics-not-ready',
  'policy-mismatch',
  'invalid-roster',
]);

function scenariosFor(
  operation: MutationOperation,
  mode: RoomMode,
): readonly string[] {
  if (operation === 'join') return JOIN_SCENARIOS;
  if (operation === 'leave') {
    return mode === 'quick' ? QUICK_LEAVE_SCENARIOS : CUSTOM_LEAVE_SCENARIOS;
  }
  if (operation === 'switch-team') {
    return mode === 'quick' ? QUICK_SWITCH_SCENARIOS : CUSTOM_SWITCH_SCENARIOS;
  }
  return mode === 'quick' ? QUICK_START_SCENARIOS : CUSTOM_START_SCENARIOS;
}

function generateMutationCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedMutationCase {
  const operation = OPERATIONS[caseIndex % OPERATIONS.length]!;
  const operationIndex = Math.floor(caseIndex / OPERATIONS.length);
  const mode: RoomMode = operationIndex % 2 === 0 ? 'quick' : 'custom';
  const modeOperationIndex = Math.floor(operationIndex / 2);
  const scenarios = scenariosFor(operation, mode);

  return Object.freeze({
    caseIndex,
    mode,
    operation,
    scenario: scenarios[modeOperationIndex % scenarios.length]!,
    nonce: random.integer(1, 1_000_000),
  });
}

function identity(generated: GeneratedMutationCase, label: string): string {
  return `property-3-${generated.mode}-${generated.caseIndex
    .toString()
    .padStart(3, '0')}-${label}`;
}

function makeEntries(
  generated: GeneratedMutationCase,
  teams: readonly Team[],
): readonly RosterEntry[] {
  return Object.freeze(teams.map((team, index) => Object.freeze({
    sessionId: identity(generated, `player-${index}`),
    acceptedJoinOrdinal: index,
    team,
    name: `Generated ${generated.nonce} player ${index}`,
    isHost: generated.mode === 'custom' && index === 0,
  })));
}

function makeCar(
  generated: GeneratedMutationCase,
  entry: Pick<RosterEntry, 'sessionId' | 'acceptedJoinOrdinal' | 'team'>,
): TestCar {
  const ordinal = entry.acceptedJoinOrdinal;
  const direction = entry.team === 'blue' ? -1 : 1;
  return {
    id: `car:${entry.sessionId}`,
    body: {
      position: [ordinal + generated.nonce / 1_000_000, 0.5 + ordinal / 10, direction * (10 + ordinal)],
      rotation: entry.team === 'blue' ? [0, 0, 0, 1] : [0, 1, 0, 0],
      linearVelocity: [ordinal / 3, direction * ordinal / 5, generated.caseIndex / 100],
      angularVelocity: [direction * ordinal / 7, ordinal / 11, -ordinal / 13],
      sleeping: ordinal % 2 === 0,
      enabled: true,
      contactEpoch: generated.caseIndex + ordinal,
    },
    boost: (generated.nonce + ordinal * 17) % 101,
    removed: false,
  };
}

function makeInput(
  generated: GeneratedMutationCase,
  ordinal: number,
): TestInput {
  const signed = ordinal % 2 === 0 ? 1 : -1;
  return {
    protocolVersion: 2,
    throttle: signed * ((generated.nonce + ordinal) % 101) / 100,
    steer: -signed * ((generated.nonce + ordinal * 3) % 101) / 100,
    pitch: ((ordinal % 5) - 2) / 2,
    yaw: ((ordinal % 3) - 1),
    roll: signed * 0.5,
    jumpHeld: ordinal % 2 === 0,
    jumpSequence: generated.caseIndex * 10 + ordinal,
    boostHeld: ordinal % 3 === 0,
    powerslideHeld: ordinal % 4 === 0,
    cameraToggleSequence: generated.caseIndex * 20 + ordinal,
  };
}

function makeKickoffAssignment(
  generated: GeneratedMutationCase,
  entry: RosterEntry,
): TestKickoffAssignment {
  const direction = entry.team === 'blue' ? -1 : 1;
  return {
    slotId: `${entry.team}-${entry.acceptedJoinOrdinal}`,
    position: [entry.acceptedJoinOrdinal * direction, 0.25, direction * 20],
    rotation: entry.team === 'blue' ? [0, 0, 0, 1] : [0, 1, 0, 0],
    epoch: generated.caseIndex % 9,
  };
}

function makeState(
  generated: GeneratedMutationCase,
  entries: readonly RosterEntry[],
  options: MakeStateOptions = {},
): TestState {
  const roster = new Map(entries.map((entry) => [entry.sessionId, entry]));
  const phase = options.phase ?? 'waiting';
  const nextJoinOrdinal = entries.reduce(
    (maximum, entry) => Math.max(maximum, entry.acceptedJoinOrdinal),
    -1,
  ) + 1;

  return createRoomMutationState<TestCar, TestInput, TestBall, TestKickoffAssignment>({
    revision: generated.nonce % 97,
    policy: ROOM_POLICIES[generated.mode],
    roster,
    nextJoinOrdinal,
    hostSessionId: entries.find(({ isHost }) => isHost)?.sessionId ?? null,
    phase,
    countdownKind: phase === 'countdown' ? 'initial' : null,
    countdownStepsRemaining: phase === 'countdown'
      ? 1 + (generated.nonce % 180)
      : 0,
    blueScore: generated.nonce % 12,
    orangeScore: (generated.nonce * 7) % 12,
    regulationStepsRemaining: 1 + (generated.nonce % 18_000),
    ball: {
      position: [
        generated.nonce / 10_000,
        1 + (generated.caseIndex % 7) / 10,
        -generated.caseIndex / 9,
      ],
      rotation: [0, 0, 0, 1],
      linearVelocity: [
        generated.caseIndex / 17,
        -generated.nonce / 100_000,
        generated.caseIndex / 19,
      ],
      angularVelocity: [
        generated.caseIndex / 23,
        generated.caseIndex / 29,
        -generated.caseIndex / 31,
      ],
      lastTouchedBy: entries.at(-1)?.sessionId ?? null,
      kickoffEpoch: generated.caseIndex % 9,
    },
    cars: new Map(entries.map((entry) => [entry.sessionId, makeCar(generated, entry)])),
    inputs: new Map(entries.map((entry) => [
      entry.sessionId,
      makeInput(generated, entry.acceptedJoinOrdinal),
    ])),
    kickoffAssignments: new Map(entries.map((entry) => [
      entry.sessionId,
      makeKickoffAssignment(generated, entry),
    ])),
    tombstones: new Set(options.tombstones ?? []),
  });
}

function withPolicyMismatch(state: TestState): TestState {
  const mismatchedPolicy = Object.freeze({
    ...state.policy,
    totalCapacity: state.policy.totalCapacity + 1,
  }) as RoomPolicy;
  return Object.freeze({ ...state, policy: mismatchedPolicy }) as TestState;
}

function withInvalidRoster(state: TestState): TestState {
  return Object.freeze({
    ...state,
    cars: Object.freeze(new Map<string, TestCar>()),
  }) as TestState;
}

function accepted(): ExpectedOutcome {
  return Object.freeze({ accepted: true });
}

function rejected(code: RoomMutationErrorCode): ExpectedOutcome {
  return Object.freeze({ accepted: false, code });
}

function scenarioResult(
  state: TestState,
  request: RoomMutationRequest,
  expected: ExpectedOutcome,
  physicsReady = true,
  preparationMode: PreparationMode = 'normal',
): ExecutableScenario {
  return Object.freeze({ state, request, expected, physicsReady, preparationMode });
}

function buildJoinScenario(generated: GeneratedMutationCase): ExecutableScenario {
  const candidate = identity(generated, 'join-candidate');
  const prefix = makeEntries(generated, ['blue', 'orange']);

  if (generated.scenario === 'accepted-empty') {
    return scenarioResult(
      makeState(generated, [], { tombstones: [candidate] }),
      { kind: 'join', sessionId: candidate, name: `Candidate ${generated.nonce}` },
      accepted(),
    );
  }
  if (generated.scenario === 'accepted-prefix') {
    return scenarioResult(
      makeState(generated, prefix, { tombstones: [candidate] }),
      { kind: 'join', sessionId: candidate, name: `Candidate ${generated.nonce}` },
      accepted(),
    );
  }
  if (generated.scenario === 'duplicate') {
    return scenarioResult(
      makeState(generated, prefix),
      { kind: 'join', sessionId: prefix[0]!.sessionId, name: 'Duplicate' },
      rejected('duplicate-identity'),
    );
  }
  if (generated.scenario === 'total-capacity') {
    const fullTeams: readonly Team[] = generated.mode === 'quick'
      ? ['blue', 'orange', 'blue', 'orange', 'blue', 'orange']
      : ['blue', 'orange', 'blue', 'orange', 'blue', 'orange', 'blue', 'orange'];
    return scenarioResult(
      makeState(generated, makeEntries(generated, fullTeams)),
      { kind: 'join', sessionId: candidate, name: 'Overflow' },
      rejected('total-capacity'),
    );
  }
  if (generated.scenario === 'wrong-phase-countdown') {
    return scenarioResult(
      makeState(generated, prefix, { phase: 'countdown' }),
      { kind: 'join', sessionId: candidate, name: 'Countdown join' },
      rejected('wrong-phase'),
    );
  }
  if (generated.scenario === 'wrong-phase-playing') {
    return scenarioResult(
      makeState(generated, prefix, { phase: 'playing' }),
      { kind: 'join', sessionId: candidate, name: 'Playing join' },
      rejected('wrong-phase'),
    );
  }
  if (generated.scenario === 'physics-not-ready') {
    return scenarioResult(
      makeState(generated, prefix),
      { kind: 'join', sessionId: candidate, name: 'Early join' },
      rejected('physics-not-ready'),
      false,
    );
  }
  if (generated.scenario === 'preparation-failure') {
    return scenarioResult(
      makeState(generated, prefix),
      { kind: 'join', sessionId: candidate, name: 'Failed body' },
      rejected('physics-not-ready'),
      true,
      'failure',
    );
  }
  if (generated.scenario === 'empty-identity') {
    return scenarioResult(
      makeState(generated, prefix),
      { kind: 'join', sessionId: '', name: 'Empty identity' },
      rejected('not-represented'),
    );
  }

  return scenarioResult(
    withPolicyMismatch(makeState(generated, prefix)),
    { kind: 'join', sessionId: candidate, name: 'Policy mismatch' },
    rejected('policy-mismatch'),
  );
}

function buildLeaveScenario(generated: GeneratedMutationCase): ExecutableScenario {
  const three = makeEntries(generated, ['blue', 'orange', 'blue']);
  let entries = three;
  let phase: MatchPhase = 'waiting';
  let target = three[1]!.sessionId;
  let expected = accepted();
  let preparationMode: PreparationMode = 'normal';

  if (generated.mode === 'quick') {
    if (generated.scenario === 'accepted-countdown') {
      entries = makeEntries(generated, ['blue', 'orange', 'blue', 'orange', 'blue', 'orange']);
      phase = 'countdown';
      target = entries[5]!.sessionId;
    } else if (generated.scenario === 'accepted-playing') {
      entries = makeEntries(generated, ['blue', 'orange', 'blue', 'orange']);
      phase = 'playing';
      target = entries[2]!.sessionId;
    } else if (generated.scenario === 'not-represented') {
      target = identity(generated, 'missing-leave');
      expected = rejected('not-represented');
    } else if (generated.scenario === 'missing-preparer') {
      preparationMode = 'missing';
      expected = rejected('physics-not-ready');
    } else if (generated.scenario === 'preparation-failure') {
      preparationMode = 'failure';
      expected = rejected('physics-not-ready');
    } else if (generated.scenario === 'policy-mismatch') {
      return scenarioResult(
        withPolicyMismatch(makeState(generated, entries)),
        { kind: 'leave', sessionId: target },
        rejected('policy-mismatch'),
      );
    }
  } else if (generated.scenario === 'accepted-host-waiting') {
    target = entries[0]!.sessionId;
  } else if (generated.scenario === 'accepted-host-countdown') {
    phase = 'countdown';
    target = entries[0]!.sessionId;
  } else if (generated.scenario === 'accepted-guest-playing') {
    phase = 'playing';
    target = entries[1]!.sessionId;
  } else if (generated.scenario === 'accepted-final') {
    entries = makeEntries(generated, ['blue']);
    target = entries[0]!.sessionId;
  } else if (generated.scenario === 'not-represented') {
    target = identity(generated, 'missing-leave');
    expected = rejected('not-represented');
  } else if (generated.scenario === 'missing-preparer') {
    preparationMode = 'missing';
    expected = rejected('physics-not-ready');
  } else if (generated.scenario === 'preparation-failure') {
    preparationMode = 'failure';
    expected = rejected('physics-not-ready');
  } else if (generated.scenario === 'policy-mismatch') {
    return scenarioResult(
      withPolicyMismatch(makeState(generated, entries)),
      { kind: 'leave', sessionId: target },
      rejected('policy-mismatch'),
    );
  }

  return scenarioResult(
    makeState(generated, entries, { phase }),
    { kind: 'leave', sessionId: target },
    expected,
    true,
    preparationMode,
  );
}

function buildSwitchScenario(generated: GeneratedMutationCase): ExecutableScenario {
  if (generated.mode === 'quick') {
    const entries = makeEntries(generated, ['blue', 'orange']);
    const represented = entries[0]!;
    if (generated.scenario === 'disabled-opposite') {
      return scenarioResult(
        makeState(generated, entries),
        { kind: 'switch-team', sessionId: represented.sessionId, team: 'orange' },
        rejected('not-opposite-team'),
      );
    }
    if (generated.scenario === 'same-team') {
      return scenarioResult(
        makeState(generated, entries),
        { kind: 'switch-team', sessionId: represented.sessionId, team: 'blue' },
        rejected('not-opposite-team'),
      );
    }
    if (generated.scenario === 'wrong-phase-countdown') {
      return scenarioResult(
        makeState(generated, entries, { phase: 'countdown' }),
        { kind: 'switch-team', sessionId: represented.sessionId, team: 'orange' },
        rejected('wrong-phase'),
      );
    }
    if (generated.scenario === 'wrong-phase-playing') {
      return scenarioResult(
        makeState(generated, entries, { phase: 'playing' }),
        { kind: 'switch-team', sessionId: represented.sessionId, team: 'orange' },
        rejected('wrong-phase'),
      );
    }
    if (generated.scenario === 'not-represented') {
      return scenarioResult(
        makeState(generated, entries),
        { kind: 'switch-team', sessionId: identity(generated, 'missing-switch'), team: 'orange' },
        rejected('not-represented'),
      );
    }
    return scenarioResult(
      withPolicyMismatch(makeState(generated, entries)),
      { kind: 'switch-team', sessionId: represented.sessionId, team: 'orange' },
      rejected('policy-mismatch'),
    );
  }

  if (generated.scenario === 'accepted-host') {
    const entries = makeEntries(generated, ['blue', 'blue', 'orange']);
    return scenarioResult(
      makeState(generated, entries),
      { kind: 'switch-team', sessionId: entries[0]!.sessionId, team: 'orange' },
      accepted(),
    );
  }
  if (generated.scenario === 'accepted-guest') {
    const entries = makeEntries(generated, ['blue', 'orange', 'orange']);
    return scenarioResult(
      makeState(generated, entries),
      { kind: 'switch-team', sessionId: entries[1]!.sessionId, team: 'blue' },
      accepted(),
    );
  }
  if (generated.scenario === 'team-capacity') {
    const entries = makeEntries(generated, ['blue', 'orange', 'orange', 'orange', 'orange']);
    return scenarioResult(
      makeState(generated, entries),
      { kind: 'switch-team', sessionId: entries[0]!.sessionId, team: 'orange' },
      rejected('team-capacity'),
    );
  }

  const entries = makeEntries(generated, ['blue', 'orange']);
  const host = entries[0]!;
  if (generated.scenario === 'same-team') {
    return scenarioResult(
      makeState(generated, entries),
      { kind: 'switch-team', sessionId: host.sessionId, team: 'blue' },
      rejected('not-opposite-team'),
    );
  }
  if (generated.scenario === 'wrong-phase-countdown') {
    return scenarioResult(
      makeState(generated, entries, { phase: 'countdown' }),
      { kind: 'switch-team', sessionId: host.sessionId, team: 'orange' },
      rejected('wrong-phase'),
    );
  }
  if (generated.scenario === 'wrong-phase-playing') {
    return scenarioResult(
      makeState(generated, entries, { phase: 'playing' }),
      { kind: 'switch-team', sessionId: host.sessionId, team: 'orange' },
      rejected('wrong-phase'),
    );
  }
  if (generated.scenario === 'not-represented') {
    return scenarioResult(
      makeState(generated, entries),
      { kind: 'switch-team', sessionId: identity(generated, 'missing-switch'), team: 'orange' },
      rejected('not-represented'),
    );
  }
  return scenarioResult(
    withPolicyMismatch(makeState(generated, entries)),
    { kind: 'switch-team', sessionId: host.sessionId, team: 'orange' },
    rejected('policy-mismatch'),
  );
}

function buildStartScenario(generated: GeneratedMutationCase): ExecutableScenario {
  if (generated.mode === 'quick') {
    const entries = makeEntries(generated, ['blue', 'orange', 'blue', 'orange', 'blue', 'orange']);
    const represented = entries[0]!;
    if (generated.scenario === 'not-host-waiting') {
      return scenarioResult(
        makeState(generated, entries),
        { kind: 'start', sessionId: represented.sessionId },
        rejected('not-host'),
      );
    }
    if (generated.scenario === 'wrong-phase-countdown') {
      return scenarioResult(
        makeState(generated, entries, { phase: 'countdown' }),
        { kind: 'start', sessionId: represented.sessionId },
        rejected('wrong-phase'),
      );
    }
    if (generated.scenario === 'wrong-phase-playing') {
      return scenarioResult(
        makeState(generated, entries, { phase: 'playing' }),
        { kind: 'start', sessionId: represented.sessionId },
        rejected('wrong-phase'),
      );
    }
    if (generated.scenario === 'not-represented') {
      return scenarioResult(
        makeState(generated, entries),
        { kind: 'start', sessionId: identity(generated, 'missing-start') },
        rejected('not-represented'),
      );
    }
    if (generated.scenario === 'invalid-roster') {
      return scenarioResult(
        withInvalidRoster(makeState(generated, entries)),
        { kind: 'start', sessionId: represented.sessionId },
        rejected('invalid-roster'),
      );
    }
    return scenarioResult(
      withPolicyMismatch(makeState(generated, entries)),
      { kind: 'start', sessionId: represented.sessionId },
      rejected('policy-mismatch'),
    );
  }

  const entries = makeEntries(generated, ['blue', 'orange']);
  const host = entries[0]!;
  const guest = entries[1]!;
  if (generated.scenario === 'accepted-host') {
    return scenarioResult(
      makeState(generated, entries),
      { kind: 'start', sessionId: host.sessionId },
      accepted(),
    );
  }
  if (generated.scenario === 'non-host') {
    return scenarioResult(
      makeState(generated, entries),
      { kind: 'start', sessionId: guest.sessionId },
      rejected('not-host'),
    );
  }
  if (generated.scenario === 'wrong-phase-countdown') {
    return scenarioResult(
      makeState(generated, entries, { phase: 'countdown' }),
      { kind: 'start', sessionId: host.sessionId },
      rejected('wrong-phase'),
    );
  }
  if (generated.scenario === 'wrong-phase-playing') {
    return scenarioResult(
      makeState(generated, entries, { phase: 'playing' }),
      { kind: 'start', sessionId: host.sessionId },
      rejected('wrong-phase'),
    );
  }
  if (generated.scenario === 'not-represented') {
    return scenarioResult(
      makeState(generated, entries),
      { kind: 'start', sessionId: identity(generated, 'missing-start') },
      rejected('not-represented'),
    );
  }
  if (generated.scenario === 'physics-not-ready') {
    return scenarioResult(
      makeState(generated, entries),
      { kind: 'start', sessionId: host.sessionId },
      rejected('physics-not-ready'),
      false,
    );
  }
  if (generated.scenario === 'invalid-roster') {
    return scenarioResult(
      withInvalidRoster(makeState(generated, entries)),
      { kind: 'start', sessionId: host.sessionId },
      rejected('invalid-roster'),
    );
  }
  return scenarioResult(
    withPolicyMismatch(makeState(generated, entries)),
    { kind: 'start', sessionId: host.sessionId },
    rejected('policy-mismatch'),
  );
}

function buildScenario(generated: GeneratedMutationCase): ExecutableScenario {
  if (generated.operation === 'join') return buildJoinScenario(generated);
  if (generated.operation === 'leave') return buildLeaveScenario(generated);
  if (generated.operation === 'switch-team') return buildSwitchScenario(generated);
  return buildStartScenario(generated);
}

function orderedMap<T>(values: ReadonlyMap<string, T>): readonly (readonly [string, T])[] {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, structuredClone(value)] as const);
}

function authoritativeSnapshot(state: TestState): unknown {
  return structuredClone({
    revision: state.revision,
    policy: state.policy,
    roster: orderedMap(state.roster),
    nextJoinOrdinal: state.nextJoinOrdinal,
    hostSessionId: state.hostSessionId,
    occupancy: state.occupancy,
    phase: state.phase,
    countdownKind: state.countdownKind,
    countdownStepsRemaining: state.countdownStepsRemaining,
    blueScore: state.blueScore,
    orangeScore: state.orangeScore,
    regulationStepsRemaining: state.regulationStepsRemaining,
    ball: state.ball,
    cars: orderedMap(state.cars),
    inputs: orderedMap(state.inputs),
    kickoffAssignments: orderedMap(state.kickoffAssignments),
    tombstones: [...state.tombstones].sort(),
  });
}

/** Canonical serialized bytes for the complete logical authoritative boundary. */
function authoritativeSnapshotBytes(state: TestState): string {
  return JSON.stringify(authoritativeSnapshot(state));
}

function mapBytes<T>(values: ReadonlyMap<string, T>): string {
  return JSON.stringify(orderedMap(values));
}

function setBytes(values: ReadonlySet<string>): string {
  return JSON.stringify([...values].sort());
}

function calculateOccupancy(roster: ReadonlyMap<string, Readonly<RosterEntry>>) {
  let blue = 0;
  let orange = 0;
  for (const entry of roster.values()) {
    if (entry.team === 'blue') blue += 1;
    else orange += 1;
  }
  return { total: blue + orange, blue, orange };
}

function compareStableRosterOrder(left: RosterEntry, right: RosterEntry): number {
  return left.acceptedJoinOrdinal - right.acceptedJoinOrdinal
    || left.sessionId.localeCompare(right.sessionId);
}

function expectedJoinTeam(state: TestState): Team {
  const { blue, orange } = state.occupancy;
  const blueAvailable = blue < state.policy.teamCapacity;
  const orangeAvailable = orange < state.policy.teamCapacity;
  assert.ok(blueAvailable || orangeAvailable);
  if (blueAvailable && !orangeAvailable) return 'blue';
  if (!blueAvailable && orangeAvailable) return 'orange';
  if (blue === orange) return 'blue';
  return blue < orange ? 'blue' : 'orange';
}

function assertGameplayFieldsPreserved(before: TestState, after: TestState): void {
  assert.equal(after.policy, before.policy);
  assert.equal(after.phase, before.phase);
  assert.equal(after.countdownKind, before.countdownKind);
  assert.equal(after.countdownStepsRemaining, before.countdownStepsRemaining);
  assert.equal(after.blueScore, before.blueScore);
  assert.equal(after.orangeScore, before.orangeScore);
  assert.equal(after.regulationStepsRemaining, before.regulationStepsRemaining);
  assert.deepEqual(after.ball, before.ball);
}

function assertAcceptedJoin(
  generated: GeneratedMutationCase,
  scenario: ExecutableScenario,
  next: TestState,
  preparedCar: TestCar | null,
  preparedInput: TestInput | null,
): void {
  assert.equal(scenario.request.kind, 'join');
  if (scenario.request.kind !== 'join') return;
  const before = scenario.state;
  const expectedTeam = expectedJoinTeam(before);
  const expectedHost = before.policy.mode === 'custom' && before.roster.size === 0
    ? scenario.request.sessionId
    : before.hostSessionId;

  assert.equal(next.revision, before.revision + 1);
  assertGameplayFieldsPreserved(before, next);
  assert.equal(next.roster.size, before.roster.size + 1);
  assert.equal(next.nextJoinOrdinal, before.nextJoinOrdinal + 1);
  assert.equal(next.hostSessionId, expectedHost);

  for (const [sessionId, entry] of before.roster) {
    assert.deepEqual(next.roster.get(sessionId), entry);
    assert.deepEqual(next.cars.get(sessionId), before.cars.get(sessionId));
    assert.deepEqual(next.inputs.get(sessionId), before.inputs.get(sessionId));
  }

  assert.deepEqual(next.roster.get(scenario.request.sessionId), {
    sessionId: scenario.request.sessionId,
    acceptedJoinOrdinal: before.nextJoinOrdinal,
    team: expectedTeam,
    name: scenario.request.name,
    isHost: before.policy.mode === 'custom' && before.roster.size === 0,
  });
  assert.ok(preparedCar, 'accepted join must publish its prepared authoritative car');
  assert.ok(preparedInput, 'accepted join must publish its prepared input slot');
  assert.deepEqual(next.cars.get(scenario.request.sessionId), preparedCar);
  assert.deepEqual(next.inputs.get(scenario.request.sessionId), preparedInput);
  assert.deepEqual(next.occupancy, calculateOccupancy(next.roster));
  assert.equal(mapBytes(next.kickoffAssignments), mapBytes(before.kickoffAssignments));

  const expectedTombstones = new Set(before.tombstones);
  expectedTombstones.delete(scenario.request.sessionId);
  assert.equal(setBytes(next.tombstones), setBytes(expectedTombstones));
  assert.equal(next.cars.size, next.roster.size);
  assert.equal(next.inputs.size, next.roster.size);
  assert.equal(preparedCar?.removed, false);
  assert.match(preparedCar?.id ?? '', new RegExp(generated.caseIndex.toString()));
}

function assertAcceptedLeave(
  scenario: ExecutableScenario,
  next: TestState,
): void {
  assert.equal(scenario.request.kind, 'leave');
  if (scenario.request.kind !== 'leave') return;
  const before = scenario.state;
  const leaving = before.roster.get(scenario.request.sessionId);
  assert.ok(leaving);
  const remainingBefore = [...before.roster.values()]
    .filter(({ sessionId }) => sessionId !== scenario.request.sessionId);
  const expectedHost = before.policy.mode === 'custom' && leaving.isHost
    ? ([...remainingBefore].sort(compareStableRosterOrder)[0]?.sessionId ?? null)
    : before.hostSessionId;

  assert.equal(next.revision, before.revision + 1);
  assertGameplayFieldsPreserved(before, next);
  assert.equal(next.roster.size, before.roster.size - 1);
  assert.equal(next.roster.has(scenario.request.sessionId), false);
  assert.equal(next.cars.has(scenario.request.sessionId), false);
  assert.equal(next.inputs.has(scenario.request.sessionId), false);
  assert.equal(next.nextJoinOrdinal, before.nextJoinOrdinal);
  assert.equal(next.hostSessionId, expectedHost);
  assert.deepEqual(next.occupancy, calculateOccupancy(next.roster));

  for (const entry of remainingBefore) {
    const expectedEntry: RosterEntry = before.policy.mode === 'custom' && leaving.isHost
      ? { ...entry, isHost: entry.sessionId === expectedHost }
      : entry;
    assert.deepEqual(next.roster.get(entry.sessionId), expectedEntry);
    assert.deepEqual(next.cars.get(entry.sessionId), before.cars.get(entry.sessionId));
    assert.deepEqual(next.inputs.get(entry.sessionId), before.inputs.get(entry.sessionId));
  }

  const expectedTombstones = new Set(before.tombstones);
  expectedTombstones.add(scenario.request.sessionId);
  assert.equal(setBytes(next.tombstones), setBytes(expectedTombstones));
  if (next.roster.size === 0) {
    assert.equal(next.kickoffAssignments.size, 0);
  } else {
    assert.equal(mapBytes(next.kickoffAssignments), mapBytes(before.kickoffAssignments));
  }
  assert.equal(leaving.isHost && next.roster.size > 0
    ? [...next.roster.values()].filter(({ isHost }) => isHost).length
    : 0,
  leaving.isHost && next.roster.size > 0 ? 1 : 0);
  assert.equal(before.cars.get(scenario.request.sessionId)?.removed, true);
}

function assertAcceptedSwitch(
  scenario: ExecutableScenario,
  next: TestState,
): void {
  assert.equal(scenario.request.kind, 'switch-team');
  if (scenario.request.kind !== 'switch-team') return;
  const before = scenario.state;
  const switching = before.roster.get(scenario.request.sessionId);
  assert.ok(switching);

  assert.equal(next.revision, before.revision + 1);
  assertGameplayFieldsPreserved(before, next);
  assert.equal(next.roster.size, before.roster.size);
  assert.equal(next.nextJoinOrdinal, before.nextJoinOrdinal);
  assert.equal(next.hostSessionId, before.hostSessionId);
  assert.deepEqual(next.occupancy, calculateOccupancy(next.roster));

  for (const [sessionId, entry] of before.roster) {
    assert.deepEqual(
      next.roster.get(sessionId),
      sessionId === scenario.request.sessionId
        ? { ...entry, team: scenario.request.team }
        : entry,
    );
  }
  assert.equal(mapBytes(next.cars), mapBytes(before.cars));
  assert.equal(mapBytes(next.inputs), mapBytes(before.inputs));
  assert.equal(mapBytes(next.kickoffAssignments), mapBytes(before.kickoffAssignments));
  assert.equal(setBytes(next.tombstones), setBytes(before.tombstones));
}

function assertAcceptedStart(
  scenario: ExecutableScenario,
  next: TestState,
  beforeBytes: string,
): void {
  assert.equal(scenario.request.kind, 'start');
  if (scenario.request.kind !== 'start') return;

  // Stage 2 validates the Host request transactionally; MatchFlow owns the
  // later countdown phase transition. Therefore revision is the sole state
  // byte changed by this accepted service-level request.
  const expected = JSON.parse(beforeBytes) as { revision: number };
  expected.revision += 1;
  assert.equal(
    authoritativeSnapshotBytes(next),
    JSON.stringify(expected),
    'accepted start validation must preserve every authoritative byte except revision',
  );
}

function assertAcceptedMutation(
  generated: GeneratedMutationCase,
  scenario: ExecutableScenario,
  next: TestState,
  effectKind: string,
  beforeBytes: string,
  preparedCar: TestCar | null,
  preparedInput: TestInput | null,
): void {
  if (scenario.request.kind === 'join') {
    assert.equal(effectKind, 'joined');
    assertAcceptedJoin(generated, scenario, next, preparedCar, preparedInput);
  } else if (scenario.request.kind === 'leave') {
    assert.equal(effectKind, 'left');
    assertAcceptedLeave(scenario, next);
  } else if (scenario.request.kind === 'switch-team') {
    assert.equal(effectKind, 'team-switched');
    assertAcceptedSwitch(scenario, next);
  } else {
    assert.equal(effectKind, 'start-validated');
    assertAcceptedStart(scenario, next, beforeBytes);
  }
}

function assertRejectedUnchanged(
  scenario: ExecutableScenario,
  beforeBytes: string,
  code: RoomMutationErrorCode,
): CaseCoverage {
  assert.equal(scenario.expected.accepted, false);
  if (scenario.expected.accepted) {
    assert.fail(`expected ${scenario.request.kind} to be accepted, but it was rejected with ${code}`);
  }
  assert.equal(code, scenario.expected.code);

  const afterBytes = authoritativeSnapshotBytes(scenario.state);
  assert.equal(
    afterBytes,
    beforeBytes,
    'rejected request must preserve the complete serialized authoritative snapshot bit-for-bit',
  );
  assert.equal(
    Buffer.compare(Buffer.from(afterBytes), Buffer.from(beforeBytes)),
    0,
    'roster, Host, phase, countdown, score, timer, ball, car/body, input, and assignment bytes changed',
  );

  return {
    operation: scenario.request.kind,
    mode: scenario.state.policy.mode,
    scenario: '',
    accepted: false,
    rejectionCode: code,
  };
}

function exerciseMutationCase(generated: GeneratedMutationCase): CaseCoverage {
  const scenario = buildScenario(generated);
  const beforeBytes = authoritativeSnapshotBytes(scenario.state);
  const planning = planRoomMutation(
    scenario.state,
    scenario.request,
    { physicsReady: scenario.physicsReady },
  );

  if (!planning.ok) {
    return {
      ...assertRejectedUnchanged(scenario, beforeBytes, planning.code),
      scenario: generated.scenario,
    };
  }

  let preparedCar: TestCar | null = null;
  let preparedInput: TestInput | null = null;
  let rolledBackJoinCar: TestCar | null = null;
  const resources: RoomMutationResourcePreparer<TestCar, TestInput> =
    scenario.preparationMode === 'missing'
      ? {}
      : {
        prepareJoin: ({ entry }, scope) => {
          const car = scope.track(
            makeCar(generated, entry),
            (temporary) => { temporary.removed = true; },
          );
          rolledBackJoinCar = car;
          if (scenario.preparationMode === 'failure') {
            throw new Error('generated join body preparation failure');
          }
          preparedCar = car;
          preparedInput = makeInput(generated, entry.acceptedJoinOrdinal);
          return { car, input: preparedInput };
        },
        prepareLeave: ({ car }) => {
          if (scenario.preparationMode === 'failure') {
            throw new Error('generated leave body preparation failure');
          }
          return {
            commitRemoval: () => { car.removed = true; },
          };
        },
      };

  const preparation = prepareRoomMutation<TestCar, TestInput, TestBall, TestKickoffAssignment>(
    planning.plan,
    resources,
  );
  if (!preparation.ok) {
    if (scenario.request.kind === 'join' && scenario.preparationMode === 'failure') {
      assert.equal(
        (rolledBackJoinCar as TestCar | null)?.removed,
        true,
        'failed temporary join body must be disposed',
      );
    }
    return {
      ...assertRejectedUnchanged(scenario, beforeBytes, preparation.code),
      scenario: generated.scenario,
    };
  }

  if (!scenario.expected.accepted) {
    preparation.prepared.abort();
    assert.fail(
      `expected rejection ${scenario.expected.code}, but ${scenario.request.kind} prepared successfully`,
    );
  }

  const committed = preparation.prepared.commit(scenario.state);
  if (!committed.ok) {
    assert.fail(`accepted ${scenario.request.kind} unexpectedly rejected with ${committed.code}`);
  }
  assert.equal(committed.ok, true);

  assertAcceptedMutation(
    generated,
    scenario,
    committed.next,
    committed.effect.kind,
    beforeBytes,
    preparedCar,
    preparedInput,
  );

  return {
    operation: generated.operation,
    mode: generated.mode,
    scenario: generated.scenario,
    accepted: true,
    rejectionCode: null,
  };
}

function exerciseWithOrderedDiagnostics(
  generated: GeneratedMutationCase,
  generatedCase: GeneratedCase<GeneratedMutationCase>,
): CaseCoverage {
  try {
    return exerciseMutationCase(generated);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const orderedCase = JSON.stringify({
      seed: generatedCase.seed,
      index: generatedCase.index,
      mode: generated.mode,
      operation: generated.operation,
      scenario: generated.scenario,
      nonce: generated.nonce,
    });
    throw new Error(`Ordered mutation case ${orderedCase} failed: ${detail}`, { cause });
  }
}

/**
 * Feature: rocket-arena, Property 3: Atomic roster mutations
 * **Validates: Requirements 2.10, 3.1-3.2, 3.8, 3.11, 3.14-3.15, 4.1, 4.3, 4.9-4.12, 4.14-4.15, 4.18-4.20, 18.14-18.15, 18.25**
 */
test(
  `Property 3: atomic roster mutations (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  () => {
    const generatedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateMutationCase,
    });

    assert.equal(generatedCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(generatedCases, generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateMutationCase,
    }));
    assert.deepEqual(
      replayCase(RECORDED_SEED, REPLAY_CASE_INDEX, generateMutationCase),
      generatedCases[REPLAY_CASE_INDEX],
    );

    const operationCounts = generatedCases.reduce<Record<MutationOperation, number>>(
      (counts, generatedCase) => {
        counts[generatedCase.value.operation] += 1;
        return counts;
      },
      { join: 0, leave: 0, 'switch-team': 0, start: 0 },
    );
    assert.deepEqual(operationCounts, {
      join: CASES_PER_OPERATION,
      leave: CASES_PER_OPERATION,
      'switch-team': CASES_PER_OPERATION,
      start: CASES_PER_OPERATION,
    });

    for (const operation of OPERATIONS) {
      for (const mode of ['quick', 'custom'] as const) {
        assert.equal(
          generatedCases.filter(({ value }) => (
            value.operation === operation && value.mode === mode
          )).length,
          CASES_PER_OPERATION_AND_MODE,
        );
      }
    }

    const coverage: CaseCoverage[] = [];
    assertGeneratedCases(generatedCases, (generated, generatedCase) => {
      assert.equal(generatedCase.seed, RECORDED_SEED);
      assert.equal(generatedCase.index, generated.caseIndex);
      coverage.push(exerciseWithOrderedDiagnostics(generated, generatedCase));
    });

    for (const operation of OPERATIONS) {
      const operationCoverage = coverage.filter((entry) => entry.operation === operation);
      assert.equal(operationCoverage.length, CASES_PER_OPERATION);
      assert.ok(operationCoverage.some(({ accepted: wasAccepted }) => wasAccepted));
      assert.ok(operationCoverage.some(({ accepted: wasAccepted }) => !wasAccepted));
    }

    assert.deepEqual(
      [...new Set(
        coverage
          .map(({ rejectionCode }) => rejectionCode)
          .filter((code): code is RoomMutationErrorCode => code !== null),
      )].sort(),
      [...ROOM_REJECTION_CODES].sort(),
      'generated cases must represent every typed roster-mutation rejection family',
    );

    for (const mode of ['quick', 'custom'] as const) {
      const modeCoverage = coverage.filter((entry) => entry.mode === mode);
      assert.equal(modeCoverage.length, GENERATED_CASE_COUNT / 2);
      assert.ok(modeCoverage.some(({ accepted: wasAccepted }) => wasAccepted));
      assert.ok(modeCoverage.some(({ accepted: wasAccepted }) => !wasAccepted));
    }

    assert.ok(coverage.some((entry) => (
      entry.mode === 'quick'
      && entry.operation === 'leave'
      && entry.scenario === 'accepted-playing'
      && entry.accepted
    )), 'Quick Active_Play disconnect removal must be generated');
    assert.ok(coverage.some((entry) => (
      entry.mode === 'custom'
      && entry.operation === 'leave'
      && entry.scenario === 'accepted-host-countdown'
      && entry.accepted
    )), 'Custom countdown Host succession must be generated');
    assert.ok(coverage.some((entry) => (
      entry.mode === 'custom'
      && entry.operation === 'leave'
      && entry.scenario === 'accepted-final'
      && entry.accepted
    )), 'Custom final-leave cleanup must be generated');
    assert.ok(coverage.some((entry) => (
      entry.mode === 'custom'
      && entry.operation === 'switch-team'
      && entry.accepted
    )), 'accepted Custom team switches must be generated');
    assert.ok(coverage.some((entry) => (
      entry.mode === 'custom'
      && entry.operation === 'start'
      && entry.accepted
    )), 'accepted Host start validation must be generated');
  },
);
