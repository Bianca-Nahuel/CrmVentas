// Salida estructurada del modelo, armada por empresa (dimensiones, campos y disparadores de su config).
// El mismo zod genera el JSON Schema estricto que va a OpenRouter y valida lo que vuelve.
import { PREDEFINED_TRIGGERS, type QualificationField, type TenantConfig } from '@ventas/shared';
import { z } from 'zod';
import { HANDOFF_SUMMARY_MODEL_MAX_CHARS } from '../../ai.constants.js';
import type { StructuredSchema } from '../../llm/llm-client.js';

export type ExtractedValue = string | number | boolean | null;

export interface DiscoveredNote {
  topic: string;
  value: string;
  evidence: string | null;
}

export interface AgentOutput {
  signals: Record<string, { score: number; evidence: string | null }>;
  extracted: Record<string, ExtractedValue>;
  discovered: DiscoveredNote[];
  language: string;
  triggers: string[];
  action: 'reply' | 'handoff' | 'none';
  reply: string | null;
  suggestion: string | null;
  handoff_summary: string;
  reason: string | null;
}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function fieldSchema(field: QualificationField): z.ZodType<ExtractedValue> {
  const described = <T extends z.ZodType>(schema: T) => schema.describe(field.label);
  switch (field.type) {
    case 'string':
      return described(z.string().max(200).nullable());
    case 'number':
      return described(z.number().nullable());
    case 'date':
      return described(z.string().regex(DATE).nullable());
    case 'boolean':
      return described(z.boolean().nullable());
    case 'enum':
      return described(z.enum(field.options as [string, ...string[]]).nullable());
  }
}

/** Disparadores que el modelo puede marcar: los predefinidos habilitados y los propios. */
export function enabledTriggerIds(config: TenantConfig): string[] {
  return [
    ...PREDEFINED_TRIGGERS.filter((id) => config.handoff.triggers[id].enabled),
    ...config.handoff.custom_triggers.map((trigger) => trigger.id),
  ];
}

export function buildOutputSchema(config: TenantConfig): StructuredSchema<AgentOutput> {
  const signal = z
    .object({ score: z.number().int().min(0).max(5), evidence: z.string().max(200).nullable() })
    .strict();
  const triggerIds = enabledTriggerIds(config);
  const triggers =
    triggerIds.length > 0
      ? z.array(z.enum(triggerIds as [string, ...string[]])).max(10)
      : z.array(z.string()).max(0);

  const schema = z
    .object({
      signals: z
        .object(Object.fromEntries(config.scoring.dimensions.map((dimension) => [dimension.key, signal])))
        .strict(),
      extracted: z
        .object(
          Object.fromEntries(config.qualification.fields.map((field) => [field.key, fieldSchema(field)])),
        )
        .strict(),
      discovered: z
        .array(
          z
            .object({
              topic: z.string().min(1).max(60),
              value: z.string().min(1).max(200),
              evidence: z.string().max(200).nullable(),
            })
            .strict(),
        )
        .max(10),
      language: z.string().regex(/^[a-z]{2}$/),
      triggers,
      action: z.enum(['reply', 'handoff', 'none']),
      reply: z.string().max(1000).nullable(),
      suggestion: z.string().max(200).nullable(),
      handoff_summary: z.string().min(1).max(HANDOFF_SUMMARY_MODEL_MAX_CHARS),
      reason: z.string().max(160).nullable(),
    })
    .strict();

  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete jsonSchema.$schema;

  const validated = schema
    .refine((output) => output.action !== 'reply' || (output.reply !== null && output.reply.trim() !== ''), {
      message: 'action = reply sin reply',
    })
    .refine((output) => new Set(output.triggers).size === output.triggers.length, {
      message: 'disparadores repetidos',
    });

  return { name: 'agent_turn', zod: validated as unknown as z.ZodType<AgentOutput>, jsonSchema };
}
