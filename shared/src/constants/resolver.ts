import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  getScalarTuningValue,
} from '../tuning/registry.js';
import type { TuningRegistrySnapshot } from '../tuning/model.js';
import { DEFAULTS_REGISTRY, isMechanicsConstantPath } from './registry.js';

/** Legacy presentation-only overrides; authoritative mechanics use registry snapshots. */
const compatibilityOverrides = new Map<string, number>();

/** Resolve an unchanged compatibility constant by its historical dot path. */
export function getConstant(path: string): number {
  const override = compatibilityOverrides.get(path);
  if (override !== undefined) return override;
  const defaultValue = DEFAULTS_REGISTRY.get(path);
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`[Constants] Unknown path: "${path}"`);
}

/** Resolve one scalar from an explicit immutable tuning snapshot. */
export function getTuningConstant(
  id: string,
  snapshot: Pick<TuningRegistrySnapshot, 'get'> = DEFAULT_TUNING_REGISTRY_SNAPSHOT,
): number {
  return getScalarTuningValue(snapshot, id);
}

/**
 * Deprecated compatibility API for audio/visual development controls only.
 * Mechanics paths are intentionally rejected because process-global mutation
 * would bypass atomic range checks, registry history, and room pinning.
 */
export function setOverride(path: string, value: number): void {
  if (!DEFAULTS_REGISTRY.has(path)) {
    throw new Error(`[Constants] Cannot override unknown path: "${path}"`);
  }
  if (!Number.isFinite(value)) {
    throw new RangeError(`[Constants] Override for "${path}" must be finite.`);
  }
  if (isMechanicsConstantPath(path)) {
    throw new Error(
      `[Constants] Mechanics path "${path}" requires a VersionedTuningRegistry proposal.`,
    );
  }
  compatibilityOverrides.set(path, value);
}

export function clearOverride(path: string): void {
  compatibilityOverrides.delete(path);
}

export function clearOverrides(): void {
  compatibilityOverrides.clear();
}

/** Return an isolated read-only copy so callers cannot mutate resolver state. */
export function getOverrides(): ReadonlyMap<string, number> {
  return new Map(compatibilityOverrides);
}

export function getDefault(path: string): number {
  const value = DEFAULTS_REGISTRY.get(path);
  if (value !== undefined) return value;
  throw new Error(`[Constants] Unknown path: "${path}"`);
}
