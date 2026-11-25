// Client CSV helpers (src/csv.js: csvCell, toCsv, parseUserRows) and browser helpers (src/browser.js).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { csvCell, toCsv, parseCsv, parseUserRows } from '../src/csv.js';
import { toasts } from '../src/api.js';
import { copyText, downloadText } from '../src/browser.js';

describe('csvCell', () => {
  it('writes plain values as they are', () => {
    expect(csvCell('Website')).toBe('Website');
    expect(csvCell(7.5)).toBe('7.5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(false)).toBe('false');
  });
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"');
    expect(csvCell('one\rtwo')).toBe('"one\rtwo"');
  });
  it('neutralises spreadsheet formulas in text, not in numbers', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('+1 555 0100')).toBe("'+1 555 0100");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('@mention')).toBe("'@mention");
    expect(csvCell('\t=1+1')).toBe("'\t=1+1");
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell('a=b')).toBe('a=b');
  });
});

describe('toCsv', () => {
  it('joins rows, and what it writes parses back', () => {
    const rows = [
      ['email', 'name', 'invite_link'],
      ['a@example.com', 'Smith, Ann "AJ"', 'https://x/invite/1'],
      ['b@example.com', '=cmd', ''],
    ];
    const text = toCsv(rows);
    expect(text.split('\n')[0]).toBe('email,name,invite_link');
    expect(text.split('\n')[2]).toBe("b@example.com,'=cmd,");
    expect(parseCsv(text)[1]).toEqual(['a@example.com', 'Smith, Ann "AJ"', 'https://x/invite/1']);
  });
});

describe('parseUserRows', () => {
  it('reads columns by header name, in any order', () => {
    expect(parseUserRows('Name,E-mail,Role,Title\nAnn Lee, ann@example.com ,Admin,CTO\nBob,bob@example.com,,')).toEqual([
      { email: 'ann@example.com', name: 'Ann Lee', role: 'admin', title: 'CTO' },
      { email: 'bob@example.com', name: 'Bob', role: 'member', title: '' },
    ]);
  });
  it('without a header: email, name, role, title', () => {
    expect(parseUserRows('ann@example.com,Ann Lee,viewer\n\nbob@example.com')).toEqual([
      { email: 'ann@example.com', name: 'Ann Lee', role: 'viewer', title: '' },
      { email: 'bob@example.com', name: '', role: 'member', title: '' },
    ]);
  });
  it('takes tabs or semicolons, and quoted names with commas', () => {
    expect(parseUserRows('email\tname\nann@example.com\tAnn')[0]).toEqual({
      email: 'ann@example.com',
      name: 'Ann',
      role: 'member',
      title: '',
    });
    expect(parseUserRows('email;name\nann@example.com;Ann')[0].name).toBe('Ann');
    expect(parseUserRows('email,name\nann@example.com,"Lee, Ann"')[0].name).toBe('Lee, Ann');
    expect(parseUserRows('')).toEqual([]);
  });
});

describe('browser helpers', () => {
  beforeEach(() => {
    toasts.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('copyText copies and says so', async () => {
    const written = [];
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async (t) => {
          written.push(t);
        },
      },
    });
    expect(await copyText('abc', { ok: 'Link copied' })).toBe(true);
    expect(written).toEqual(['abc']);
    expect(toasts.map((t) => [t.message, t.kind])).toEqual([['Link copied', 'ok']]);
  });
  it('copyText reports a blocked clipboard instead of throwing', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('NotAllowedError');
        },
      },
    });
    expect(await copyText('abc')).toBe(false);
    expect(toasts.map((t) => t.kind)).toEqual(['error']);
    vi.stubGlobal('navigator', {}); // no clipboard at all (not a secure page)
    expect(await copyText('abc', { fail: 'Copy it by hand' })).toBe(false);
    expect(toasts.at(-1).message).toBe('Copy it by hand');
  });
  it('downloadText clicks a link to a blob with the file name and type', async () => {
    const a = {
      click() {
        this.clicked = true;
      },
    };
    let blob = null;
    const revoked = [];
    vi.stubGlobal('document', { createElement: () => a });
    vi.stubGlobal('URL', {
      createObjectURL: (b) => {
        blob = b;
        return 'blob:1';
      },
      revokeObjectURL: (u) => revoked.push(u),
    });
    downloadText('week.csv', 'a,b\n1,2', 'text/csv');
    expect(a).toMatchObject({ href: 'blob:1', download: 'week.csv', clicked: true });
    expect(blob.type).toBe('text/csv');
    expect(await blob.text()).toBe('a,b\n1,2');
    expect(revoked).toEqual(['blob:1']);
  });
});
