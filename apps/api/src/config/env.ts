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
  DATABASE_URL_MIGRATIONS: postgresUrl,
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

// Si falta una variable o es inválida, la app no levanta. El mensaje nombra la variable, nunca su valor.
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `- ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Configuración inválida:\n${problems.join('\n')}`);
  }
  return result.data;
}
