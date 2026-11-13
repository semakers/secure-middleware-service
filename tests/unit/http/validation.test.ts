import { describe, expect, it } from 'vitest';
import { validateDemoMode, validateInquiry } from '../../../src/http/validation.js';

const ok = { userId: 'user_1', message: 'hello' };
function issues(body: unknown): { field: string; issue: string }[] {
  const r = validateInquiry(body);
  if (r.ok) throw new Error('expected failure');
  return r.details;
}

describe('validateInquiry', () => {
  it('accepts a valid body', () => {
    expect(validateInquiry(ok)).toEqual({ ok: true, value: ok });
    expect(validateInquiry({ userId: 'a', message: 'tab\tnewline\ncr\r ok 😀' }).ok).toBe(true);
    expect(validateInquiry({ userId: 'A'.repeat(64), message: 'x'.repeat(5000) }).ok).toBe(true);
    expect(validateInquiry({ userId: 'a', message: '😀'.repeat(5000) }).ok).toBe(true);
  });

  it.each([
    [{}, [['userId', 'required'], ['message', 'required']]],
    [{ userId: 5, message: ['x'] }, [['userId', 'invalid_type'], ['message', 'invalid_type']]],
    [{ userId: null, message: null }, [['userId', 'invalid_type'], ['message', 'invalid_type']]],
    [{ userId: '', message: '' }, [['userId', 'too_short'], ['message', 'too_short']]],
    [{ userId: 'a'.repeat(65), message: 'x' }, [['userId', 'too_long']]],
    [{ userId: '-abc', message: 'x' }, [['userId', 'invalid_format']]],
    [{ userId: 'a b', message: 'x' }, [['userId', 'invalid_format']]],
    [{ userId: 'jo@x.io', message: 'x' }, [['userId', 'invalid_format']]],
    [{ userId: 'a', message: 'x'.repeat(5001) }, [['message', 'too_long']]],
    [{ userId: 'a', message: '😀'.repeat(5001) }, [['message', 'too_long']]],
    [{ userId: 'a', message: ' \t\n ' }, [['message', 'blank']]],
    [{ userId: 'a', message: 'bad\u0000char' }, [['message', 'invalid_characters']]],
    [{ userId: 'a', message: 'bad\u007fchar' }, [['message', 'invalid_characters']]],
    [{ userId: 'a', message: 'bad\u001bchar' }, [['message', 'invalid_characters']]],
    [{ userId: 'a', message: 'lone\ud800surrogate' }, [['message', 'invalid_unicode']]],
    [{ userId: 'a', message: 'x', extra: 1 }, [['(root)', 'unrecognized_keys']]],
    [{ userId: 'a', message: 'x', 'jo@example.com': 1 }, [['(root)', 'unrecognized_keys']]],
    [[], [['(root)', 'not_an_object']]],
    ['text', [['(root)', 'not_an_object']]],
    [null, [['(root)', 'not_an_object']]],
    [undefined, [['(root)', 'required']]],
  ])('maps %j to the right issues', (body, expected) => {
    expect(issues(body).map((d) => [d.field, d.issue])).toEqual(expected);
  });

  it('rejects a userId that is a Luhn-valid card or an SSN', () => {
    expect(issues({ userId: '4111111111111111', message: 'x' })).toEqual([{ field: 'userId', issue: 'contains_pii' }]);
    expect(issues({ userId: '123456789', message: 'x' })).toEqual([{ field: 'userId', issue: 'contains_pii' }]);
  });

  it('never echoes a client-supplied key name or value', () => {
    const body = { userId: 'a', message: 'x', 'secret@example.com': '4111111111111111' };
    expect(JSON.stringify(issues(body))).not.toContain('secret');
  });
});

describe('validateDemoMode', () => {
  it('accepts the three modes', () => {
    for (const mode of ['healthy', 'fail', 'hang']) expect(validateDemoMode({ mode })).toEqual({ ok: true, value: { mode } });
  });
  it.each([
    [{}, [['mode', 'required']]],
    [{ mode: 1 }, [['mode', 'invalid_type']]],
    [{ mode: 'boom' }, [['mode', 'invalid_value']]],
    [{ mode: 'fail', x: 1 }, [['(root)', 'unrecognized_keys']]],
    [[], [['(root)', 'not_an_object']]],
  ])('maps %j', (body, expected) => {
    const r = validateDemoMode(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.details.map((d) => [d.field, d.issue])).toEqual(expected);
  });
});
