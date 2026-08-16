import { DEFAULTS_REGISTRY } from './registry.js';

/** Mutable override map — populated at runtime by the dev panel. Empty in production. */
const overrides: Map<string, number> = new Map();

/**
 * Resolve a constant value by dot-path.
 * Checks override map first, falls back to frozen default.
 * All simulation code should read through this, never from the frozen object directly.
 *
 * @example getConstant("CAR.ENGINE.FORWARD_FORCE") // 3600 (or overridden value)
 */
export function getConstant(path: string): number {
  const override = overrides.get(path);
  if (override !== undefined) return override;

  const defaultVal = DEFAULTS_REGISTRY.get(path);
  if (defaultVal !== undefined) return defaultVal;

  throw new Error(`[Constants] Unknown path: "${path}"`);
}

/** Set a runtime override (used by dev panel) */
export function setOverride(path: string, value: number): void {
  if (!DEFAULTS_REGISTRY.has(path)) {
    throw new Error(`[Constants] Cannot override unknown path: "${path}"`);
  }
  overrides.set(path, value);
}

/** Remove a single override, reverting to default */
export function clearOverride(path: string): void {
  overrides.delete(path);
}

/** Remove all overrides, reverting everything to defaults */
export function clearOverrides(): void {
  overrides.clear();
}

/** Get all current overrides (for dev panel display) */
export function getOverrides(): ReadonlyMap<string, number> {
  return overrides;
}

/** Get the default value ignoring overrides */
export function getDefault(path: string): number {
  const val = DEFAULTS_REGISTRY.get(path);
  if (val !== undefined) return val;
  throw new Error(`[Constants] Unknown path: "${path}"`);
}
