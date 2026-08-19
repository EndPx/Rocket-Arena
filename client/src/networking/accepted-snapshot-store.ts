import type {
  DomainSnapshot,
  SnapshotValidationResult,
} from './snapshot-validator.js';

/**
 * An opaque-by-identity token for one joined-room lifetime. Consumers must
 * capture this token before staging asynchronous snapshot work.
 */
export interface AcceptedSnapshotGeneration {
  readonly id: number;
}

export interface AcceptedSnapshotState {
  readonly generation: AcceptedSnapshotGeneration;
  readonly snapshot: Readonly<DomainSnapshot> | null;
}

export type AcceptedSnapshotChangeType = 'commit' | 'reset';

export interface AcceptedSnapshotChange {
  readonly type: AcceptedSnapshotChangeType;
  readonly previous: AcceptedSnapshotState;
  readonly current: AcceptedSnapshotState;
}

export type AcceptedSnapshotSubscriber = (change: AcceptedSnapshotChange) => void;
export type AcceptedSnapshotUnsubscribe = () => void;
export type AcceptedSnapshotSubscriberErrorHandler = (
  error: unknown,
  subscriber: AcceptedSnapshotSubscriber,
) => void;

interface Subscription {
  readonly subscriber: AcceptedSnapshotSubscriber;
  active: boolean;
}

function createGeneration(id: number): AcceptedSnapshotGeneration {
  return Object.freeze({ id });
}

function createState(
  generation: AcceptedSnapshotGeneration,
  snapshot: Readonly<DomainSnapshot> | null,
): AcceptedSnapshotState {
  return Object.freeze({ generation, snapshot });
}

function createChange(
  type: AcceptedSnapshotChangeType,
  previous: AcceptedSnapshotState,
  current: AcceptedSnapshotState,
): AcceptedSnapshotChange {
  return Object.freeze({ type, previous, current });
}

function reportSubscriberError(
  error: unknown,
  _subscriber: AcceptedSnapshotSubscriber,
): void {
  console.error('[accepted-snapshot-store] subscriber failed', error);
}

/**
 * The client-wide acceptance boundary for lobby, HUD, audio, camera, and
 * entity-lifecycle consumers.
 *
 * SnapshotValidationResult is accepted directly so a rejected decoder result
 * cannot accidentally notify presentation consumers. Generation identity is
 * checked at commit and reset time so work from a departed room is harmless.
 */
export class AcceptedSnapshotStore {
  private generationId = 0;
  private state: AcceptedSnapshotState = createState(createGeneration(0), null);
  private readonly subscriptions = new Set<Subscription>();
  private readonly handleSubscriberError: AcceptedSnapshotSubscriberErrorHandler;

  constructor(
    handleSubscriberError: AcceptedSnapshotSubscriberErrorHandler = reportSubscriberError,
  ) {
    this.handleSubscriberError = handleSubscriberError;
  }

  getState(): AcceptedSnapshotState {
    return this.state;
  }

  getSnapshot(): Readonly<DomainSnapshot> | null {
    return this.state.snapshot;
  }

  getGeneration(): AcceptedSnapshotGeneration {
    return this.state.generation;
  }

  /**
   * Atomically publish one decoder-approved candidate for the captured room
   * generation. Rejected candidates and stale generations are no-ops.
   */
  commit(
    candidate: SnapshotValidationResult,
    generation: AcceptedSnapshotGeneration,
  ): boolean {
    if (!candidate.ok || generation !== this.state.generation) return false;

    const previous = this.state;
    const current = createState(generation, candidate.snapshot);
    this.state = current;
    this.notify(createChange('commit', previous, current));
    return true;
  }

  /**
   * Clear accepted room state and advance to a fresh generation. A stale room
   * may not reset the state of a room that has already replaced it.
   */
  reset(
    generation: AcceptedSnapshotGeneration,
  ): AcceptedSnapshotGeneration | null {
    if (generation !== this.state.generation) return null;
    if (this.generationId >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('accepted snapshot generation exhausted');
    }

    const previous = this.state;
    const nextGeneration = createGeneration(++this.generationId);
    const current = createState(nextGeneration, null);
    this.state = current;
    this.notify(createChange('reset', previous, current));
    return nextGeneration;
  }

  /**
   * Subscribe to future commits and resets. There is no eager notification;
   * consumers can synchronously seed themselves from getState() first.
   */
  subscribe(subscriber: AcceptedSnapshotSubscriber): AcceptedSnapshotUnsubscribe {
    const subscription: Subscription = { subscriber, active: true };
    this.subscriptions.add(subscription);

    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      this.subscriptions.delete(subscription);
    };
  }

  private notify(change: AcceptedSnapshotChange): void {
    // Snapshot the list so subscriptions added during a notification do not
    // observe half of the current transition.
    for (const subscription of [...this.subscriptions]) {
      if (!subscription.active) continue;
      try {
        subscription.subscriber(change);
      } catch (error) {
        // A broken presentation consumer must not prevent any other consumer
        // from observing the same already-committed atomic state.
        try {
          this.handleSubscriberError(error, subscription.subscriber);
        } catch {
          // Error reporting is also isolated from the remaining subscribers.
        }
      }
    }
  }
}

/** The one application-wide source imported by all accepted-state consumers. */
export const acceptedSnapshotStore = new AcceptedSnapshotStore();
