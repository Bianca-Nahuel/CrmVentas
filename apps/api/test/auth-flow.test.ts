// Verificación 4, 5 y 6 de la tarea 002 + bloqueos de organización (membresía desactivada,
// creación de empresas, suplantación).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createTenant,
  createUser,
  HttpClient,
  startTestContext,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
const ids = {} as Record<
  'ownerA' | 'ownerB' | 'multi' | 'adminA' | 'sellerA' | 'tenantA' | 'tenantB',
  string
>;
const emails = {} as Record<'ownerA' | 'multi' | 'adminA', string>;

beforeAll(async () => {
  ctx = await startTestContext();
  const ownerA = await createUser(ctx, 'owner-a');
  const ownerB = await createUser(ctx, 'owner-b');
  const multi = await createUser(ctx, 'multi');
  const adminA = await createUser(ctx, 'admin-a');
  const sellerA = await createUser(ctx, 'seller-a');
  Object.assign(ids, {
    ownerA: ownerA.id,
    ownerB: ownerB.id,
    multi: multi.id,
    adminA: adminA.id,
    sellerA: sellerA.id,
  });
  Object.assign(emails, { ownerA: ownerA.email, multi: multi.email, adminA: adminA.email });

  ids.tenantA = await createTenant(ctx, 'a', ownerA.id);
  ids.tenantB = await createTenant(ctx, 'b', ownerB.id);
  await addMember(ctx, ids.tenantA, multi.id, 'seller');
  await addMember(ctx, ids.tenantB, multi.id, 'viewer');
  await addMember(ctx, ids.tenantA, adminA.id, 'admin');
  await addMember(ctx, ids.tenantA, sellerA.id, 'seller');
});

afterAll(async () => {
  await ctx?.close();
});

describe('health', () => {
  it('GET /api/health responde 200 sin autenticación', async () => {
    const client = new HttpClient(ctx);
    const res = await client.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'ok' });
  });
});

describe('sesión y contexto de empresa', () => {
  it('sin cookie → 401', async () => {
    const res = await new HttpClient(ctx).get('/api/me/context');
    expect(res.status).toBe(401);
  });

  it('registro por API setea una cookie HttpOnly y SameSite=Lax', async () => {
    const client = new HttpClient(ctx);
    const res = await client.post('/api/auth/sign-up/email', {
      email: `${ctx.prefix}-signup@example.test`,
      password: 'test-only-Password-123',
      name: 'signup',
    });
    expect(res.status).toBe(200);
    const sessionCookie = client.lastSetCookie.find((c) => c.includes('session_token='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).toMatch(/Path=\//i);
  });

  it('login del owner → sin empresa activa 403; con empresa activa devuelve el contexto real de la base', async () => {
    const client = new HttpClient(ctx);
    const login = await client.signIn(emails.ownerA);
    expect(login.status).toBe(200);
    expect(client.lastSetCookie.find((c) => c.includes('session_token='))).toMatch(/HttpOnly/i);

    const noTenant = await client.get('/api/me/context');
    expect(noTenant.status).toBe(403);
    expect(noTenant.body?.code).toBe('NO_ACTIVE_TENANT');

    expect(
      (await client.post('/api/auth/organization/set-active', { organizationId: ids.tenantA })).status,
    ).toBe(200);
    const res = await client.get('/api/me/context');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user: { id: ids.ownerA, email: emails.ownerA },
      tenant: { id: ids.tenantA },
      role: 'owner',
      db: { currentUser: 'ventas_app', appTenantId: ids.tenantA, appUserId: ids.ownerA },
    });
  });

  it('logout → el siguiente request con la misma cookie responde 401', async () => {
    const client = new HttpClient(ctx);
    await client.signIn(emails.ownerA);
    await client.post('/api/auth/organization/set-active', { organizationId: ids.tenantA });
    const oldCookie = client.cookieHeader();
    expect((await client.get('/api/me/context')).status).toBe(200);

    expect((await client.post('/api/auth/sign-out')).status).toBe(200);
    const res = await client.request('GET', '/api/me/context', undefined, oldCookie);
    expect(res.status).toBe(401);
  });

  it('usuario en dos empresas: cambiar la empresa activa cambia el contexto', async () => {
    const client = new HttpClient(ctx);
    await client.signIn(emails.multi);

    await client.post('/api/auth/organization/set-active', { organizationId: ids.tenantA });
    const inA = await client.get('/api/me/context');
    expect(inA.body).toMatchObject({
      tenant: { id: ids.tenantA },
      role: 'seller',
      db: { appTenantId: ids.tenantA },
    });

    await client.post('/api/auth/organization/set-active', { organizationId: ids.tenantB });
    const inB = await client.get('/api/me/context');
    expect(inB.body).toMatchObject({
      tenant: { id: ids.tenantB },
      role: 'viewer',
      db: { appTenantId: ids.tenantB },
    });
  });

  it('membresía desactivada → 403 en el siguiente request con empresa', async () => {
    const client = new HttpClient(ctx);
    await client.signIn(emails.multi);
    await client.post('/api/auth/organization/set-active', { organizationId: ids.tenantA });
    expect((await client.get('/api/me/context')).status).toBe(200);

    await ctx.ownerPool.query(
      "UPDATE memberships SET status = 'disabled' WHERE tenant_id = $1 AND user_id = $2",
      [ids.tenantA, ids.multi],
    );
    try {
      const res = await client.get('/api/me/context');
      expect(res.status).toBe(403);
      expect(res.body?.code).toBe('MEMBERSHIP_INACTIVE');
    } finally {
      await ctx.ownerPool.query(
        "UPDATE memberships SET status = 'active' WHERE tenant_id = $1 AND user_id = $2",
        [ids.tenantA, ids.multi],
      );
    }
  });
});

describe('empresa suspendida', () => {
  it('con la empresa activa suspendida → 403', async () => {
    const client = new HttpClient(ctx);
    await client.signIn(emails.multi);
    await client.post('/api/auth/organization/set-active', { organizationId: ids.tenantB });
    expect((await client.get('/api/me/context')).status).toBe(200);

    await ctx.ownerPool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [ids.tenantB]);
    try {
      const res = await client.get('/api/me/context');
      expect(res.status).toBe(403);
      expect(res.body?.code).toBe('TENANT_SUSPENDED');
    } finally {
      await ctx.ownerPool.query("UPDATE tenants SET status = 'active' WHERE id = $1", [ids.tenantB]);
    }
  });
});

describe('endpoints de organización de Better Auth', () => {
  it('un admin con la membresía desactivada no puede operar sobre la empresa', async () => {
    const client = new HttpClient(ctx);
    await client.signIn(emails.adminA);
    await client.post('/api/auth/organization/set-active', { organizationId: ids.tenantA });

    // Control: activo, sí puede invitar.
    const invite = await client.post('/api/auth/organization/invite-member', {
      email: `${ctx.prefix}-invitee-ok@example.test`,
      role: 'seller',
      organizationId: ids.tenantA,
    });
    expect(invite.status).toBe(200);

    await ctx.ownerPool.query(
      "UPDATE memberships SET status = 'disabled' WHERE tenant_id = $1 AND user_id = $2",
      [ids.tenantA, ids.adminA],
    );
    const { rows } = await ctx.ownerPool.query<{ id: string }>(
      'SELECT id FROM memberships WHERE tenant_id = $1 AND user_id = $2',
      [ids.tenantA, ids.sellerA],
    );
    const sellerMemberId = rows[0]!.id;

    const blocked = [
      [
        'invite-member',
        { email: `${ctx.prefix}-invitee@example.test`, role: 'seller', organizationId: ids.tenantA },
      ],
      ['update-member-role', { memberId: sellerMemberId, role: 'viewer', organizationId: ids.tenantA }],
      ['remove-member', { memberIdOrEmail: sellerMemberId, organizationId: ids.tenantA }],
      ['update', { data: { name: 'Hackeada' }, organizationId: ids.tenantA }],
      ['set-active', { organizationId: ids.tenantA }],
      // Sin organizationId explícito: usa la empresa activa de la sesión.
      ['invite-member', { email: `${ctx.prefix}-invitee2@example.test`, role: 'seller' }],
    ] as const;
    for (const [path, body] of blocked) {
      const res = await client.post(`/api/auth/organization/${path}`, body);
      expect(res.status, path).toBe(403);
      expect(res.body?.code, path).toBe('MEMBERSHIP_DISABLED');
    }

    // Cancelar una invitación que conocía, después de sacar la empresa activa: la empresa sale de la
    // invitación, no del body ni de la sesión.
    const invitationId = invite.body?.id as string;
    expect((await client.post('/api/auth/organization/set-active', { organizationId: null })).status).toBe(
      200,
    );
    const cancel = await client.post('/api/auth/organization/cancel-invitation', { invitationId });
    expect(cancel.status).toBe(403);
    expect(cancel.body?.code).toBe('MEMBERSHIP_DISABLED');
    const invitation = await ctx.ownerPool.query('SELECT status FROM invitations WHERE id = $1', [
      invitationId,
    ]);
    expect(invitation.rows[0]).toEqual({ status: 'pending' });

    // Listar sus empresas sigue funcionando.
    expect((await client.get('/api/auth/organization/list')).status).toBe(200);

    // Nada cambió en la base.
    const after = await ctx.ownerPool.query<{ role: string; name: string }>(
      'SELECT m.role, t.name FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.id = $1',
      [sellerMemberId],
    );
    expect(after.rows[0]).toEqual({ role: 'seller', name: 'Test a' });
  });

  it('una membresía desactivada no se puede leer por slug ni mezclando id y slug', async () => {
    // multi: activo en A, desactivado en B. Con la empresa activa = A.
    const client = new HttpClient(ctx);
    await client.signIn(emails.multi);
    await client.post('/api/auth/organization/set-active', { organizationId: ids.tenantA });
    const slugB = `${ctx.prefix}-b`;
    await ctx.ownerPool.query(
      "UPDATE memberships SET status = 'disabled' WHERE tenant_id = $1 AND user_id = $2",
      [ids.tenantB, ids.multi],
    );
    try {
      // Control: sobre la empresa activa (A) sigue funcionando.
      expect(
        (await client.get(`/api/auth/organization/list-members?organizationId=${ids.tenantA}`)).status,
      ).toBe(200);

      const blocked = [
        `list-members?organizationSlug=${slugB}`,
        `list-members?organizationId=${ids.tenantA}&organizationSlug=${slugB}`,
        `get-full-organization?organizationSlug=${slugB}`,
        `get-full-organization?organizationId=${slugB}`,
        `get-full-organization?organizationId=${ids.tenantA}&organizationSlug=${slugB}`,
        `get-active-member-role?organizationSlug=${slugB}`,
        `get-active-member-role?organizationId=${ids.tenantB}`,
      ];
      for (const path of blocked) {
        const res = await client.get(`/api/auth/organization/${path}`);
        expect(res.status, path).toBe(403);
        expect(res.body?.code, path).toBe('MEMBERSHIP_DISABLED');
      }
      const permission = await client.post('/api/auth/organization/has-permission', {
        organizationId: ids.tenantB,
        permissions: { metrics: ['read'] },
      });
      expect(permission.status).toBe(403);
      expect(permission.body?.code).toBe('MEMBERSHIP_DISABLED');
    } finally {
      await ctx.ownerPool.query(
        "UPDATE memberships SET status = 'active' WHERE tenant_id = $1 AND user_id = $2",
        [ids.tenantB, ids.multi],
      );
    }
  });

  it('un usuario común no puede crear empresas', async () => {
    const client = new HttpClient(ctx);
    await client.signIn(emails.ownerA);
    const res = await client.post('/api/auth/organization/create', {
      name: 'Nueva',
      slug: `${ctx.prefix}-nueva`,
      industry: 'test',
      timezone: 'UTC',
    });
    expect(res.status).toBe(403);
    const { rowCount } = await ctx.ownerPool.query('SELECT 1 FROM tenants WHERE slug = $1', [
      `${ctx.prefix}-nueva`,
    ]);
    expect(rowCount).toBe(0);
  });

  it('la suplantación de usuarios está desactivada', async () => {
    const client = new HttpClient(ctx);
    await client.signIn(emails.ownerA);
    const res = await client.post('/api/auth/admin/impersonate-user', { userId: ids.ownerB });
    expect(res.status).toBe(404);
  });
});
