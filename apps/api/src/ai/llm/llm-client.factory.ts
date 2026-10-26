import { Inject, Injectable } from '@nestjs/common';
import { findAllowedModel, type AllowedModel, type TenantConfig } from '@ventas/shared';
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
}

export interface LlmClientFactory {
  forTenant(tenantId: string, config: TenantConfig): Promise<LlmSelection>;
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

  async forTenant(_tenantId: string, config: TenantConfig): Promise<LlmSelection> {
    const model = findAllowedModel(config.ai.model ?? this.env.AI_DEFAULT_MODEL);
    if (!model) throw new ModelNotAllowedError();
    if (!this.env.OPENROUTER_API_KEY) throw new Error('Falta OPENROUTER_API_KEY');
    this.client ??= new OpenRouterClient({ apiKey: this.env.OPENROUTER_API_KEY });
    return { client: this.client, model, billingMode: 'platform' };
  }
}
