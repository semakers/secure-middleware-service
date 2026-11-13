/**
 * Working copy used for detection.
 *
 * `normalized` is the NFKC form of the input (the output of `sanitize` is built from it).
 * `text` is the same text prepared for detection:
 *   - format characters (`\p{Cf}`: zero-width space/joiner, BOM, bidi marks, soft hyphen, ...) removed,
 *   - combining marks (`\p{Mn}`/`\p{Me}`: includes the keycap U+20E3 and variation selectors) removed
 *     when they follow a digit,
 *   - non-ASCII decimal digits (`\p{Nd}`, e.g. Arabic-Indic) replaced by their ASCII value.
 * `map[i]` is the index in `normalized` of `text[i]` (`map[text.length] = normalized.length`);
 * `null` means "identical, no mapping needed" (the common case: plain printable ASCII).
 */
export interface WorkingCopy {
  readonly normalized: string;
  readonly text: string;
  readonly map: Int32Array | null;
}

// Printable ASCII + tab/newline/CR: NFKC is the identity and nothing is stripped.
const PLAIN_ASCII = /^[\t\n\r\x20-\x7e]*$/;
const FORMAT_CHAR = /^\p{Cf}$/u;
const MARK_CHAR = /^[\p{Mn}\p{Me}]$/u;
const DECIMAL_DIGIT = /^\p{Nd}$/u;

/** Value 0-9 of a non-ASCII `\p{Nd}` code point (Nd blocks are contiguous runs of 10). */
function digitValue(cp: number): number {
  let base = cp;
  while (base > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(base - 1))) base--;
  return (cp - base) % 10;
}

export function buildWorkingCopy(input: string): WorkingCopy {
  if (PLAIN_ASCII.test(input)) return { normalized: input, text: input, map: null };

  const normalized = input.normalize('NFKC');
  const units = new Uint16Array(normalized.length);
  const map = new Int32Array(normalized.length + 1);
  let w = 0;
  let prevDigit = false;
  let identity = true;
  for (let i = 0; i < normalized.length; ) {
    const cp = normalized.codePointAt(i) as number;
    const len = cp > 0xffff ? 2 : 1;
    let skip = false;
    let out = cp;
    if (cp >= 0x80) {
      const ch = normalized.slice(i, i + len);
      if (FORMAT_CHAR.test(ch)) skip = true;
      else if (prevDigit && MARK_CHAR.test(ch)) skip = true;
      else if (DECIMAL_DIGIT.test(ch)) {
        out = 48 + digitValue(cp);
        if (len === 2) identity = false;
      }
    }
    if (skip) {
      identity = false;
    } else {
      prevDigit = out >= 48 && out <= 57;
      if (out === cp && len === 2) {
        units[w] = normalized.charCodeAt(i);
        map[w++] = i;
        units[w] = normalized.charCodeAt(i + 1);
        map[w++] = i + 1;
      } else {
        units[w] = out;
        map[w++] = i;
      }
    }
    i += len;
  }
  map[w] = normalized.length;
  if (identity && w === normalized.length) {
    // Only digit substitutions happened (or nothing): positions are unchanged.
    return { normalized, text: decode(units, w), map: null };
  }
  return { normalized, text: decode(units, w), map };
}

function decode(units: Uint16Array, length: number): string {
  // Not TextDecoder: lone surrogates must survive untouched.
  const CHUNK = 8192;
  let s = '';
  for (let i = 0; i < length; i += CHUNK) {
    s += String.fromCharCode(...units.subarray(i, Math.min(length, i + CHUNK)));
  }
  return s;
}

/**
 * Translates `[start, end)` of `text` to a range of `normalized`. For number spans the end is
 * extended over combining marks that followed the last digit (they were stripped from `text`),
 * so nothing dangles after the redaction token. Other stripped characters (e.g. a bidi pop
 * U+202C after the number) are deliberately left in place.
 */
export function toNormalizedRange(
  wc: WorkingCopy,
  start: number,
  end: number,
  extendOverMarks: boolean,
): [number, number] {
  const map = wc.map;
  if (map === null) return [start, end];
  const ns = map[start] as number;
  const last = map[end - 1] as number;
  let ne = last + ((wc.normalized.codePointAt(last) as number) > 0xffff ? 2 : 1);
  if (extendOverMarks) {
    while (ne < wc.normalized.length) {
      const cp = wc.normalized.codePointAt(ne) as number;
      const len = cp > 0xffff ? 2 : 1;
      if (!MARK_CHAR.test(wc.normalized.slice(ne, ne + len))) break;
      ne += len;
    }
  }
  return [ns, ne];
}
