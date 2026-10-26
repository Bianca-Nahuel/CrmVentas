// Configuración del agente de una empresa (tarea 006). La valida el script dev:set-config y, más
// adelante, el panel (tarea 012). Todo lo específico de un negocio sale de acá, nunca del código.
// Textos con largo máximo y listas con tamaño máximo: acotan el prompt y lo que una empresa puede meter
// en su propia capa (que igual queda por debajo de la capa fija).
import { z } from 'zod';
import { catalogConfigSchema } from './catalog-config.js';
import { findAllowedModel } from './models.js';
import { normalizeText } from './text.js';

export const PREDEFINED_TRIGGERS = [
  'asks_human',
  'availability',
  'payment_or_reservation',
  'price_negotiation',
  'complaint',
  'frustration',
  'cannot_answer',
] as const;
export type PredefinedTrigger = (typeof PREDEFINED_TRIGGERS)[number];

/** Los que además detecta el código (respaldo del modelo). */
export const CRITICAL_TRIGGERS = ['availability', 'asks_human', 'payment_or_reservation'] as const;
export type CriticalTrigger = (typeof CRITICAL_TRIGGERS)[number];

export const QUALIFICATION_FIELD_TYPES = ['string', 'number', 'date', 'enum', 'boolean'] as const;

/**
 * Datos que el agente nunca puede pedir, por clave, etiqueta o forma de preguntar (normalizadas).
 * CUIT y CUIL no están: se piden solo si la empresa los configura como campo.
 */
export const SENSITIVE_FIELD_PATTERN =
  /tarjeta|card|cvv|cvc|contrase|password|clave|\bpin\b|codigo de (verificacion|seguridad)|verification|\botp\b|\bcbu\b|\bcvu\b|\bdni\b|documento|pasaporte|token/;

const str = (min: number, max: number) => z.string().trim().min(min).max(max);
const lang = z.string().regex(/^[a-z]{2}$/, 'código de idioma ISO 639-1 (es, en…)');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora HH:MM');
const timeRange = z
  .object({ open: hhmm, close: hhmm })
  .strict()
  .refine((range) => range.open < range.close, 'open tiene que ser anterior a close');
/** Franjas de un día; [] = cerrado. */
const dayHours = z.array(timeRange).max(3);
export const weeklyHoursSchema = z
  .object({
    mon: dayHours,
    tue: dayHours,
    wed: dayHours,
    thu: dayHours,
    fri: dayHours,
    sat: dayHours,
    sun: dayHours,
  })
  .strict();
export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;

const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'clave en minúsculas, números y _');
const customTriggerId = z.string().regex(/^custom_[a-z0-9_]{1,40}$/, 'custom_ + minúsculas, números y _');

const handoffModeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('immediate') }).strict(),
  z
    .object({
      type: z.literal('after_fields'),
      fields: z.array(key).min(1).max(5),
      // Texto fijo de la empresa antes de las preguntas, por idioma (obligatorio en business.language).
      intro: z.record(lang, str(1, 300)),
    })
    .strict(),
]);
export type HandoffMode = z.infer<typeof handoffModeSchema>;

const triggerSchema = z.object({ enabled: z.boolean(), mode: handoffModeSchema }).strict();

const qualificationFieldSchema = z
  .object({
    key,
    label: str(1, 60),
    type: z.enum(QUALIFICATION_FIELD_TYPES),
    options: z.array(str(1, 60)).min(2).max(20).optional(),
    // La pregunta tal como se le haría al cliente, en business.language. El modelo la adapta; para las
    // preguntas de un disparador after_fields, el código la usa literal.
    how_to_ask: str(1, 200),
    how_to_ask_i18n: z.record(lang, str(1, 200)).optional(),
    required: z.boolean(),
    // 1 = se pregunta primero.
    priority: z.number().int().min(1).max(99),
    // Solo se pregunta si el puntaje ya pasó este valor.
    ask_when_score_gte: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type QualificationField = z.infer<typeof qualificationFieldSchema>;

const keywordsSchema = z
  .object({
    // Frases planas (nunca regex): se suman o se quitan de las de fábrica.
    extra: z.array(str(2, 60)).max(30).default([]),
    exclude: z.array(str(2, 60)).max(30).default([]),
  })
  .strict();

export const tenantConfigSchema = z
  .object({
    schema_version: z.literal(1),
    ai: z
      .object({
        enabled: z.boolean(),
        channel_ids: z.array(z.uuid()).max(20),
        model: z.string().max(100).optional(),
      })
      .strict(),
    business: z
      .object({
        name: str(1, 100),
        industry: str(1, 100),
        // Idioma de how_to_ask y de los textos fijos.
        language: lang.default('es'),
        branches: z
          .array(
            z
              .object({
                name: str(1, 100),
                address: str(1, 200),
                hours: weeklyHoursSchema,
                phone: z
                  .string()
                  .regex(/^\+[1-9]\d{6,14}$/, 'teléfono E.164')
                  .optional(),
                notes: str(1, 300).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(20),
        // Horario de atención del WhatsApp, en la zona horaria de tenants.timezone.
        service_hours: weeklyHoursSchema,
        payment_methods: z.array(str(1, 200)).max(20),
        shipping: str(1, 1000).nullable(),
        website: z.url().max(200).nullable(),
        email: z.email().max(200).nullable(),
      })
      .strict(),
    knowledge: z
      .object({
        faqs: z.array(z.object({ question: str(1, 300), answer: str(1, 1000) }).strict()).max(50),
        policies: z
          .object({
            returns: str(1, 1500).nullable(),
            warranty: str(1, 1500).nullable(),
            shipping: str(1, 1500).nullable(),
            financing: str(1, 1500).nullable(),
          })
          .strict(),
      })
      .strict(),
    agent: z
      .object({
        persona: z.object({ name: str(1, 40).nullable(), tone: str(1, 300) }).strict(),
        custom_instructions: str(0, 2000),
        sales_guidance: str(0, 1500),
        business_rules: z.array(z.object({ id: key, text: str(1, 300) }).strict()).max(30),
        offers: z.array(z.object({ id: key, description: str(1, 300), when: str(1, 300) }).strict()).max(15),
        must_not: z.array(str(1, 200)).max(30),
      })
      .strict(),
    qualification: z
      .object({
        // Puede estar vacío: la empresa trabaja solo con la guía de descubrimiento.
        fields: z.array(qualificationFieldSchema).max(15),
        discovery_guidance: str(0, 2000),
        max_questions_per_message: z.union([z.literal(1), z.literal(2)]),
        max_qualification_turns: z.number().int().min(1).max(20),
        max_turns_when_hot: z.number().int().min(0).max(10).default(2),
      })
      .strict(),
    scoring: z
      .object({
        dimensions: z
          .array(z.object({ key, description: str(1, 300), weight: z.number().positive().max(100) }).strict())
          .min(1)
          .max(8),
        completeness_weight: z.number().min(0).max(100),
        thresholds: z
          .object({ hot: z.number().int().min(1).max(100), warm: z.number().int().min(0).max(99) })
          .strict(),
      })
      .strict(),
    handoff: z
      .object({
        triggers: z
          .object(
            Object.fromEntries(PREDEFINED_TRIGGERS.map((id) => [id, triggerSchema])) as Record<
              PredefinedTrigger,
              typeof triggerSchema
            >,
          )
          .strict(),
        custom_triggers: z
          .array(
            z.object({ id: customTriggerId, description: str(1, 300), mode: handoffModeSchema }).strict(),
          )
          .max(15),
        keywords: z
          .object(
            Object.fromEntries(CRITICAL_TRIGGERS.map((id) => [id, keywordsSchema.optional()])) as Record<
              CriticalTrigger,
              z.ZodOptional<typeof keywordsSchema>
            >,
          )
          .strict()
          .default({}),
        message_in_hours: str(1, 500),
        message_after_hours: str(1, 500),
        qualify_after_hours: z.boolean().default(true),
        unsupported_media: z.discriminatedUnion('mode', [
          z.object({ mode: z.literal('ask_text'), message: str(1, 300) }).strict(),
          z.object({ mode: z.literal('handoff') }).strict(),
        ]),
      })
      .strict(),
    // Catálogo (tarea 007). Sin esta sección, el agente no tiene herramientas ni precios.
    catalog: catalogConfigSchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const unique = (path: string[], values: string[]) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) issue([...path, index], `clave repetida: ${value}`);
        seen.add(value);
      });
    };

    const fields = config.qualification.fields;
    unique(
      ['qualification', 'fields'],
      fields.map((field) => field.key),
    );
    unique(
      ['scoring', 'dimensions'],
      config.scoring.dimensions.map((dimension) => dimension.key),
    );
    unique(
      ['agent', 'business_rules'],
      config.agent.business_rules.map((rule) => rule.id),
    );
    unique(
      ['agent', 'offers'],
      config.agent.offers.map((offer) => offer.id),
    );
    unique(
      ['handoff', 'custom_triggers'],
      config.handoff.custom_triggers.map((trigger) => trigger.id),
    );

    fields.forEach((field, index) => {
      if ((field.type === 'enum') !== (field.options !== undefined)) {
        issue(['qualification', 'fields', index, 'options'], 'options va si y solo si type = enum');
      }
      const texts = [
        field.key.replace(/_/g, ' '),
        field.label,
        field.how_to_ask,
        ...Object.values(field.how_to_ask_i18n ?? {}),
      ];
      if (texts.some((text) => SENSITIVE_FIELD_PATTERN.test(normalizeText(text)))) {
        issue(
          ['qualification', 'fields', index],
          'no se pueden pedir datos sensibles (tarjeta, CVV, contraseñas, códigos, CBU/CVU, DNI)',
        );
      }
    });

    if (config.scoring.thresholds.warm >= config.scoring.thresholds.hot) {
      issue(['scoring', 'thresholds', 'warm'], 'warm tiene que ser menor que hot');
    }
    if (config.ai.model !== undefined && !findAllowedModel(config.ai.model)) {
      issue(['ai', 'model'], 'el modelo no está en la lista de modelos permitidos');
    }

    const fieldKeys = new Set(fields.map((field) => field.key));
    const checkMode = (mode: HandoffMode, path: (string | number)[]) => {
      if (mode.type !== 'after_fields') return;
      mode.fields.forEach((fieldKey, index) => {
        if (!fieldKeys.has(fieldKey)) issue([...path, 'fields', index], `el campo ${fieldKey} no existe`);
      });
      if (!mode.intro[config.business.language]) {
        issue([...path, 'intro'], `falta el intro en el idioma del negocio (${config.business.language})`);
      }
    };
    for (const id of PREDEFINED_TRIGGERS)
      checkMode(config.handoff.triggers[id].mode, ['handoff', 'triggers', id, 'mode']);
    config.handoff.custom_triggers.forEach((trigger, index) =>
      checkMode(trigger.mode, ['handoff', 'custom_triggers', index, 'mode']),
    );
  });

export type TenantConfig = z.infer<typeof tenantConfigSchema>;
/** Lo que se escribe en el JSON (con los defaults todavía sin aplicar). */
export type TenantConfigInput = z.input<typeof tenantConfigSchema>;
