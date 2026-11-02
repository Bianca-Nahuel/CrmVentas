// Contratos HTTP del panel de configuración del agente y del playground (tarea 027). Mismo esquema que
// inbox.contracts.ts. Todo con config.update (owner y admin). La config viaja como objeto libre: la valida
// el servidor con el mismo tenantConfigSchema de libs/shared (el panel la tipa con @ventas/shared/ai).
import { z } from 'zod';
import type { ApiRoute } from '../../http/api-route.js';

const isoDate = z.iso.datetime({ offset: true });
const configObject = z.record(z.string(), z.unknown());

/** Mensajes de una conversación de prueba (los del cliente y los del asistente). */
export const PLAYGROUND_MAX_MESSAGES = 20;
/** Turnos por hora por empresa (contados en ai_playground_runs). */
export const PLAYGROUND_TURNS_PER_HOUR = 30;
const PLAYGROUND_MAX_TEXT = 1000;

const savedBySchema = z.object({ name: z.string() }).nullable();

export const agentConfigSchema = z
  .object({
    // null: la empresa todavía no tiene configuración.
    version: z.number().int().nullable(),
    config: configObject.nullable(),
    // La vigente valida con el schema actual (si no, la IA no corre hasta guardar una nueva).
    valid: z.boolean(),
    savedBy: savedBySchema,
    savedAt: isoDate.nullable(),
    // Zona horaria de la empresa (horarios y simulación de hora del playground).
    timezone: z.string(),
  })
  .meta({ id: 'AgentConfig' });

export const saveAgentConfigBodySchema = z
  .object({
    config: configObject,
    // La versión sobre la que se editó (0 si no había ninguna). Si ya no es la vigente → 409.
    expectedVersion: z.number().int().min(0),
    // Solo el owner, al activar la revisión de calidad: confirma que avisó al equipo.
    confirmTransparency: z.boolean().optional(),
  })
  .strict()
  .meta({ id: 'SaveAgentConfig' });
export type SaveAgentConfigBody = z.infer<typeof saveAgentConfigBodySchema>;

export const savedVersionSchema = z
  .object({ version: z.number().int(), savedAt: isoDate })
  .meta({ id: 'SavedAgentConfigVersion' });

export const versionListSchema = z
  .object({
    items: z.array(
      z.object({ version: z.number().int(), savedBy: savedBySchema, savedAt: isoDate, valid: z.boolean() }),
    ),
  })
  .meta({ id: 'AgentConfigVersionList' });

export const versionParamsSchema = z.object({ version: z.coerce.number().int().min(1) }).strict();

export const agentConfigVersionSchema = z
  .object({
    version: z.number().int(),
    config: configObject,
    valid: z.boolean(),
    savedBy: savedBySchema,
    savedAt: isoDate,
  })
  .meta({ id: 'AgentConfigVersion' });

export const restoreBodySchema = z
  .object({ expectedVersion: z.number().int().min(0), confirmTransparency: z.boolean().optional() })
  .strict()
  .meta({ id: 'RestoreAgentConfig' });
export type RestoreBody = z.infer<typeof restoreBodySchema>;

export const modelListSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        provider: z.string(),
        isDefault: z.boolean(),
        // Precio estimado por conversación en USD (texto decimal).
        usdPerConversation: z.string(),
        // history: promedio real de la empresa en los últimos 30 días; estimated: cuenta fija.
        estimateSource: z.enum(['history', 'estimated']),
        conversations: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'AgentModelList' });

const extractedValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

// El estado de la conversación de prueba lo guarda el panel y lo manda en cada turno (decisión #114): si
// alguien lo cambia, solo cambia su propia prueba.
export const playgroundStateSchema = z
  .object({
    extracted: z
      .record(z.string().max(40), extractedValue)
      .refine((value) => Object.keys(value).length <= 20, 'demasiados campos'),
    discovered: z
      .array(
        z.object({
          topic: z.string().max(60),
          value: z.string().max(300),
          evidence: z.string().max(300).nullable(),
        }),
      )
      .max(20),
    lastScore: z.number().int().min(0).max(100).nullable(),
    counters: z.object({
      qualificationTurns: z.number().int().min(0).max(100),
      hotTurns: z.number().int().min(0).max(100),
      suggestionsCount: z.number().int().min(0).max(100),
      afterFieldsAsks: z.number().int().min(0).max(100),
    }),
    // Ya derivó: el agente no vuelve a escribir (empezar de nuevo).
    handedOff: z.boolean(),
  })
  .meta({ id: 'PlaygroundState' });
export type PlaygroundState = z.infer<typeof playgroundStateSchema>;

export const playgroundBodySchema = z
  .object({
    config: configObject,
    // La versión sobre la que se está editando (solo para el registro del costo).
    baseVersion: z.number().int().min(0).nullable(),
    history: z
      .array(
        z
          .object({
            author: z.enum(['cliente', 'asistente']),
            text: z.string().trim().min(1).max(PLAYGROUND_MAX_TEXT),
          })
          .strict(),
      )
      .min(1)
      .max(PLAYGROUND_MAX_MESSAGES)
      .refine(
        (history) => history.at(-1)?.author === 'cliente',
        'el último mensaje tiene que ser del cliente',
      ),
    state: playgroundStateSchema,
    // Simular otro momento de la semana (hora local de la empresa). Sin él, ahora.
    simulate: z
      .object({
        day: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .meta({ id: 'PlaygroundTurn' });
export type PlaygroundBody = z.infer<typeof playgroundBodySchema>;

export const playgroundResultSchema = z
  .object({
    // Lo que le llegaría al cliente: la respuesta (con las marcas ya renderizadas) o el texto fijo de
    // derivación. null: no le escribe nada (decisión none o un error).
    reply: z.string().nullable(),
    decision: z.string(),
    detail: z.object({
      isOpen: z.boolean(),
      localTime: z.string(),
      score: z.number().int().nullable(),
      tier: z.enum(['hot', 'warm', 'cold']).nullable(),
      breakdown: z
        .object({
          dimensions: z.array(
            z.object({ key: z.string(), signal: z.number(), weight: z.number(), points: z.number() }),
          ),
          completeness: z
            .object({
              value: z.number(),
              weight: z.number(),
              obtained: z.array(z.string()),
              missing: z.array(z.string()),
            })
            .nullable(),
        })
        .nullable(),
      extracted: z.array(z.object({ key: z.string(), label: z.string(), value: extractedValue })),
      triggers: z.array(z.string()),
      handoffReason: z.string().nullable(),
      handoffSummary: z.string().nullable(),
      // Control de salida que bloqueó la respuesta del modelo (y por eso derivó).
      blocked: z.string().nullable(),
      catalog: z.object({ consulted: z.array(z.string()), cited: z.array(z.string()) }).nullable(),
      model: z.string().nullable(),
      costUsd: z.string().nullable(),
    }),
    state: playgroundStateSchema,
    turnsLastHour: z.number().int(),
    turnsPerHour: z.number().int(),
  })
  .meta({ id: 'PlaygroundResult' });

export const agentConfigRoutes: ApiRoute[] = [
  {
    method: 'get',
    path: '/agent-config',
    operationId: 'getAgentConfig',
    summary: 'La configuración vigente del agente, con su versión, quién la guardó y cuándo',
    response: agentConfigSchema,
  },
  {
    method: 'put',
    path: '/agent-config',
    operationId: 'saveAgentConfig',
    summary: 'Guarda una versión nueva (409 si expectedVersion ya no es la vigente)',
    body: saveAgentConfigBodySchema,
    response: savedVersionSchema,
    conflict: true,
  },
  {
    method: 'get',
    path: '/agent-config/versions',
    operationId: 'listAgentConfigVersions',
    summary: 'Historial de versiones (las últimas 100)',
    response: versionListSchema,
  },
  {
    method: 'get',
    path: '/agent-config/versions/{version}',
    operationId: 'getAgentConfigVersion',
    summary: 'Una versión de la configuración',
    params: versionParamsSchema,
    response: agentConfigVersionSchema,
  },
  {
    method: 'post',
    path: '/agent-config/versions/{version}/restore',
    operationId: 'restoreAgentConfigVersion',
    summary: 'Crea una versión nueva copiando esa',
    params: versionParamsSchema,
    body: restoreBodySchema,
    response: savedVersionSchema,
    conflict: true,
  },
  {
    method: 'get',
    path: '/agent-config/models',
    operationId: 'listAgentModels',
    summary: 'Modelos permitidos con el precio estimado por conversación',
    response: modelListSchema,
  },
  {
    method: 'post',
    path: '/agent-config/playground',
    operationId: 'playgroundTurn',
    summary: 'Un turno del chat de prueba con la configuración en edición (no envía ni guarda mensajes)',
    body: playgroundBodySchema,
    response: playgroundResultSchema,
    conflict: true,
    errors: [429, 503],
  },
];
