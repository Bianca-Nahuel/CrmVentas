import { z } from 'zod';

const postgresUrl = z
  .string()
  .url()
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'tiene que ser una URL postgres://');

const origin = z
  .string()
  .url()
  .refine(
    (value) => new URL(value).origin === value,
    'tiene que ser un origen (protocolo + host + puerto), sin path',
  );

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
});

export type Env = z.infer<typeof envSchema>;

// Variables que el proceso de la API nunca debe recibir en producción: las credenciales de ventas_owner
// (dueño de las tablas) solo las usan drizzle-kit y los tests.
const FORBIDDEN_IN_PRODUCTION = ['DATABASE_URL_MIGRATIONS'] as const;

// Si falta una variable o es inválida, la app no levanta. El mensaje nombra la variable, nunca su valor.
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
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
