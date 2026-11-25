// Workspace fonts: font stacks in the settings, uploaded font files served publicly,
// admin only, validation, backups.
import { describe, it, expect, beforeEach } from 'vitest';
import { withAdmin, addUser, client } from './helpers.js';
import { fontFormat } from '../server/routes/fonts.js';
import { TABLES } from '../server/lib/backup.js';

const CUSTOM = '"Acme Sans", "acme-sans", Helvetica, Arial, sans-serif';
// A fake WOFF2: the magic number plus padding (the server checks the signature, not the tables).
const woff2 = (n = 64) => `data:font/woff2;base64,${Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(n)]).toString('base64')}`;
let ctx, bob;

beforeEach(async () => {
  ctx = await withAdmin();
  bob = await addUser(ctx, { email: 'bob@example.com', name: 'Bob' });
});

describe('workspace fonts', () => {
  it('recognises font files by their first bytes', () => {
    expect(fontFormat(Buffer.from('wOF2xxxx'))).toBe('woff2');
    expect(fontFormat(Buffer.from('wOFFxxxx'))).toBe('woff');
    expect(fontFormat(Buffer.from('OTTOxxxx'))).toBe('otf');
    expect(fontFormat(Buffer.from([0, 1, 0, 0, 9]))).toBe('ttf');
    expect(fontFormat(Buffer.from('<svg>'))).toBe(null);
  });

  it('defaults to the brand fonts, saves stacks and lists them in the public config', async () => {
    const anon = client(ctx);
    expect((await anon.get('/api/auth/config')).body.fonts).toEqual({ heading: null, body: null, faces: [] });
    const r = await ctx.admin.patch('/api/admin/settings', { fontHeading: CUSTOM, fontBody: CUSTOM });
    expect(r.status).toBe(200);
    const cfg = (await anon.get('/api/auth/config')).body.fonts;
    expect(cfg.heading).toBe(CUSTOM);
    expect(cfg.body).toBe(CUSTOM);
  });

  it('refuses stacks that could break out of the CSS declaration', async () => {
    for (const bad of ['Arial; color: red', 'Arial}body{display:none', 'url(x)', '<b>']) {
      expect((await ctx.admin.patch('/api/admin/settings', { fontBody: bad })).status).toBe(400);
    }
  });

  it('uploads, replaces, serves publicly with a long cache, and removes font files (admins only)', async () => {
    expect((await bob.client.post('/api/admin/fonts', { family: 'Acme Sans', file: woff2() })).status).toBe(403);
    const up = await ctx.admin.post('/api/admin/fonts', { family: 'Acme Sans', weight: 900, style: 'normal', file: woff2() });
    expect(up.status).toBe(201);
    expect(up.body.faces).toHaveLength(1);
    const f = up.body.faces[0];
    expect(f).toMatchObject({ family: 'Acme Sans', weight: 900, style: 'normal', format: 'woff2', size: 68 });
    const file = await client(ctx).get(f.url);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('font/woff2');
    expect(file.headers.get('cache-control')).toContain('immutable');
    // same family, weight and style replaces
    const again = await ctx.admin.post('/api/admin/fonts', { family: 'Acme Sans', weight: 900, file: woff2(10) });
    expect(again.body.faces).toHaveLength(1);
    expect(again.body.faces[0].id).not.toBe(f.id);
    expect((await client(ctx).get(f.url)).status).toBe(404);
    expect((await client(ctx).get('/api/auth/config')).body.fonts.faces).toHaveLength(1);
    const gone = await ctx.admin.del(`/api/admin/fonts/${again.body.faces[0].id}`);
    expect(gone.body.faces).toEqual([]);
  });

  it('refuses files that are not fonts, too large, or badly named', async () => {
    expect(
      (
        await ctx.admin.post('/api/admin/fonts', {
          family: 'X',
          file: `data:font/woff2;base64,${Buffer.from('<svg onload=1>').toString('base64')}`,
        })
      ).status,
    ).toBe(400);
    expect((await ctx.admin.post('/api/admin/fonts', { family: 'X', file: woff2(800 * 1024) })).status).toBe(413);
    expect((await ctx.admin.post('/api/admin/fonts', { family: 'X"; }', file: woff2() })).status).toBe(400);
    expect((await ctx.admin.post('/api/admin/fonts', { family: 'X', weight: 450, file: woff2() })).status).toBe(400);
  });

  it('is in full backups', () => {
    expect(TABLES.some((t) => t.name === 'brand_fonts' && !t.project)).toBe(true);
  });
});
