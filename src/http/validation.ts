import { z } from 'zod';
import type { ValidationDetail, ValidationField } from '../errors.js';
import { containsPii } from '../sanitizer/index.js';

export const USER_ID_MAX = 64;
export const MESSAGE_MAX_CODE_POINTS = 5000;
const USER_ID_FORMAT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface InquiryInput {
  userId: string;
  message: string;
}

const FIELDS: ReadonlySet<string> = new Set(['userId', 'message', 'mode']);

function hasControlCharacter(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return true;
  }
  return false;
}

/** Issue ids for a userId value (empty = valid). */
export function userIdIssues(value: unknown): string[] {
  if (value === undefined) return ['required'];
  if (typeof value !== 'string') return ['invalid_type'];
  if (value.length === 0) return ['too_short'];
  const issues: string[] = [];
  if (value.length > USER_ID_MAX) issues.push('too_long');
  if (!USER_ID_FORMAT.test(value)) issues.push('invalid_format');
  if (issues.length === 0 && containsPii(value)) issues.push('contains_pii');
  return issues;
}

/** Issue ids for a message value (empty = valid). Length is counted in code points. */
export function messageIssues(value: unknown): string[] {
  if (value === undefined) return ['required'];
  if (typeof value !== 'string') return ['invalid_type'];
  const issues: string[] = [];
  if (!value.isWellFormed()) issues.push('invalid_unicode');
  if (hasControlCharacter(value)) issues.push('invalid_characters');
  if (value.length === 0) {
    issues.push('too_short');
  } else {
    // Each code point is at most 2 code units, so > 2*max units is certainly too long.
    const codePoints = value.length > MESSAGE_MAX_CODE_POINTS * 2 ? Infinity : [...value].length;
    if (codePoints > MESSAGE_MAX_CODE_POINTS) issues.push('too_long');
    if (value.trim() === '') issues.push('blank');
  }
  return issues;
}

/** A zod schema whose issues are the ids returned by `check` (never client-provided text). */
function checked(check: (value: unknown) => string[]) {
  return z.unknown().check((ctx) => {
    for (const issue of check(ctx.value)) {
      ctx.issues.push({ code: 'custom', message: issue, input: ctx.value });
    }
  });
}

const rootError = (iss: { input?: unknown }): string => (iss.input === undefined ? 'required' : 'not_an_object');

export const inquirySchema = z.strictObject(
  { userId: checked(userIdIssues), message: checked(messageIssues) },
  { error: rootError },
);

export const DEMO_MODES = ['healthy', 'fail', 'hang'] as const;
export interface DemoModeInput {
  mode: (typeof DEMO_MODES)[number];
}
export const demoModeSchema = z.strictObject(
  {
    mode: z.unknown().check((ctx) => {
      const v = ctx.value;
      const issue = v === undefined ? 'required' : typeof v !== 'string' ? 'invalid_type' : DEMO_MODES.includes(v as never) ? null : 'invalid_value';
      if (issue !== null) ctx.issues.push({ code: 'custom', message: issue, input: v });
    }),
  },
  { error: rootError },
);

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; details: ValidationDetail[] };

function toDetails(error: z.ZodError): ValidationDetail[] {
  const seen = new Set<string>();
  const details: ValidationDetail[] = [];
  for (const issue of error.issues) {
    const first = issue.path[0];
    const field: ValidationField = typeof first === 'string' && FIELDS.has(first) ? (first as ValidationField) : '(root)';
    // Only our own ids are ever exposed; zod's own messages (which may quote keys) never are.
    const id = issue.code === 'unrecognized_keys' ? 'unrecognized_keys' : issue.message;
    const key = `${field}:${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      details.push({ field, issue: id });
    }
  }
  return details;
}

function run<T>(schema: z.ZodType<T>, body: unknown): ValidationResult<T> {
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, details: toDetails(parsed.error) };
}

export function validateInquiry(body: unknown): ValidationResult<InquiryInput> {
  return run(inquirySchema as unknown as z.ZodType<InquiryInput>, body);
}

export function validateDemoMode(body: unknown): ValidationResult<DemoModeInput> {
  return run(demoModeSchema as unknown as z.ZodType<DemoModeInput>, body);
}
