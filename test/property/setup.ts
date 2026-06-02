import * as fc from "fast-check";

// tests-ci-06: pin a deterministic seed so a property failure is reproducible
// from CI logs (fast-check otherwise picks a random seed each run). Override with
// FAST_CHECK_SEED=<n> to reproduce a specific failing run locally.
const SEED_ENV = Number.parseInt(process.env.FAST_CHECK_SEED ?? "", 10);
const PROPERTY_SEED = Number.isFinite(SEED_ENV) ? SEED_ENV : 0x5eed;

fc.configureGlobal({
  seed: PROPERTY_SEED,
  numRuns: 100,
  verbose: false,
  endOnFailure: true,
  skipAllAfterTimeLimit: 10000,
});

export { fc, PROPERTY_SEED };

export function seedFromTestName(testName: string): number {
  let hash = 0;
  for (let i = 0; i < testName.length; i++) {
    const char = testName.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}
