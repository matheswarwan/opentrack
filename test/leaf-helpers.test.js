// Leaf helpers shared by the server: CSV cells (lib/csv.js), stored JSON (lib/json.js), background work (lib/http.js).
import { describe, it, expect, vi } from 'vitest';
import { csvCell, csvLine } from '../server/lib/csv.js';
import { parseJson, parseList, parseObject } from '../server/lib/json.js';
import { defer, publicOrigin } from '../server/lib/http.js';

describe('csvCell', () => {
  it('writes plain values as they are and empty for null and undefined', () => {
    expect(csvCell('Website')).toBe('Website');
    expect(csvCell(7.5)).toBe('7.5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(false)).toBe('false');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"');
    expect(csvCell('one\rtwo')).toBe('"one\rtwo"');
  });

  it('puts an apostrophe before a value a spreadsheet would run as a formula', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('=HYPERLINK("x","y")')).toBe('"\'=HYPERLINK(""x"",""y"")"');
    expect(csvCell(-5)).toBe('-5'); // a number cannot hold a formula; an apostrophe would turn it into text in a spreadsheet
    expect(csvCell('-5')).toBe("'-5"); // text that looks like one still gets it
  });

  it('csvLine joins cells with commas', () => {
    expect(csvLine(['a', null, 'b,c', 3])).toBe('a,,"b,c",3');
  });
});

describe('stored JSON', () => {
  it('parseJson returns the value, or the fallback for empty, unreadable and null', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('[1,2]', [])).toEqual([1, 2]);
    expect(parseJson('0', 5)).toBe(0);
    expect(parseJson('false', true)).toBe(false);
    expect(parseJson('', 'x')).toBe('x');
    expect(parseJson(null, 'x')).toBe('x');
    expect(parseJson(undefined, 'x')).toBe('x');
    expect(parseJson('{bad', 'x')).toBe('x');
    expect(parseJson('null', 'x')).toBe('x');
    expect(parseJson('{bad')).toBe(null);
  });

  it('parseList returns arrays only', () => {
    expect(parseList('["a"]')).toEqual(['a']);
    expect(parseList('{"a":1}')).toEqual([]);
    expect(parseList('')).toEqual([]);
    expect(parseList(null)).toEqual([]);
    expect(parseList('nope')).toEqual([]);
  });

  it('parseObject returns plain objects only', () => {
    expect(parseObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseObject('[1]')).toEqual({});
    expect(parseObject('"text"')).toEqual({});
    expect(parseObject(null)).toEqual({});
    expect(parseObject('nope')).toEqual({});
  });
});

describe('defer and publicOrigin', () => {
  it('defer collects the promise in the queue and hands it to waitUntil', async () => {
    const queue = [];
    const waited = [];
    const c = { env: {}, executionCtx: { waitUntil: (p) => waited.push(p) } };
    defer(c, Promise.resolve(1), { queue });
    expect(queue).toHaveLength(1);
    expect(waited).toEqual(queue);
    await Promise.all(queue);
  });

  it('defer logs a failure with its label instead of rejecting, and works without an execution context', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queue = [];
    const c = {
      env: {},
      get executionCtx() {
        throw new Error('no context');
      },
    };
    defer(c, Promise.reject(new Error('boom')), { label: 'test work failed', queue });
    await Promise.all(queue);
    expect(log).toHaveBeenCalledWith('test work failed', expect.any(Error));
    log.mockRestore();
  });

  it('publicOrigin prefers PUBLIC_URL and drops a trailing slash', () => {
    expect(publicOrigin({ env: { PUBLIC_URL: 'https://t.example/' }, req: { url: 'http://localhost/x' } })).toBe('https://t.example');
    expect(publicOrigin({ env: {}, req: { url: 'http://localhost:8787/api/x?y=1' } })).toBe('http://localhost:8787');
  });
});
