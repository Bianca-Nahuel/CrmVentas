// Panel de configuración del agente (tarea 027): ver la vigente, guardar versiones (nunca se edita una),
// historial, restaurar y la lista de modelos con su precio. Valida con TenantConfigService.validate (el mismo
// tenantConfigSchema de libs/shared que el worker). Lo sensible lo decide acá: solo el owner activa la
// revisión de calidad, con la confirmación de transparencia, y la confirmación la escribe el servidor.
// Logs: solo ids y versiones, nunca el contenido de la config.
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ALLOWED_MODELS, reviewConfigSchema, tenantConfigSchema, type TenantConfig } from '@ventas/shared';
import { sql } from 'drizzle-orm';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import type { AppTx, TenantContext } from '../../db/tenant-context.js';
import { addUsd, tokensCostUsd } from '../llm/money.js';
import type { RestoreBody, SaveAgentConfigBody } from './agent-config.contracts.js';
import {
  ConfigVersionConflictError,
  InvalidTenantConfigError,
  TenantConfigService,
} from './tenant-config.service.js';

// Estimación fija del precio por conversación cuando la empresa no tiene historia con ese modelo: 8 turnos
// de ~6.000 tokens de entrada (capa fija, negocio e historial) y ~500 de salida.
const ESTIMATE_TURNS = 8;
const ESTIMATE_INPUT_TOKENS = 6_000;
const ESTIMATE_OUTPUT_TOKENS = 500;

type VersionRow = {
  version: number;
  config: Record<string, unknown>;
  created_at: Date | string;
  saved_by: string | null;
};

const iso = (value: Date | string) => new Date(value).toISOString();
const transparencyAckSchema = reviewConfigSchema.shape.transparency_ack;

@Injectable()
export class AgentConfigService {
  private readonly logger = new Logger('AgentConfig');

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly configs: TenantConfigService,
  ) {}

  private async latestRow(tx: AppTx): Promise<VersionRow | null> {
    const result = await tx.execute<VersionRow>(sql`
      SELECT v.version, v.config, v.created_at, u.name AS saved_by
      FROM tenant_configs v LEFT JOIN users u ON u.id = v.created_by
      ORDER BY v.version DESC LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  async current(tx: AppTx) {
    const row = await this.latestRow(tx);
    const tenant = await tx.execute<{ timezone: string }>(
      sql`SELECT timezone FROM tenants WHERE id = app_tenant_id()`,
    );
    return {
      version: row?.version ?? null,
      config: row?.config ?? null,
      valid: row ? tenantConfigSchema.safeParse(row.config).success : false,
      savedBy: row?.saved_by ? { name: row.saved_by } : null,
      savedAt: row ? iso(row.created_at) : null,
      timezone: tenant.rows[0]?.timezone ?? 'America/Argentina/Buenos_Aires',
    };
  }

  async save(tx: AppTx, context: TenantContext, body: SaveAgentConfigBody) {
    const config = this.validated(body.config);
    const previous = await this.latestRow(tx);
    this.applyReviewRules(context, config, previous?.config ?? null, body.confirmTransparency === true);
    try {
      const saved = await this.configs.insertNextVersion(tx, config, body.expectedVersion, context.userId);
      this.logger.log({ msg: 'agent-config-save', tenantId: context.tenantId, version: saved.version });
      return { version: saved.version, savedAt: iso(saved.createdAt) };
    } catch (error) {
      if (error instanceof ConfigVersionConflictError) {
        // Se relee: si el choque fue con otro guardado simultáneo, la vigente ya no es la que se leyó antes.
        const latest = await this.latestRow(tx).catch(() => null);
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          currentVersion: latest?.version ?? previous?.version ?? 0,
        });
      }
      throw error;
    }
  }

  /** Copia una versión como una nueva (con las mismas validaciones y reglas que guardar). */
  async restore(tx: AppTx, context: TenantContext, version: number, body: RestoreBody) {
    const found = await tx.execute<{ config: Record<string, unknown> }>(
      sql`SELECT config FROM tenant_configs WHERE version = ${version}`,
    );
    if (!found.rows[0]) throw new NotFoundException({ code: 'NOT_FOUND' });
    const saved = await this.save(tx, context, {
      config: found.rows[0].config,
      expectedVersion: body.expectedVersion,
      ...(body.confirmTransparency !== undefined ? { confirmTransparency: body.confirmTransparency } : {}),
    });
    this.logger.log({
      msg: 'agent-config-restore',
      tenantId: context.tenantId,
      from: version,
      to: saved.version,
    });
    return saved;
  }

  async versions(tx: AppTx) {
    const result = await tx.execute<VersionRow>(sql`
      SELECT v.version, v.config, v.created_at, u.name AS saved_by
      FROM tenant_configs v LEFT JOIN users u ON u.id = v.created_by
      ORDER BY v.version DESC LIMIT 100
    `);
    return {
      items: result.rows.map((row) => ({
        version: row.version,
        savedBy: row.saved_by ? { name: row.saved_by } : null,
        savedAt: iso(row.created_at),
        valid: tenantConfigSchema.safeParse(row.config).success,
      })),
    };
  }

  async version(tx: AppTx, version: number) {
    const result = await tx.execute<VersionRow>(sql`
      SELECT v.version, v.config, v.created_at, u.name AS saved_by
      FROM tenant_configs v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.version = ${version}
    `);
    const row = result.rows[0];
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND' });
    return {
      version: row.version,
      config: row.config,
      valid: tenantConfigSchema.safeParse(row.config).success,
      savedBy: row.saved_by ? { name: row.saved_by } : null,
      savedAt: iso(row.created_at),
    };
  }

  /**
   * Precio por conversación de cada modelo: el promedio real de la empresa en los últimos 30 días si lo
   * usó, o la estimación fija con los precios de ALLOWED_MODELS.
   */
  async models(tx: AppTx) {
    const history = await tx.execute<{ model: string; usd: string; conversations: number }>(sql`
      SELECT model, (sum(cost_usd) / count(DISTINCT conversation_id))::numeric(14, 8)::text AS usd,
             count(DISTINCT conversation_id)::int AS conversations
      FROM ai_runs
      WHERE created_at > now() - interval '30 days' AND cost_usd IS NOT NULL AND model IS NOT NULL
      GROUP BY model
    `);
    const byModel = new Map(history.rows.map((row) => [row.model, row]));
    return {
      items: ALLOWED_MODELS.map((model) => {
        const real = byModel.get(model.id);
        const oneTurn = addUsd(
          tokensCostUsd(ESTIMATE_INPUT_TOKENS, model.inputUsdPerMTok),
          tokensCostUsd(ESTIMATE_OUTPUT_TOKENS, model.outputUsdPerMTok),
        );
        return {
          id: model.id,
          provider: model.provider,
          isDefault: model.id === this.env.AI_DEFAULT_MODEL,
          usdPerConversation: real ? real.usd : addUsd(...Array<string>(ESTIMATE_TURNS).fill(oneTurn)),
          estimateSource: real ? ('history' as const) : ('estimated' as const),
          conversations: real?.conversations ?? 0,
        };
      }),
    };
  }

  /** Valida con el mismo schema que el worker. Error → 400 con la ruta de cada campo. */
  validated(input: unknown): TenantConfig {
    try {
      return this.configs.validate(input);
    } catch (error) {
      if (error instanceof InvalidTenantConfigError) {
        throw new BadRequestException({ code: 'INVALID_CONFIG', issues: error.fieldIssues });
      }
      throw error;
    }
  }

  /**
   * Revisión de calidad: activarla (de apagada a prendida) es solo del owner, con confirmTransparency. La
   * confirmación (review.transparency_ack) la escribe el servidor; la que venga del panel se ignora y se
   * conserva la de la versión anterior.
   */
  private applyReviewRules(
    context: TenantContext,
    config: TenantConfig,
    previous: Record<string, unknown> | null,
    confirmTransparency: boolean,
  ): void {
    const previousReview = (previous?.review ?? {}) as { enabled?: unknown; transparency_ack?: unknown };
    const wasEnabled = previousReview.enabled === true;
    const previousAck = transparencyAckSchema.safeParse(previousReview.transparency_ack);
    delete config.review.transparency_ack;
    if (config.review.enabled && !wasEnabled) {
      // 409 y no 403: el panel manda cualquier 403 a "sin acceso", y el admin sí puede editar el resto.
      if (context.role !== 'owner') throw new ConflictException({ code: 'REVIEW_OWNER_ONLY' });
      if (!confirmTransparency) throw new BadRequestException({ code: 'TRANSPARENCY_CONFIRM_REQUIRED' });
      config.review.transparency_ack = { by: context.userId, at: new Date().toISOString() };
    } else if (previousAck.success && previousAck.data) {
      config.review.transparency_ack = previousAck.data;
    }
  }
}
