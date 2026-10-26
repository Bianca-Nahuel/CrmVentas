import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_FALLBACK_MODEL_ID,
  findAllowedModel,
  type AllowedModel,
  type TenantConfig,
} from '@ventas/shared';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import type { BillingMode, LlmClient } from './llm-client.js';
import { OpenRouterClient } from './providers/openrouter/openrouter.client.js';

/** Elige cliente y modelo para una empresa. Los tests lo reemplazan por uno con un LlmClient falso. */
export const LLM_CLIENT_FACTORY = Symbol('LLM_CLIENT_FACTORY');

export interface LlmSelection {
  client: LlmClient;
  model: AllowedModel;
  billingMode: BillingMode;
  /** Solo en un turno con herramientas: cómo vuelve la salida estructurada. */
  toolOutputMode?: 'response_format' | 'final_tool';
  /** El modelo se cambió por la regla de ruteo de los turnos con catálogo. */
  routed?: 'catalog_fallback';
}

export interface LlmClientFactory {
  /** catalogTurn: el turno lleva las herramientas del catálogo (tarea 007). */
  forTenant(
    tenantId: string,
    config: TenantConfig,
    options?: { catalogTurn?: boolean },
  ): Promise<LlmSelection>;
}

/**
 * Regla de ruteo de la tarea 007: un turno con catálogo usa el modelo de la empresa si maneja herramientas
 * con salida estructurada (catalogTools response_format o final_tool); si no, CATALOG_FALLBACK_MODEL_ID.
 */
export function routeModel(
  model: AllowedModel,
  catalogTurn: boolean,
): { model: AllowedModel; toolOutputMode?: 'response_format' | 'final_tool'; routed?: 'catalog_fallback' } {
  if (!catalogTurn) return { model };
  if (model.catalogTools !== 'unsupported') return { model, toolOutputMode: model.catalogTools };
  const fallback = findAllowedModel(CATALOG_FALLBACK_MODEL_ID);
  if (!fallback || fallback.catalogTools === 'unsupported') throw new ModelNotAllowedError();
  return { model: fallback, toolOutputMode: fallback.catalogTools, routed: 'catalog_fallback' };
}

export class ModelNotAllowedError extends Error {
  constructor() {
    super('El modelo configurado no está en la lista de modelos permitidos');
    this.name = 'ModelNotAllowedError';
  }
}

/**
 * Tarea 006: siempre OpenRouter con la clave de la plataforma. La 009 lee la facturación de la empresa y,
 * en modo byok, devuelve el cliente de Anthropic u OpenAI con la clave descifrada.
 */
@Injectable()
export class PlatformLlmClientFactory implements LlmClientFactory {
  private client: OpenRouterClient | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async forTenant(
    _tenantId: string,
    config: TenantConfig,
    options: { catalogTurn?: boolean } = {},
  ): Promise<LlmSelection> {
    const configured = findAllowedModel(config.ai.model ?? this.env.AI_DEFAULT_MODEL);
    if (!configured) throw new ModelNotAllowedError();
    if (!this.env.OPENROUTER_API_KEY) throw new Error('Falta OPENROUTER_API_KEY');
    this.client ??= new OpenRouterClient({ apiKey: this.env.OPENROUTER_API_KEY });
    return {
      client: this.client,
      billingMode: 'platform',
      ...routeModel(configured, options.catalogTurn ?? false),
    };
  }
}
