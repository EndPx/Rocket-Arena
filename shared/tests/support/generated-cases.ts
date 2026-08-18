export type GeneratedCaseSeed = string | number;

export interface SeededRandom {
  readonly seed: string;
  next(): number;
  integer(minInclusive: number, maxInclusive: number): number;
  boolean(probability?: number): boolean;
  pick<T>(values: readonly T[]): T;
}

export interface GeneratedCase<T> {
  readonly seed: string;
  readonly index: number;
  readonly value: T;
}

export interface GenerateCasesOptions<T> {
  readonly seed: GeneratedCaseSeed;
  readonly count: number;
  readonly generate: (random: SeededRandom, index: number) => T;
}

function normalizeSeed(seed: GeneratedCaseSeed): string {
  const normalized = String(seed);
  if (normalized.length === 0) {
    throw new RangeError('A generated-case seed must not be empty.');
  }
  return normalized;
}

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Small deterministic PRNG for generated tests. Its algorithm is intentionally
 * local and stable so replay does not depend on a property-testing package.
 */
export function createSeededRandom(seed: GeneratedCaseSeed): SeededRandom {
  const recordedSeed = normalizeSeed(seed);
  let state = hashSeed(recordedSeed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };

  return Object.freeze({
    seed: recordedSeed,
    next,
    integer(minInclusive: number, maxInclusive: number): number {
      if (
        !Number.isSafeInteger(minInclusive)
        || !Number.isSafeInteger(maxInclusive)
        || minInclusive > maxInclusive
      ) {
        throw new RangeError('Generated integer bounds must be ordered safe integers.');
      }

      const width = maxInclusive - minInclusive + 1;
      if (!Number.isSafeInteger(width) || width <= 0) {
        throw new RangeError('Generated integer range is too wide.');
      }
      return minInclusive + Math.floor(next() * width);
    },
    boolean(probability = 0.5): boolean {
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new RangeError('Generated boolean probability must be finite and within [0, 1].');
      }
      return next() < probability;
    },
    pick<T>(values: readonly T[]): T {
      if (values.length === 0) {
        throw new RangeError('Cannot pick from an empty generated-case collection.');
      }
      return values[Math.floor(next() * values.length)]!;
    },
  });
}

/** Generate an immutable, ordered case sequence carrying replay metadata. */
export function generateCases<T>(options: GenerateCasesOptions<T>): readonly GeneratedCase<T>[] {
  if (!Number.isSafeInteger(options.count) || options.count < 0) {
    throw new RangeError('Generated case count must be a non-negative safe integer.');
  }

  const random = createSeededRandom(options.seed);
  const cases: GeneratedCase<T>[] = [];
  for (let index = 0; index < options.count; index += 1) {
    cases.push(Object.freeze({
      seed: random.seed,
      index,
      value: options.generate(random, index),
    }));
  }
  return Object.freeze(cases);
}

/** Replay one ordered case by consuming the exact preceding seeded sequence. */
export function replayCase<T>(
  seed: GeneratedCaseSeed,
  index: number,
  generate: GenerateCasesOptions<T>['generate'],
): GeneratedCase<T> {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError('Generated case index must be a non-negative safe integer.');
  }
  return generateCases({ seed, count: index + 1, generate })[index]!;
}

/**
 * Execute generated assertions while preserving the original failure as the
 * cause and adding the recorded seed plus zero-based ordered case index.
 */
export function assertGeneratedCases<T>(
  cases: readonly GeneratedCase<T>[],
  assertion: (value: T, generatedCase: GeneratedCase<T>) => void,
): void {
  for (const generatedCase of cases) {
    try {
      assertion(generatedCase.value, generatedCase);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Generated case failed (seed=${JSON.stringify(generatedCase.seed)}, index=${generatedCase.index}): ${detail}`,
        { cause },
      );
    }
  }
}
