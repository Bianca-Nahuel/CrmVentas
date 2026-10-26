import { Injectable } from '@nestjs/common';
import { tenantConfigSchema, type TenantConfig } from '@ventas/shared';
import { invalidSelectors } from '../../catalog/web/extract.js';
import { desc, sql } from 'drizzle-orm';
import { tenantConfigs } from '../../db/schema/ai.js';
import type { AppTx } from '../../db/tenant-context.js';
import { errorCode } from '../../jobs/error-code.js';

export type ConfigLookup =
  | { kind: 'ok'; version: number; config: TenantConfig }
  | { kind: 'missing' }
  /** La versión vigente no valida con el schema actual: la IA no corre hasta cargar una nueva. */
  | { kind: 'invalid'; version: number };

export class InvalidTenantConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Configuración inválida:\n${issues.join('\n')}`);
    this.name = 'InvalidTenantConfigError';
  }
}

// Unique violation (tenant_id, version): otro insert ganó la versión, se reintenta con la siguiente.
const VERSION_ATTEMPTS = 3;

// Configuración del agente de la empresa activa (app.tenant_id), versionada: nunca se edita una versión,
// se inserta la siguiente. Todo pasa por la RLS de ventas_app.
@Injectable()
export class TenantConfigService {
  async latest(tx: AppTx): Promise<ConfigLookup> {
    const [row] = await tx
      .select({ version: tenantConfigs.version, config: tenantConfigs.config })
      .from(tenantConfigs)
      .orderBy(desc(tenantConfigs.version))
      .limit(1);
    if (!row) return { kind: 'missing' };
    const parsed = tenantConfigSchema.safeParse(row.config);
    return parsed.success
      ? { kind: 'ok', version: row.version, config: parsed.data }
      : { kind: 'invalid', version: row.version };
  }

  /** Valida e inserta una versión nueva. Devuelve el número de versión. */
  async insertVersion(tx: AppTx, input: unknown, createdBy: string | null = null): Promise<number> {
    const parsed = tenantConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidTenantConfigError(
        parsed.error.issues.map((issue) => `- ${issue.path.join('.') || '(raíz)'}: ${issue.message}`),
      );
    }
    // La sintaxis CSS del extractor del catálogo la valida css-select (libs/shared no lo conoce).
    const badSelectors = invalidSelectors(parsed.data.catalog?.extractor);
    if (badSelectors.length > 0) {
      throw new InvalidTenantConfigError(
        badSelectors.map((field) => `- catalog.extractor.fields.${field}.selector: selector CSS inválido`),
      );
    }
    for (let attempt = 1; ; attempt++) {
      try {
        // Savepoint: un choque con otra versión no aborta la transacción del que llama.
        return await tx.transaction(async (savepoint) => {
          const result = await savepoint.execute<{ version: number }>(sql`
            INSERT INTO tenant_configs (tenant_id, version, config, created_by)
            SELECT app_tenant_id(), COALESCE(MAX(version), 0) + 1, ${JSON.stringify(parsed.data)}::jsonb, ${createdBy}
            FROM tenant_configs WHERE tenant_id = app_tenant_id()
            RETURNING version
          `);
          return result.rows[0]!.version;
        });
      } catch (error) {
        if (errorCode(error) !== '23505' || attempt >= VERSION_ATTEMPTS) throw error;
      }
    }
  }
}
