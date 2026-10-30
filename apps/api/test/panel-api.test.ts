// Tarea 023: lo que el panel necesita de la API. Control de origen en pedidos que cambian estado y
// GET /api/me/tenants (empresas que el usuario puede elegir).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createTenant,
  createUser,
  HttpClient,
  postWahaWebhook,
  startTestContext,
  TEST_PASSWORD,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
const ids = {} as Record<'owner' | 'multi' | 'tenantA' | 'tenantB' | 'tenantC', string>;
const emails = {} as Record<'owner' | 'multi', string>;

beforeAll(async () => {
  ctx = await startTestContext();
  const owner = await createUser(ctx, 'panel-owner');
  const multi = await createUser(ctx, 'panel-multi');
  Object.assign(ids, { owner: owner.id, multi: multi.id });
  Object.assign(emails, { owner: owner.email, multi: multi.email });
  ids.tenantA = await createTenant(ctx, 'panel-a', owner.id);
  ids.tenantB = await createTenant(ctx, 'panel-b', owner.id);
  ids.tenantC = await createTenant(ctx, 'panel-c', owner.id);
  await addMember(ctx, ids.tenantA, multi.id, 'seller');
  await addMember(ctx, ids.tenantB, multi.id, 'viewer');
  await addMember(ctx, ids.tenantC, multi.id, 'admin');
});

afterAll(async () => {
  await ctx?.close();
});

async function signInWithOrigin(origin: string | null) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (origin !== null) headers.Origin = origin;
  const response = await fetch(`${ctx.baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: emails.owner, password: TEST_PASSWORD }),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as unknown };
}

describe('control de origen', () => {
  it('origen confiable → pasa', async () => {
    for (const origin of ctx.env.TRUSTED_ORIGINS) {
      expect((await signInWithOrigin(origin)).status, origin).toBe(200);
    }
  });

  it('origen falso, parecido o ausente → 403 ORIGIN_NOT_ALLOWED', async () => {
    const trusted = ctx.env.TRUSTED_ORIGINS[0]!;
    const bad = [
      'https://malo.example',
      'null',
      `${trusted}.malo.example`,
      `${trusted}/ruta`,
      trusted.replace('http://', 'https://'),
      null,
    ];
    for (const origin of bad) {
      const res = await signInWithOrigin(origin);
      expect(res.status, String(origin)).toBe(403);
      expect(res.body, String(origin)).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
    }
  });

  it('también corta pedidos de la API propia (no solo /api/auth)', async () => {
    const response = await fetch(`${ctx.baseUrl}/api/me/context`, {
      method: 'POST',
      headers: { Origin: 'https://malo.example' },
    });
    expect(response.status).toBe(403);
  });

  it('los GET no exigen Origin', async () => {
    expect((await fetch(`${ctx.baseUrl}/api/health`)).status).toBe(200);
  });

  it('el webhook de WAHA sin Origin y con HMAC válido → pasa', async () => {
    // Un evento que no se procesa (presencia): alcanza para probar que el control de origen no lo frena.
    const presence = JSON.parse(
      readFileSync(new URL('./fixtures/whatsapp/waha/presence-update.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    const body = JSON.stringify({ ...presence, id: `evt_${ctx.prefix}_origen` });
    expect(await postWahaWebhook(ctx, body)).toBe(200);
    // Y sin firma sigue respondiendo el control de HMAC (401), no el de origen (403).
    expect(await postWahaWebhook(ctx, body, { hmac: null })).toBe(401);
  });
});

describe('GET /api/me/tenants', () => {
  it('sin sesión → 401', async () => {
    expect((await new HttpClient(ctx).get('/api/me/tenants')).status).toBe(401);
  });

  it('sin empresa activa devuelve sus empresas activas con el rol, ordenadas por nombre', async () => {
    const client = new HttpClient(ctx);
    await client.signIn(emails.multi);
    const res = await client.get('/api/me/tenants');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: ids.tenantA, name: 'Test panel-a', slug: `${ctx.prefix}-panel-a`, role: 'seller' },
      { id: ids.tenantB, name: 'Test panel-b', slug: `${ctx.prefix}-panel-b`, role: 'viewer' },
      { id: ids.tenantC, name: 'Test panel-c', slug: `${ctx.prefix}-panel-c`, role: 'admin' },
    ]);
  });

  it('no lista membresías desactivadas ni empresas suspendidas, ni empresas de otros', async () => {
    await ctx.ownerPool.query(
      "UPDATE memberships SET status = 'disabled' WHERE tenant_id = $1 AND user_id = $2",
      [ids.tenantA, ids.multi],
    );
    await ctx.ownerPool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [ids.tenantB]);
    try {
      const client = new HttpClient(ctx);
      await client.signIn(emails.multi);
      const res = await client.get('/api/me/tenants');
      expect(res.status).toBe(200);
      expect((res.body as unknown as { id: string }[]).map((t) => t.id)).toEqual([ids.tenantC]);
    } finally {
      await ctx.ownerPool.query(
        "UPDATE memberships SET status = 'active' WHERE tenant_id = $1 AND user_id = $2",
        [ids.tenantA, ids.multi],
      );
      await ctx.ownerPool.query("UPDATE tenants SET status = 'active' WHERE id = $1", [ids.tenantB]);
    }
  });
});
