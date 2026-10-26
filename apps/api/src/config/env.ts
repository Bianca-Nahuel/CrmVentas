import { findAllowedModel } from '@ventas/shared';
import { z } from 'zod';

const postgresUrl = z
  .string()
  .url()
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'tiene que ser una URL postgres://');

// En zod 4 los refine corren aunque .url() haya fallado: un `new URL` sin protección lanzaría un
// TypeError con el valor adentro, en vez del error de validación que nombra solo la variable.
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const origin = z
  .string()
  .url()
  .refine(
    (value) => parseUrl(value)?.origin === value,
    'tiene que ser un origen (protocolo + host + puerto), sin path',
  );

// Ruta del webhook de WAHA (prefijo global 'api' + WahaWebhookController).
const WAHA_WEBHOOK_PATH = '/api/webhooks/waha';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: postgresUrl,
  DATABASE_URL_AUTH: postgresUrl,
  BETTER_AUTH_SECRET: z.string().min(32, 'tiene que tener al menos 32 caracteres'),
  BETTER_AUTH_URL: origin,
  TRUSTED_ORIGINS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .pipe(z.array(origin).min(1)),
  // API de WAHA vista desde el backend (sesiones, LIDs).
  WAHA_BASE_URL: origin,
  // Header X-Api-Key de WAHA (la misma variable que usa el contenedor).
  WAHA_API_KEY: z.string().min(1),
  // URL del webhook vista desde el contenedor de WAHA (host.docker.internal en desarrollo). Tiene que
  // apuntar a la ruta real: con otra, WAHA recibe 404 y agota los reintentos sin que nada lo avise.
  WAHA_WEBHOOK_URL: z
    .string()
    .url()
    .refine(
      (value) => parseUrl(value)?.pathname === WAHA_WEBHOOK_PATH,
      `tiene que terminar en ${WAHA_WEBHOOK_PATH}`,
    ),
  // Clave HMAC con la que WAHA firma cada webhook (SHA-512 sobre el cuerpo crudo).
  WAHA_WEBHOOK_HMAC_KEY: z
    .string()
    .refine((value) => Buffer.byteLength(value, 'utf8') >= 32, 'tiene que tener al menos 32 bytes'),
  // IA (tarea 006). Interruptor general, apagado por defecto.
  AI_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Clave de OpenRouter de la plataforma (la pagamos nosotros). Obligatoria con AI_ENABLED=true.
  // Vacía (la línea del .env.example sin completar) cuenta como no definida.
  OPENROUTER_API_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .regex(/^sk-or-[A-Za-z0-9_-]{16,}$/, 'tiene que ser una clave de OpenRouter (sk-or-…)')
      .optional(),
  ),
  // Modelo por defecto si la empresa no eligió otro; tiene que estar en ALLOWED_MODELS.
  AI_DEFAULT_MODEL: z
    .string()
    .default('deepseek/deepseek-v4.1-flash')
    .refine((value) => findAllowedModel(value) !== undefined, 'no está en la lista de modelos permitidos'),
});

const envSchemaWithRules = envSchema.superRefine((env, ctx) => {
  if (env.AI_ENABLED && !env.OPENROUTER_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['OPENROUTER_API_KEY'],
      message: 'obligatoria con AI_ENABLED=true',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

// Variables que el proceso de la API nunca debe recibir en producción: las credenciales de ventas_owner
// (dueño de las tablas) solo las usan drizzle-kit y los tests.
const FORBIDDEN_IN_PRODUCTION = ['DATABASE_URL_MIGRATIONS'] as const;

// Si falta una variable o es inválida, la app no levanta. El mensaje nombra la variable, nunca su valor.
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchemaWithRules.safeParse(source);
  const problems = result.success
    ? []
    : result.error.issues.map((issue) => `- ${issue.path.join('.')}: ${issue.message}`);
  if (source.NODE_ENV === 'production') {
    for (const name of FORBIDDEN_IN_PRODUCTION) {
      if (source[name] !== undefined) problems.push(`- ${name}: no debe estar definida en producción`);
    }
  }
  if (!result.success || problems.length > 0) {
    throw new Error(`Configuración inválida:\n${problems.join('\n')}`);
  }
  return result.data;
}
