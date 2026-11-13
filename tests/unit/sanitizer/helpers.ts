/** Luhn check digit generator for tests: returns `body` + the digit that makes it valid. */
export function withLuhn(body: string): string {
  let sum = 0;
  let double = true;
  for (let i = body.length - 1; i >= 0; i--) {
    let d = body.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return body + String((10 - (sum % 10)) % 10);
}

export function luhnOk(digits: string): boolean {
  return withLuhn(digits.slice(0, -1)) === digits;
}

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomDigits(rand: () => number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String(Math.floor(rand() * 10));
  return s;
}

/** Splits a digit string into groups of the given sizes (the last group takes the rest). */
export function group(digits: string, sizes: number[], sep: string): string {
  const out: string[] = [];
  let p = 0;
  for (const size of sizes) {
    if (p >= digits.length) break;
    out.push(digits.slice(p, p + size));
    p += size;
  }
  if (p < digits.length) out.push(digits.slice(p));
  return out.join(sep);
}
