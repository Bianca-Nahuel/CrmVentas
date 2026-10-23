import { Controller, Get } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { tenants, users } from '../db/schema/auth.js';
import { currentTenantContext, currentTx } from '../db/tenant-context.js';

@Controller('me')
export class MeController {
  // Endpoint de prueba: muestra el contexto tal como lo ve Postgres dentro de la transacción del request.
  @Get('context')
  async context() {
    const { userId, tenantId, role } = currentTenantContext();
    const tx = currentTx();

    const [user] = await tx
      .select({ id: users.id, name: users.name, email: users.email, image: users.image })
      .from(users)
      .where(eq(users.id, userId));
    const [tenant] = await tx
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        industry: tenants.industry,
        timezone: tenants.timezone,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const { rows } = await tx.execute<{ db_user: string; app_tenant_id: string; app_user_id: string }>(
      sql`SELECT current_user AS db_user,
                 current_setting('app.tenant_id', true) AS app_tenant_id,
                 current_setting('app.user_id', true) AS app_user_id`,
    );
    const db = rows[0];

    return {
      user,
      tenant,
      role,
      db: { currentUser: db?.db_user, appTenantId: db?.app_tenant_id, appUserId: db?.app_user_id },
    };
  }
}
