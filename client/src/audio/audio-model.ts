import { ARENA, AUDIO, BALL, CAR, NETCODE } from '@rocket-arena/shared';

export type AudioEventType =
  | 'jump'
  | 'landing'
  | 'impact'
  | 'countdown'
  | 'go'
  | 'goal'
  | 'overtime'
  | 'match-end'
  | 'ui';

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface KinematicAudioEntity extends Vector3Like {
  vx: number;
  vy: number;
  vz: number;
}

export interface KinematicAudioCar extends KinematicAudioEntity {
  id: string;
}

export interface AudioSnapshotSample {
  sequence: number;
  phase: string;
  blueScore: number;
  orangeScore: number;
  timeRemaining: number;
  localCar: KinematicAudioCar | null;
  ball: KinematicAudioEntity | null;
  otherCars: readonly KinematicAudioCar[];
}

export interface TrackedAudioEvent {
  type: AudioEventType;
  strength: number;
  countdownValue?: number;
  source?: Vector3Like;
  /** Stable detector key used for per-contact cooldowns and deterministic diagnostics. */
  contactKey?: string;
}

export interface EngineTargets {
  speedRatio: number;
  frequencyHz: number;
  filterHz: number;
  gain: number;
}

export interface AudioTrackerDebugState {
  lastSequence: number | null;
  lastPhase: string | null;
  countdownValues: number[];
  startPlayed: boolean;
  kickoffCount: number;
  overtimePlayed: boolean;
  matchEndPlayed: boolean;
  airborne: boolean;
  pendingJumpSequence: number | null;
}

interface PendingJumpRequest {
  sequence: number;
  armedAtMs: number;
  afterSnapshotSequence: number | null;
}

type Axis = 'x' | 'y' | 'z';
type Side = -1 | 1;

interface SurfaceBoundary {
  contactKey: string;
  axis: Axis;
  side: Side;
  limit: number;
  goalOpening: boolean;
}

const CAR_PLANAR_CONTACT_RADIUS = Math.hypot(CAR.BODY.WIDTH / 2, CAR.BODY.LENGTH / 2);
const CAR_GROUNDED_CENTER_Y = (
  CAR.BODY.HEIGHT / 2
  + ARENA.KICKOFF.SPAWN_CLEARANCE
  + AUDIO.DETECTION.JUMP_GROUNDED_MARGIN
);
const BALL_CAR_CONTACT_DISTANCE = (
  BALL.RADIUS
  + CAR_PLANAR_CONTACT_RADIUS
  + AUDIO.DETECTION.ENTITY_CONTACT_MARGIN
);
const CAR_CAR_CONTACT_DISTANCE = (
  CAR_PLANAR_CONTACT_RADIUS * 2
  + AUDIO.DETECTION.ENTITY_CONTACT_MARGIN
);

const BALL_SURFACES: readonly SurfaceBoundary[] = [
  {
    contactKey: 'ball:wall:left',
    axis: 'x',
    side: -1,
    limit: -ARENA.WIDTH / 2 + BALL.RADIUS,
    goalOpening: false,
  },
  {
    contactKey: 'ball:wall:right',
    axis: 'x',
    side: 1,
    limit: ARENA.WIDTH / 2 - BALL.RADIUS,
    goalOpening: false,
  },
  {
    contactKey: 'ball:wall:blue',
    axis: 'z',
    side: -1,
    limit: -ARENA.LENGTH / 2 + BALL.RADIUS,
    goalOpening: true,
  },
  {
    contactKey: 'ball:wall:orange',
    axis: 'z',
    side: 1,
    limit: ARENA.LENGTH / 2 - BALL.RADIUS,
    goalOpening: true,
  },
  {
    contactKey: 'ball:floor',
    axis: 'y',
    side: -1,
    limit: BALL.RADIUS,
    goalOpening: false,
  },
  {
    contactKey: 'ball:ceiling',
    axis: 'y',
    side: 1,
    limit: ARENA.HEIGHT - BALL.RADIUS,
    goalOpening: false,
  },
];

const LOCAL_CAR_WALLS: readonly SurfaceBoundary[] = [
  {
    contactKey: 'wall:left',
    axis: 'x',
    side: -1,
    limit: -ARENA.WIDTH / 2 + CAR_PLANAR_CONTACT_RADIUS,
    goalOpening: false,
  },
  {
    contactKey: 'wall:right',
    axis: 'x',
    side: 1,
    limit: ARENA.WIDTH / 2 - CAR_PLANAR_CONTACT_RADIUS,
    goalOpening: false,
  },
  {
    contactKey: 'wall:blue',
    axis: 'z',
    side: -1,
    limit: -ARENA.LENGTH / 2 + CAR_PLANAR_CONTACT_RADIUS,
    goalOpening: true,
  },
  {
    contactKey: 'wall:orange',
    axis: 'z',
    side: 1,
    limit: ARENA.LENGTH / 2 - CAR_PLANAR_CONTACT_RADIUS,
    goalOpening: true,
  },
];

const QUEUEABLE_TRANSITIONS = new Set<AudioEventType>([
  'countdown',
  'go',
  'goal',
  'overtime',
  'match-end',
]);

export function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}

export function normalizeVolume(value: number): number {
  const candidate = Number.isFinite(value) ? value : AUDIO.MASTER.DEFAULT_VOLUME;
  const clamped = clamp(candidate, 0, 1);
  const step = AUDIO.MASTER.VOLUME_STEP;
  if (!Number.isFinite(step) || step <= 0) return clamped;

  const precision = Math.max(0, String(step).split('.')[1]?.length ?? 0);
  return clamp(Number((Math.round(clamped / step) * step).toFixed(precision)), 0, 1);
}

export interface AudioSettings {
  muted: boolean;
  volume: number;
}

/** Parse persisted settings without exposing storage failures to the game loop. */
export function parseAudioSettings(serialized: string | null): AudioSettings {
  const fallback: AudioSettings = {
    muted: false,
    volume: AUDIO.MASTER.DEFAULT_VOLUME,
  };

  try {
    const parsed = JSON.parse(serialized ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const candidate = parsed as Partial<AudioSettings>;
    return {
      muted: typeof candidate.muted === 'boolean' ? candidate.muted : fallback.muted,
      volume: normalizeVolume(
        typeof candidate.volume === 'number' ? candidate.volume : fallback.volume,
      ),
    };
  } catch {
    return fallback;
  }
}

/** Exponential response that is stable across different render frame rates. */
export function dampingAlpha(response: number, deltaSeconds: number): number {
  const safeResponse = Math.max(0, Number.isFinite(response) ? response : 0);
  const safeDelta = clamp(deltaSeconds, 0, AUDIO.MASTER.MAX_FRAME_DELTA_SECONDS);
  return 1 - Math.exp(-safeResponse * safeDelta);
}

/** Apply one bounded exponential damping step using a numerically stable weighted average. */
export function dampValue(
  current: number,
  target: number,
  response: number,
  deltaSeconds: number,
): number {
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const safeTarget = Number.isFinite(target) ? target : safeCurrent;
  const alpha = dampingAlpha(response, deltaSeconds);
  if (alpha <= 0 || safeCurrent === safeTarget) return safeCurrent;
  if (alpha >= 1) return safeTarget;

  const next = safeCurrent * (1 - alpha) + safeTarget * alpha;
  if (!Number.isFinite(next)) return alpha < 0.5 ? safeCurrent : safeTarget;
  return clamp(next, Math.min(safeCurrent, safeTarget), Math.max(safeCurrent, safeTarget));
}

/** Map synchronized speed and local throttle intent into bounded motor targets. */
export function speedToEngineTargets(speed: number, throttle: number): EngineTargets {
  const safeSpeed = Math.max(0, Number.isFinite(speed) ? speed : 0);
  const speedRatio = clamp(safeSpeed / AUDIO.ENGINE.SPEED_FOR_MAX, 0, 1);
  const throttleAmount = Math.abs(clamp(throttle, -1, 1));
  const frequencyHz = AUDIO.ENGINE.IDLE_FREQUENCY_HZ
    + (AUDIO.ENGINE.MAX_FREQUENCY_HZ - AUDIO.ENGINE.IDLE_FREQUENCY_HZ) * speedRatio;
  const filterHz = AUDIO.ENGINE.FILTER_MIN_HZ
    + (AUDIO.ENGINE.FILTER_MAX_HZ - AUDIO.ENGINE.FILTER_MIN_HZ) * speedRatio;
  const gain = clamp(
    AUDIO.ENGINE.BASE_GAIN
      + AUDIO.ENGINE.SPEED_GAIN * speedRatio
      + AUDIO.ENGINE.THROTTLE_GAIN * throttleAmount,
    0,
    AUDIO.ENGINE.MAX_GAIN,
  );
  return { speedRatio, frequencyHz, filterHz, gain };
}

/** Camera-relative pan derived from source direction and the camera's right axis. */
export function calculateStereoPan(
  source: Vector3Like,
  listener: Vector3Like,
  cameraRight: Vector3Like,
): number {
  const relativeX = source.x - listener.x;
  const relativeY = source.y - listener.y;
  const relativeZ = source.z - listener.z;
  const relativeLength = Math.hypot(relativeX, relativeY, relativeZ);
  const rightLength = Math.hypot(cameraRight.x, cameraRight.y, cameraRight.z);
  if (relativeLength <= Number.EPSILON || rightLength <= Number.EPSILON) return 0;

  const dot = (
    relativeX * cameraRight.x
    + relativeY * cameraRight.y
    + relativeZ * cameraRight.z
  ) / (relativeLength * rightLength);
  return clamp(dot * AUDIO.SPATIAL.PAN_STRENGTH, -1, 1);
}

export function isGameplayPhase(phase: string | null | undefined): boolean {
  return phase === 'playing' || phase === 'overtime';
}

export function isQueueableTransition(type: AudioEventType): boolean {
  return QUEUEABLE_TRANSITIONS.has(type);
}

/** Small latest-per-type queue for relevant transitions while a context is suspended. */
export class AudioTransitionQueue {
  private events: TrackedAudioEvent[] = [];

  constructor(private readonly capacity = AUDIO.MASTER.MAX_QUEUED_TRANSITIONS) {}

  enqueue(event: TrackedAudioEvent): boolean {
    if (!isQueueableTransition(event.type) || this.capacity <= 0) return false;

    const duplicateIndex = this.events.findIndex((queued) => queued.type === event.type);
    if (duplicateIndex >= 0) this.events.splice(duplicateIndex, 1);
    while (this.events.length >= this.capacity) this.events.shift();
    this.events.push(cloneEvent(event));
    return true;
  }

  drain(): TrackedAudioEvent[] {
    const queued = this.events;
    this.events = [];
    return queued;
  }

  clear(): void {
    this.events = [];
  }

  get size(): number {
    return this.events.length;
  }

  snapshot(): readonly TrackedAudioEvent[] {
    return this.events.map(cloneEvent);
  }
}

function cloneEvent(event: TrackedAudioEvent): TrackedAudioEvent {
  return {
    ...event,
    source: event.source ? { ...event.source } : undefined,
  };
}

function cloneEntity(entity: KinematicAudioEntity | null): KinematicAudioEntity | null {
  return entity ? { ...entity } : null;
}

function cloneCar(entity: KinematicAudioCar): KinematicAudioCar {
  return { ...entity };
}

function velocityDelta(
  current: KinematicAudioEntity | null,
  previous: KinematicAudioEntity | null,
): number {
  if (!current || !previous) return 0;
  return Math.hypot(
    current.vx - previous.vx,
    current.vy - previous.vy,
    current.vz - previous.vz,
  );
}

function distance(a: Vector3Like | null, b: Vector3Like | null): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function scaledStrength(value: number, threshold: number, fullStrength: number): number {
  if (value < threshold) return 0;
  const span = Math.max(Number.EPSILON, fullStrength - threshold);
  return clamp((value - threshold) / span, 0, 1);
}

function axisValue(entity: Vector3Like, axis: Axis): number {
  return entity[axis];
}

function velocityAlong(entity: KinematicAudioEntity, axis: Axis): number {
  if (axis === 'x') return entity.vx;
  if (axis === 'y') return entity.vy;
  return entity.vz;
}

function isInsideGoalOpening(
  entity: KinematicAudioEntity,
  horizontalRadius: number,
  verticalRadius: number,
): boolean {
  return (
    Math.abs(entity.x) + horizontalRadius < ARENA.GOAL.WIDTH / 2
    && entity.y + verticalRadius < ARENA.GOAL.HEIGHT
  );
}

function isNearSurface(
  entity: KinematicAudioEntity,
  surface: SurfaceBoundary,
  horizontalRadius: number,
  verticalRadius: number,
): boolean {
  if (
    surface.goalOpening
    && isInsideGoalOpening(entity, horizontalRadius, verticalRadius)
  ) return false;

  const value = axisValue(entity, surface.axis);
  return surface.side < 0
    ? value <= surface.limit + AUDIO.DETECTION.SURFACE_CONTACT_MARGIN
    : value >= surface.limit - AUDIO.DETECTION.SURFACE_CONTACT_MARGIN;
}

function surfaceImpactDelta(
  current: KinematicAudioEntity,
  previous: KinematicAudioEntity,
  surface: SurfaceBoundary,
): number {
  const previousOutward = velocityAlong(previous, surface.axis) * surface.side;
  const currentOutward = velocityAlong(current, surface.axis) * surface.side;
  const directedSpeed = Math.max(previousOutward, -currentOutward);
  if (directedSpeed < AUDIO.DETECTION.MIN_CONTACT_APPROACH_SPEED) return 0;
  return Math.abs(currentOutward - previousOutward);
}

function normalizedDirection(
  from: Vector3Like,
  to: Vector3Like,
  fallbackFrom: Vector3Like,
  fallbackTo: Vector3Like,
): Vector3Like | null {
  let x = to.x - from.x;
  let y = to.y - from.y;
  let z = to.z - from.z;
  let length = Math.hypot(x, y, z);
  if (length <= Number.EPSILON) {
    x = fallbackTo.x - fallbackFrom.x;
    y = fallbackTo.y - fallbackFrom.y;
    z = fallbackTo.z - fallbackFrom.z;
    length = Math.hypot(x, y, z);
  }
  if (length <= Number.EPSILON) return null;
  return { x: x / length, y: y / length, z: z / length };
}

function relativeNormalVelocity(
  first: KinematicAudioEntity,
  second: KinematicAudioEntity,
  normal: Vector3Like,
): number {
  return (
    (second.vx - first.vx) * normal.x
    + (second.vy - first.vy) * normal.y
    + (second.vz - first.vz) * normal.z
  );
}

function hasMeaningfulPairMotion(
  currentFirst: KinematicAudioEntity,
  currentSecond: KinematicAudioEntity,
  previousFirst: KinematicAudioEntity,
  previousSecond: KinematicAudioEntity,
): boolean {
  const previousNormal = normalizedDirection(
    previousFirst,
    previousSecond,
    currentFirst,
    currentSecond,
  );
  const currentNormal = normalizedDirection(
    currentFirst,
    currentSecond,
    previousFirst,
    previousSecond,
  );
  if (!previousNormal || !currentNormal) return false;

  const approachSpeed = Math.max(
    0,
    -relativeNormalVelocity(previousFirst, previousSecond, previousNormal),
  );
  const separationSpeed = Math.max(
    0,
    relativeNormalVelocity(currentFirst, currentSecond, currentNormal),
  );
  return Math.max(approachSpeed, separationSpeed)
    >= AUDIO.DETECTION.MIN_CONTACT_APPROACH_SPEED;
}

function isGroundedForJump(entity: KinematicAudioEntity | null): boolean {
  return entity !== null
    && entity.y <= CAR_GROUNDED_CENTER_Y
    && entity.vy < AUDIO.DETECTION.JUMP_TAKEOFF_MIN_UPWARD_SPEED;
}

function midpoint(first: Vector3Like, second: Vector3Like): Vector3Like {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
    z: (first.z + second.z) / 2,
  };
}

/**
 * Pure transition and authoritative-motion detector. It consumes immutable
 * accepted snapshots, emits semantic events once, and owns no browser APIs.
 */
export class AudioEventTracker {
  private lastSequence: number | null = null;
  private lastPhase: string | null = null;
  private lastBlueScore: number | null = null;
  private lastOrangeScore: number | null = null;
  private readonly countdownValues = new Set<number>();
  private startPlayed = false;
  private kickoffCount = 0;
  private overtimePlayed = false;
  private matchEndPlayed = false;
  private lastJumpSequence: number | null = null;
  private pendingJump: PendingJumpRequest | null = null;
  private previousBall: KinematicAudioEntity | null = null;
  private readonly previousCars = new Map<string, KinematicAudioCar>();
  private lastLocalCarId: string | null = null;
  private lastActive: boolean | null = null;
  private motionResetPending = true;
  private airborne = false;
  private fastestDownwardSpeed = 0;
  private lastLandingAtMs = Number.NEGATIVE_INFINITY;
  private readonly lastImpactAtMs = new Map<string, number>();

  observeSnapshot(sample: AudioSnapshotSample, nowMs: number): TrackedAudioEvent[] {
    if (!Number.isSafeInteger(sample.sequence) || sample.sequence < 0) return [];
    this.expirePendingJump(nowMs);
    if (sample.sequence === this.lastSequence) return [];
    if (this.lastSequence !== null && sample.sequence < this.lastSequence) this.reset();

    const events: TrackedAudioEvent[] = [];
    const firstSnapshot = this.lastSequence === null;
    const previousPhase = this.lastPhase;
    const active = isGameplayPhase(sample.phase);

    if (sample.phase === 'countdown') {
      const countdownValue = Math.ceil(sample.timeRemaining);
      if (
        countdownValue >= AUDIO.DETECTION.COUNTDOWN_MIN_VALUE
        && countdownValue <= AUDIO.DETECTION.COUNTDOWN_MAX_VALUE
        && !this.countdownValues.has(countdownValue)
      ) {
        this.countdownValues.add(countdownValue);
        events.push({ type: 'countdown', strength: 1, countdownValue });
      }
    }

    const resumedKickoff = (
      (previousPhase === 'countdown' && sample.phase === 'playing')
      || (previousPhase === 'goal-scored' && active)
    );
    if (resumedKickoff) {
      this.startPlayed = true;
      this.kickoffCount += 1;
      events.push({ type: 'go', strength: 1 });
    }

    if (sample.phase === 'overtime' && !this.overtimePlayed) {
      this.overtimePlayed = true;
      events.push({ type: 'overtime', strength: 1 });
    }

    if (sample.phase === 'ended' && !firstSnapshot && !this.matchEndPlayed) {
      this.matchEndPlayed = true;
      events.push({ type: 'match-end', strength: 1 });
    }

    if (this.lastBlueScore !== null && this.lastOrangeScore !== null) {
      const previousTotal = this.lastBlueScore + this.lastOrangeScore;
      const nextTotal = sample.blueScore + sample.orangeScore;
      if (nextTotal > previousTotal) {
        events.push({
          type: 'goal',
          strength: 1,
          source: sample.ball ? { x: sample.ball.x, y: sample.ball.y, z: sample.ball.z } : undefined,
        });
      }
    }

    this.detectMotionEvents(sample, nowMs, active, events);
    this.lastSequence = sample.sequence;
    this.lastPhase = sample.phase;
    this.lastBlueScore = sample.blueScore;
    this.lastOrangeScore = sample.orangeScore;
    this.lastActive = active;
    return events;
  }

  /** Consume a monotonic input edge and arm, but never acknowledge, the request. */
  observeJump(jumpSequence: number | undefined, active: boolean, nowMs = 0): TrackedAudioEvent[] {
    this.expirePendingJump(nowMs);
    const nextSequence = Number.isSafeInteger(jumpSequence) && (jumpSequence ?? -1) >= 0
      ? jumpSequence as number
      : 0;
    if (this.lastJumpSequence === null || nextSequence < this.lastJumpSequence) {
      this.lastJumpSequence = nextSequence;
      this.pendingJump = null;
      return [];
    }
    if (nextSequence === this.lastJumpSequence) return [];

    this.lastJumpSequence = nextSequence;
    const previousLocalCar = this.lastLocalCarId
      ? this.previousCars.get(this.lastLocalCarId) ?? null
      : null;
    if (!active || !isGroundedForJump(previousLocalCar)) {
      this.pendingJump = null;
      return [];
    }

    this.pendingJump = {
      sequence: nextSequence,
      armedAtMs: nowMs,
      afterSnapshotSequence: this.lastSequence,
    };
    return [];
  }

  /** Mark the next accepted snapshot as a new motion baseline. */
  resetMotionHistory(): void {
    this.previousBall = null;
    this.previousCars.clear();
    this.lastLocalCarId = null;
    this.motionResetPending = true;
    this.airborne = false;
    this.fastestDownwardSpeed = 0;
    this.lastLandingAtMs = Number.NEGATIVE_INFINITY;
    this.lastImpactAtMs.clear();
    this.pendingJump = null;
  }

  reset(): void {
    this.lastSequence = null;
    this.lastPhase = null;
    this.lastBlueScore = null;
    this.lastOrangeScore = null;
    this.countdownValues.clear();
    this.startPlayed = false;
    this.kickoffCount = 0;
    this.overtimePlayed = false;
    this.matchEndPlayed = false;
    this.lastJumpSequence = null;
    this.lastActive = null;
    this.resetMotionHistory();
  }

  getDebugState(): AudioTrackerDebugState {
    return {
      lastSequence: this.lastSequence,
      lastPhase: this.lastPhase,
      countdownValues: [...this.countdownValues].sort((left, right) => left - right),
      startPlayed: this.startPlayed,
      kickoffCount: this.kickoffCount,
      overtimePlayed: this.overtimePlayed,
      matchEndPlayed: this.matchEndPlayed,
      airborne: this.airborne,
      pendingJumpSequence: this.pendingJump?.sequence ?? null,
    };
  }

  private detectMotionEvents(
    sample: AudioSnapshotSample,
    nowMs: number,
    active: boolean,
    events: TrackedAudioEvent[],
  ): void {
    const inactiveToActive = active && this.lastActive === false;
    const localIdentityChanged = (
      this.lastLocalCarId !== null
      && sample.localCar !== null
      && this.lastLocalCarId !== sample.localCar.id
    );
    const teleported = this.hasTeleport(sample);

    if (!active || this.motionResetPending || inactiveToActive || localIdentityChanged || teleported) {
      this.seedMotionHistory(sample, active);
      return;
    }

    const localCar = sample.localCar;
    const previousLocalCar = localCar
      ? this.previousCars.get(localCar.id) ?? null
      : null;

    this.confirmPendingJump(sample, previousLocalCar, nowMs, events);
    this.detectLanding(localCar, nowMs, events);
    this.detectImpacts(sample, events, nowMs);
    this.updateMotionHistory(sample);
  }

  private confirmPendingJump(
    sample: AudioSnapshotSample,
    previousLocalCar: KinematicAudioCar | null,
    nowMs: number,
    events: TrackedAudioEvent[],
  ): void {
    const pending = this.pendingJump;
    const localCar = sample.localCar;
    if (!pending || !localCar || !previousLocalCar) return;
    if (
      pending.afterSnapshotSequence !== null
      && sample.sequence <= pending.afterSnapshotSequence
    ) return;

    const confirmed = (
      isGroundedForJump(previousLocalCar)
      && localCar.vy >= AUDIO.DETECTION.JUMP_TAKEOFF_MIN_UPWARD_SPEED
      && localCar.y - previousLocalCar.y >= AUDIO.DETECTION.JUMP_TAKEOFF_MIN_RISE
      && nowMs - pending.armedAtMs <= AUDIO.DETECTION.JUMP_CONFIRM_WINDOW_MS
    );
    if (!confirmed) return;

    events.push({
      type: 'jump',
      strength: 1,
      source: { x: localCar.x, y: localCar.y, z: localCar.z },
    });
    this.pendingJump = null;
  }

  private detectLanding(
    localCar: KinematicAudioCar | null,
    nowMs: number,
    events: TrackedAudioEvent[],
  ): void {
    if (!localCar) {
      this.airborne = false;
      this.fastestDownwardSpeed = 0;
      return;
    }

    if (localCar.y > AUDIO.DETECTION.AIRBORNE_HEIGHT) {
      this.airborne = true;
      this.fastestDownwardSpeed = Math.min(this.fastestDownwardSpeed, localCar.vy);
      return;
    }
    if (!this.airborne) return;

    const downwardSpeed = Math.abs(Math.min(this.fastestDownwardSpeed, 0));
    if (
      downwardSpeed >= AUDIO.DETECTION.LANDING_MIN_DOWNWARD_SPEED
      && nowMs - this.lastLandingAtMs >= AUDIO.DETECTION.LANDING_COOLDOWN_MS
    ) {
      this.lastLandingAtMs = nowMs;
      events.push({
        type: 'landing',
        strength: scaledStrength(
          downwardSpeed,
          AUDIO.DETECTION.LANDING_MIN_DOWNWARD_SPEED,
          AUDIO.DETECTION.LANDING_FULL_STRENGTH_SPEED,
        ),
        source: { x: localCar.x, y: localCar.y, z: localCar.z },
      });
    }
    this.airborne = false;
    this.fastestDownwardSpeed = 0;
  }

  private detectImpacts(
    sample: AudioSnapshotSample,
    events: TrackedAudioEvent[],
    nowMs: number,
  ): void {
    interface ImpactCandidate {
      contactKey: string;
      strength: number;
      source: Vector3Like;
      participants: readonly string[];
    }

    interface ImpactCluster {
      candidates: ImpactCandidate[];
      participants: Set<string>;
    }

    const candidates: ImpactCandidate[] = [];
    const queue = (
      contactKey: string,
      strength: number,
      source: Vector3Like,
      participants: readonly string[],
    ): void => {
      if (strength <= 0) return;
      candidates.push({ contactKey, strength, source, participants });
    };

    const ball = sample.ball;
    const previousBall = this.previousBall;
    if (ball && previousBall) {
      for (const surface of BALL_SURFACES) {
        const nearSurface = (
          isNearSurface(ball, surface, BALL.RADIUS, BALL.RADIUS)
          || isNearSurface(previousBall, surface, BALL.RADIUS, BALL.RADIUS)
        );
        if (!nearSurface) continue;
        const delta = surfaceImpactDelta(ball, previousBall, surface);
        queue(
          surface.contactKey,
          scaledStrength(
            delta,
            AUDIO.DETECTION.BALL_IMPACT_MIN_DELTA_SPEED,
            AUDIO.DETECTION.IMPACT_FULL_STRENGTH_DELTA_SPEED,
          ),
          ball,
          ['ball'],
        );
      }
    }

    const localCar = sample.localCar;
    const previousLocalCar = localCar
      ? this.previousCars.get(localCar.id) ?? null
      : null;
    if (localCar && previousLocalCar) {
      for (const wall of LOCAL_CAR_WALLS) {
        const nearWall = (
          isNearSurface(localCar, wall, CAR_PLANAR_CONTACT_RADIUS, CAR.BODY.HEIGHT / 2)
          || isNearSurface(
            previousLocalCar,
            wall,
            CAR_PLANAR_CONTACT_RADIUS,
            CAR.BODY.HEIGHT / 2,
          )
        );
        if (!nearWall) continue;
        const delta = surfaceImpactDelta(localCar, previousLocalCar, wall);
        queue(
          `car:${localCar.id}:${wall.contactKey}`,
          scaledStrength(
            delta,
            AUDIO.DETECTION.CAR_IMPACT_MIN_DELTA_SPEED,
            AUDIO.DETECTION.IMPACT_FULL_STRENGTH_DELTA_SPEED,
          ),
          localCar,
          [`car:${localCar.id}`],
        );
      }
    }

    const cars = localCar ? [localCar, ...sample.otherCars] : [...sample.otherCars];
    if (ball && previousBall) {
      for (const car of cars) {
        const previousCar = this.previousCars.get(car.id);
        if (!previousCar) continue;
        const closeEnough = (
          distance(ball, car) <= BALL_CAR_CONTACT_DISTANCE
          || distance(previousBall, previousCar) <= BALL_CAR_CONTACT_DISTANCE
        );
        if (
          !closeEnough
          || !hasMeaningfulPairMotion(ball, car, previousBall, previousCar)
        ) continue;

        const strength = Math.max(
          scaledStrength(
            velocityDelta(ball, previousBall),
            AUDIO.DETECTION.BALL_IMPACT_MIN_DELTA_SPEED,
            AUDIO.DETECTION.IMPACT_FULL_STRENGTH_DELTA_SPEED,
          ),
          scaledStrength(
            velocityDelta(car, previousCar),
            AUDIO.DETECTION.CAR_IMPACT_MIN_DELTA_SPEED,
            AUDIO.DETECTION.IMPACT_FULL_STRENGTH_DELTA_SPEED,
          ),
        );
        queue(
          `ball-car:${car.id}`,
          strength,
          midpoint(ball, car),
          ['ball', `car:${car.id}`],
        );
      }
    }

    for (let firstIndex = 0; firstIndex < cars.length; firstIndex++) {
      const first = cars[firstIndex];
      const previousFirst = this.previousCars.get(first.id);
      if (!previousFirst) continue;
      for (let secondIndex = firstIndex + 1; secondIndex < cars.length; secondIndex++) {
        const second = cars[secondIndex];
        const previousSecond = this.previousCars.get(second.id);
        if (!previousSecond) continue;
        const closeEnough = (
          distance(first, second) <= CAR_CAR_CONTACT_DISTANCE
          || distance(previousFirst, previousSecond) <= CAR_CAR_CONTACT_DISTANCE
        );
        if (
          !closeEnough
          || !hasMeaningfulPairMotion(first, second, previousFirst, previousSecond)
        ) continue;

        const strength = scaledStrength(
          Math.max(
            velocityDelta(first, previousFirst),
            velocityDelta(second, previousSecond),
          ),
          AUDIO.DETECTION.CAR_IMPACT_MIN_DELTA_SPEED,
          AUDIO.DETECTION.IMPACT_FULL_STRENGTH_DELTA_SPEED,
        );
        const orderedIds = first.id < second.id
          ? `${first.id}:${second.id}`
          : `${second.id}:${first.id}`;
        queue(
          `car-car:${orderedIds}`,
          strength,
          midpoint(first, second),
          [`car:${first.id}`, `car:${second.id}`],
        );
      }
    }

    const clusters: ImpactCluster[] = [];
    for (const candidate of candidates) {
      const matchingClusterIndices: number[] = [];
      for (let index = 0; index < clusters.length; index++) {
        if (candidate.participants.some((participant) => (
          clusters[index].participants.has(participant)
        ))) matchingClusterIndices.push(index);
      }

      if (matchingClusterIndices.length === 0) {
        clusters.push({
          candidates: [candidate],
          participants: new Set(candidate.participants),
        });
        continue;
      }

      const target = clusters[matchingClusterIndices[0]];
      target.candidates.push(candidate);
      for (const participant of candidate.participants) target.participants.add(participant);
      for (let match = matchingClusterIndices.length - 1; match >= 1; match--) {
        const merged = clusters[matchingClusterIndices[match]];
        target.candidates.push(...merged.candidates);
        for (const participant of merged.participants) target.participants.add(participant);
        clusters.splice(matchingClusterIndices[match], 1);
      }
    }

    let emitted = 0;
    for (const cluster of clusters) {
      if (emitted >= AUDIO.DETECTION.MAX_IMPACTS_PER_SNAPSHOT) break;
      const contactKeys = [...new Set(
        cluster.candidates.map((candidate) => candidate.contactKey),
      )];
      if (contactKeys.some((contactKey) => this.isImpactCoolingDown(contactKey, nowMs))) {
        continue;
      }

      const representative = cluster.candidates.reduce((best, candidate) => {
        if (candidate.strength > best.strength) return candidate;
        if (
          candidate.strength === best.strength
          && candidate.contactKey.localeCompare(best.contactKey) < 0
        ) return candidate;
        return best;
      });
      for (const contactKey of contactKeys) this.rememberImpact(contactKey, nowMs);
      events.push({
        type: 'impact',
        strength: representative.strength,
        source: {
          x: representative.source.x,
          y: representative.source.y,
          z: representative.source.z,
        },
        contactKey: representative.contactKey,
      });
      emitted += 1;
    }
  }

  private isImpactCoolingDown(contactKey: string, nowMs: number): boolean {
    const lastImpact = this.lastImpactAtMs.get(contactKey);
    return lastImpact !== undefined
      && nowMs - lastImpact < AUDIO.DETECTION.IMPACT_COOLDOWN_MS;
  }

  private rememberImpact(contactKey: string, nowMs: number): void {
    if (
      !this.lastImpactAtMs.has(contactKey)
      && this.lastImpactAtMs.size >= AUDIO.DETECTION.MAX_TRACKED_IMPACT_CONTACTS
    ) {
      let oldestKey: string | null = null;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [key, time] of this.lastImpactAtMs) {
        if (time < oldestTime) {
          oldestKey = key;
          oldestTime = time;
        }
      }
      if (oldestKey !== null) this.lastImpactAtMs.delete(oldestKey);
    }

    this.lastImpactAtMs.set(contactKey, nowMs);
  }

  private hasTeleport(sample: AudioSnapshotSample): boolean {
    if (
      sample.ball
      && this.previousBall
      && distance(sample.ball, this.previousBall) > NETCODE.TELEPORT_THRESHOLD
    ) return true;

    const cars = sample.localCar
      ? [sample.localCar, ...sample.otherCars]
      : sample.otherCars;
    return cars.some((car) => {
      const previous = this.previousCars.get(car.id);
      return previous !== undefined
        && distance(car, previous) > NETCODE.TELEPORT_THRESHOLD;
    });
  }

  private seedMotionHistory(sample: AudioSnapshotSample, active: boolean): void {
    this.previousBall = cloneEntity(sample.ball);
    this.previousCars.clear();
    if (sample.localCar) this.previousCars.set(sample.localCar.id, cloneCar(sample.localCar));
    for (const car of sample.otherCars) this.previousCars.set(car.id, cloneCar(car));
    this.lastLocalCarId = sample.localCar?.id ?? null;
    this.motionResetPending = false;
    this.pendingJump = null;

    if (active && sample.localCar?.y && sample.localCar.y > AUDIO.DETECTION.AIRBORNE_HEIGHT) {
      this.airborne = true;
      this.fastestDownwardSpeed = Math.min(0, sample.localCar.vy);
    } else {
      this.airborne = false;
      this.fastestDownwardSpeed = 0;
    }
  }

  private updateMotionHistory(sample: AudioSnapshotSample): void {
    this.previousBall = cloneEntity(sample.ball);
    this.previousCars.clear();
    if (sample.localCar) this.previousCars.set(sample.localCar.id, cloneCar(sample.localCar));
    for (const car of sample.otherCars) this.previousCars.set(car.id, cloneCar(car));
    this.lastLocalCarId = sample.localCar?.id ?? null;
  }

  private expirePendingJump(nowMs: number): void {
    if (
      this.pendingJump
      && nowMs - this.pendingJump.armedAtMs > AUDIO.DETECTION.JUMP_CONFIRM_WINDOW_MS
    ) this.pendingJump = null;
  }
}
