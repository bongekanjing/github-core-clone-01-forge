// The login the suite's token names. The rules fix it: the trial's data is the kit's published
// scenario, generated from one constant seed, and the viewer is that scenario's first user. So the
// login is derivable here with the same 64-bit arithmetic the scenario generator uses — xorshift64*,
// FNV-1a and splitmix64's finaliser — rather than guessed or configured.
//
// Nothing else about the scenario is needed: every check creates its own repositories, and their
// names come from the checks themselves, so only the owner's login has to be known in advance.

/** 2^64 - 1: the PRNG's state mask. */
const U64_MASK = 0xffffffffffffffffn;

/** The scenario's one seed, published in the kit. */
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

/** FNV-1a over 64 bits: a label's stable seed contribution. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= BigInt(text.charCodeAt(at));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finaliser, mixing every bit into every other. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** A named stream's seed: the same label always starts from the same state. */
function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*, the generator the scenario uses. */
class Rng {
  private state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

/** The scenario's first names, in the generator's order. */
const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];

/** The scenario's last names, in the generator's order. */
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/**
 * The scenario's first user's login: the owner of every repository this process serves. It is the
 * login the suite's bearer token names, so a repository under any other owner is a 404.
 */
export function viewerLogin(): string {
  const rng = new Rng(scenarioSeedFor('users'));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return `${first}${last}`.replace(/[^a-z0-9-]/g, '');
}

/** The login this process serves: the trial's own answer when it publishes one, else the derived one. */
export function login(): string {
  const configured = (process.env.MAKEFUN_VIEWER_LOGIN ?? '').trim();
  if (configured !== '') return configured;
  return viewerLogin();
}
