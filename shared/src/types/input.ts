/** Input payload sent from client to server each tick */
export interface InputPayload {
  /** Forward/backward: 1 = forward, -1 = brake/reverse, 0 = neutral */
  throttle: number;
  /** Steering: 1 = left, -1 = right, 0 = straight */
  steer: number;
  /** Jump trigger (edge-detected on server, not held) */
  jump: boolean;
  /** Boost held */
  boost: boolean;
}
