/**
 * Trust boundary for values a connected client controls.
 *
 * Room handlers receive `unknown` straight off the wire, so anything that
 * reaches replicated state or process-global tuning is clamped here first.
 */

/** Longest display name accepted from a joining client. */
export const MAX_PLAYER_NAME_LENGTH = 24;

/** Control and formatting codepoints, stripped so names stay renderable. */
const UNRENDERABLE_CODEPOINTS = /[\p{Cc}\p{Cf}]/gu;

/**
 * Reduce a client-supplied display name to a bounded, printable string.
 *
 * An unbounded name would be copied into replicated room state and rebroadcast
 * to every peer on each patch, so length is capped by codepoint rather than by
 * UTF-16 unit to avoid splitting astral characters into lone surrogates.
 */
export function sanitizePlayerName(candidate: unknown, fallback: string): string {
  if (typeof candidate !== 'string') return fallback;

  const printable = candidate.replace(UNRENDERABLE_CODEPOINTS, '').trim();
  if (printable.length === 0) return fallback;

  const bounded = [...printable].slice(0, MAX_PLAYER_NAME_LENGTH).join('').trim();
  return bounded.length === 0 ? fallback : bounded;
}

/** The subset of the environment that gates the development transports. */
export type DevControlEnvironment = {
  readonly NODE_ENV?: string;
  readonly ROCKET_ARENA_DEV_CONTROLS?: string;
};

/**
 * Whether the `dev-tune` / `dev-reset` transports should be registered.
 *
 * Those handlers mutate compatibility overrides held in module scope, so one
 * client's message changes tuning for every room in the process. They stay off
 * under `NODE_ENV=production` unless an operator opts back in explicitly.
 */
export function devControlsEnabled(
  env: DevControlEnvironment = process.env,
): boolean {
  if (env.ROCKET_ARENA_DEV_CONTROLS === 'true') return true;
  return env.NODE_ENV !== 'production';
}
