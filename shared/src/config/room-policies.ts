import { ROOM_MODES, type RoomMode } from '../types/room.js';

export type RoomPolicyVersion = 1;
/** Training is solo, so one seat is a real capacity alongside Quick's 6 and Custom's 8. */
export type RoomTotalCapacity = 1 | 6 | 8;
export type RoomTeamCapacity = 1 | 3 | 4;
export type TeamAssignmentTieBreak = 'blue';
export type RoomStartRule = 'full-balanced' | 'host-request';

export interface RoomPolicy {
  readonly version: RoomPolicyVersion;
  readonly mode: RoomMode;
  readonly totalCapacity: RoomTotalCapacity;
  readonly teamCapacity: RoomTeamCapacity;
  readonly assignmentTieBreak: TeamAssignmentTieBreak;
  readonly startRule: RoomStartRule;
  readonly allowWaitingTeamSwitch: boolean;
}

const QUICK_POLICY = Object.freeze({
  version: 1,
  mode: 'quick',
  totalCapacity: 6,
  teamCapacity: 3,
  assignmentTieBreak: 'blue',
  startRule: 'full-balanced',
  allowWaitingTeamSwitch: false,
} satisfies RoomPolicy);

const CUSTOM_POLICY = Object.freeze({
  version: 1,
  mode: 'custom',
  totalCapacity: 8,
  teamCapacity: 4,
  assignmentTieBreak: 'blue',
  startRule: 'host-request',
  allowWaitingTeamSwitch: true,
} satisfies RoomPolicy);

/**
 * Free roam for one player. The seat count is the policy, so the transport and
 * every capacity predicate agree that a second identity can never be admitted.
 *
 * `host-request` is reused rather than given a rule of its own: the sole
 * occupant is the room's Host, and the host-request branch of the start gate
 * already accepts a roster of one, so training needs no new start semantics.
 * Waiting-team switches are pointless with a single seat.
 */
const TRAINING_POLICY = Object.freeze({
  version: 1,
  mode: 'training',
  totalCapacity: 1,
  teamCapacity: 1,
  assignmentTieBreak: 'blue',
  startRule: 'host-request',
  allowWaitingTeamSwitch: false,
} satisfies RoomPolicy);

/** Canonical, runtime-immutable capacity and start policy for each room mode. */
export const ROOM_POLICIES: Readonly<Record<RoomMode, RoomPolicy>> = Object.freeze({
  quick: QUICK_POLICY,
  custom: CUSTOM_POLICY,
  training: TRAINING_POLICY,
});

export class InvalidRoomPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRoomPolicyError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRoomMode(value: unknown): value is RoomMode {
  return ROOM_MODES.some((mode) => mode === value);
}

/**
 * Validate an untrusted policy descriptor against the immutable mode mapping.
 * A successful validation returns the canonical frozen policy, never the
 * caller-owned object.
 */
export function validateRoomPolicy(candidate: unknown): RoomPolicy {
  if (!isRecord(candidate)) {
    throw new InvalidRoomPolicyError('Room policy must be an object.');
  }

  if (!isRoomMode(candidate.mode)) {
    throw new InvalidRoomPolicyError(`Unsupported room mode: ${String(candidate.mode)}.`);
  }

  const expected = ROOM_POLICIES[candidate.mode];
  const fields = [
    'version',
    'mode',
    'totalCapacity',
    'teamCapacity',
    'assignmentTieBreak',
    'startRule',
    'allowWaitingTeamSwitch',
  ] as const;

  const candidateFields = Object.keys(candidate).sort();
  const canonicalFields = [...fields].sort();
  if (
    candidateFields.length !== canonicalFields.length
    || candidateFields.some((field, index) => field !== canonicalFields[index])
  ) {
    throw new InvalidRoomPolicyError(
      `Invalid ${candidate.mode} room policy shape: expected only canonical policy fields.`,
    );
  }

  for (const field of fields) {
    if (candidate[field] !== expected[field]) {
      throw new InvalidRoomPolicyError(
        `Invalid ${candidate.mode} room policy field "${field}": expected ${String(expected[field])}.`,
      );
    }
  }

  return expected;
}

export function isRoomPolicy(candidate: unknown): candidate is RoomPolicy {
  try {
    validateRoomPolicy(candidate);
    return true;
  } catch {
    return false;
  }
}

export function getRoomPolicy(mode: unknown): RoomPolicy {
  if (!isRoomMode(mode)) {
    throw new InvalidRoomPolicyError(`Unsupported room mode: ${String(mode)}.`);
  }
  return ROOM_POLICIES[mode];
}
