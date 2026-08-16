/** Input payload sent from client to server. */
export interface InputPayload {
  /** Forward/backward: 1 = forward, -1 = brake/reverse, 0 = neutral. */
  throttle: number;
  /** Steering: 1 = left, -1 = right, 0 = straight. */
  steer: number;
  /** Current physical jump-key state for legacy boolean edge detection. */
  jump: boolean;
  /** Boost held. */
  boost: boolean;
  /**
   * Monotonic physical jump-press id. New clients increment this once for each
   * non-repeat Space keydown so a press survives a collapsed keydown/keyup.
   * Optional for backwards compatibility with direct harnesses and old clients.
   */
  jumpSequence?: number;
}
