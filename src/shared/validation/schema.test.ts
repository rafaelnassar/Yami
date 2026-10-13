import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { v } from './schema.ts';

describe('validation schema', () => {
  it('parses strict objects and rejects unknown keys', () => {
    const schema = v.object({ name: v.string({ min: 1 }), age: v.optional(v.number({ int: true })) });
    assert.deepEqual(schema.parse({ name: 'a' }), { ok: true, value: { name: 'a' } });
    const bad = schema.parse({ name: 'a', extra: 1 });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error.path, 'extra');
  });

  it('rejects control characters by default', () => {
    assert.equal(v.string().parse('a\u0000b').ok, false);
    assert.equal(v.string({ noControlChars: false }).parse('a\nb').ok, true);
  });

  it('validates http urls only', () => {
    assert.equal(v.httpUrl().parse(' https://example.com/x ').ok, true);
    assert.equal(v.httpUrl().parse('file:///etc/passwd').ok, false);
    assert.equal(v.httpUrl().parse('javascript:alert(1)').ok, false);
    assert.equal(v.httpUrl().parse('not a url').ok, false);
  });

  it('reports nested array paths', () => {
    const schema = v.object({ urls: v.array(v.httpUrl(), { max: 2 }) });
    const res = schema.parse({ urls: ['https://a.b', 'ftp://x'] });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.path, 'urls.1');
    assert.equal(schema.parse({ urls: ['https://a.b', 'https://a.b', 'https://a.b'] }).ok, false);
  });

  it('accepts only plain objects (no prototypes, no arrays)', () => {
    const schema = v.object({});
    assert.equal(schema.parse([]).ok, false);
    assert.equal(schema.parse(new Date()).ok, false);
    assert.equal(schema.parse(Object.create(null)).ok, true);
  });

  it('empty() accepts undefined and {} only', () => {
    assert.equal(v.empty().parse(undefined).ok, true);
    assert.equal(v.empty().parse({}).ok, true);
    assert.equal(v.empty().parse({ a: 1 }).ok, false);
  });
});
