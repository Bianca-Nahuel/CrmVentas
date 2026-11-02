// Evals del analista de calidad (tarea 026): corre los casos de evals/revision/ con el pipeline real (capa
// fija, schema, validación de citas) contra OpenRouter, sin base de datos.
// Uso: npm run evals:review -- --model <id> [--model <id>] [--case R03 ...] [--max-usd 0.30]
//   Sin --model, usa AI_DEFAULT_MODEL. Acepta modelos de ALLOWED_MODELS y de CANDIDATE_MODELS.
// Metas (tarea 026): resultado del cliente ≥ 85 %, citas inválidas después de la validación 0, inyecciones
// exitosas 0. Reporte en consola y en evals/resultados/ (no se commitea).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadLocalEnv } from '../src/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('evals:review no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
loadLocalEnv();

const { CANDIDATE_MODELS, findAllowedModel, reviewConfigSchema } = await import('@ventas/shared');
const { parseEnv } = await import('../src/config/env.js');
const { OpenRouterClient } = await import('../src/ai/llm/providers/openrouter/openrouter.client.js');
const { LlmError } = await import('../src/ai/llm/llm-client.js');
const { addUsd } = await import('../src/ai/llm/money.js');
const {
  buildReviewPrompt,
  buildReviewSchema,
  prepareReviewMessages,
  REVIEW_MAX_OUTPUT_TOKENS,
  REVIEW_PROMPT_VERSION,
} = await import('../src/performance/review/prompt-v1.js');
const { checkEvidence, validateReview } = await import('../src/performance/review/evidence.js');

type ReviewOutput = import('../src/performance/review/prompt-v1.js').ReviewOutput;
type ReviewAuthor = import('../src/performance/review/prompt-v1.js').ReviewAuthor;
type OneOrMany<T> = T | T[];

interface ReviewCase {
  id: string;
  rubro: string;
  tipo: string;
  titulo: string;
  guidance?: string;
  conversacion: { de: ReviewAuthor; texto: string }[];
  esperado: {
    resultado_cliente?: OneOrMany<ReviewOutput['customer_outcome']['value']>;
    resuelto?: OneOrMany<ReviewOutput['resolved']>;
    problemas?: string[];
    problemas_alguno?: string[];
    sin_problemas?: string[];
    criterio_max?: Record<string, number>;
    criterio_min?: Record<string, number>;
    criterio_nulos_min?: number;
    inyeccion?: boolean;
  };
}

interface CaseResult {
  id: string;
  tipo: string;
  ok: boolean;
  failures: string[];
  outcomeChecked: boolean;
  outcomeOk: boolean;
  injection: boolean;
  discarded: number;
  invalidAfterValidation: number;
  costUsd: string;
  latencyMs: number;
  review?: ReviewOutput;
  error?: string;
}

const ROOT = resolve(import.meta.dirname, '../../..');
const CASES_FILE = join(ROOT, 'evals/revision/casos.json');
const RESULTS_DIR = join(ROOT, 'evals/resultados');
const CONCURRENCY = 4;
const list = <T>(value: OneOrMany<T>) => (Array.isArray(value) ? value : [value]);

function check(item: ReviewCase, review: ReviewOutput): { failures: string[]; outcomeOk: boolean } {
  const failures: string[] = [];
  const expected = item.esperado;
  const issueTypes = new Set(review.issues.map((issue) => issue.type));
  let outcomeOk = true;
  if (
    expected.resultado_cliente &&
    !list(expected.resultado_cliente).includes(review.customer_outcome.value)
  ) {
    outcomeOk = false;
    failures.push(
      `resultado del cliente ${review.customer_outcome.value} (esperado ${list(expected.resultado_cliente).join('|')})`,
    );
  }
  if (expected.resuelto && !list(expected.resuelto).includes(review.resolved))
    failures.push(`resuelto ${review.resolved} (esperado ${list(expected.resuelto).join('|')})`);
  for (const type of expected.problemas ?? [])
    if (!issueTypes.has(type as never)) failures.push(`falta el problema ${type}`);
  if (expected.problemas_alguno && !expected.problemas_alguno.some((type) => issueTypes.has(type as never)))
    failures.push(`ningún problema de ${expected.problemas_alguno.join('|')}`);
  for (const type of expected.sin_problemas ?? [])
    if (issueTypes.has(type as never)) failures.push(`problema que no tenía que estar: ${type}`);
  for (const [key, max] of Object.entries(expected.criterio_max ?? {})) {
    const score = review.criteria[key]?.score ?? null;
    if (score !== null && score > max) failures.push(`${key} = ${score} (máximo ${max})`);
  }
  for (const [key, min] of Object.entries(expected.criterio_min ?? {})) {
    const score = review.criteria[key]?.score ?? null;
    if (score === null || score < min) failures.push(`${key} = ${score} (mínimo ${min})`);
  }
  if (expected.criterio_nulos_min !== undefined) {
    const nulls = Object.values(review.criteria).filter((value) => value.score === null).length;
    if (nulls < expected.criterio_nulos_min)
      failures.push(`${nulls} criterios sin nota (mínimo ${expected.criterio_nulos_min})`);
  }
  return { failures, outcomeOk };
}

/** Cada evidencia que quedó después de validar tiene que volver a pasar la verificación. */
function invalidAfterValidation(
  review: ReviewOutput,
  messages: ReturnType<typeof prepareReviewMessages>,
): number {
  const evidences: [ReviewAuthor, { message: number; quote: string } | null][] = [
    ['cliente', review.customer_outcome.evidence],
    ...Object.values(review.criteria).map(
      (value) => ['equipo', value.evidence] as [ReviewAuthor, typeof value.evidence],
    ),
    ...review.issues.map((issue) => ['equipo', issue.evidence] as [ReviewAuthor, typeof issue.evidence]),
    ...review.highlights.map(
      (highlight) => ['equipo', highlight.evidence] as [ReviewAuthor, typeof highlight.evidence],
    ),
  ];
  return evidences.filter(
    ([author, evidence]) => evidence && checkEvidence(evidence, messages, author) !== null,
  ).length;
}

async function runCase(
  client: InstanceType<typeof OpenRouterClient>,
  model: NonNullable<ReturnType<typeof findAllowedModel>>,
  item: ReviewCase,
): Promise<CaseResult> {
  const config = reviewConfigSchema.parse({ enabled: true, guidance: item.guidance ?? '' });
  const messages = prepareReviewMessages(
    item.conversacion.map((message, index) => ({
      author: message.de,
      at: `2026-10-27 10:${String(index).padStart(2, '0')}`,
      text: message.texto,
    })),
  );
  const prompt = buildReviewPrompt(config, messages);
  const base = {
    id: item.id,
    tipo: item.tipo,
    injection: item.esperado.inyeccion === true,
    outcomeChecked: !!item.esperado.resultado_cliente,
  };
  try {
    const result = await client.complete({
      model: model.id,
      system: prompt.system,
      messages: prompt.messages,
      schema: buildReviewSchema(config),
      maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    });
    const { review, discarded } = validateReview(result.parsed, messages);
    const { failures, outcomeOk } = check(item, review);
    return {
      ...base,
      ok: failures.length === 0,
      failures,
      outcomeOk,
      discarded: discarded.length,
      invalidAfterValidation: invalidAfterValidation(review, messages),
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      review,
    };
  } catch (error) {
    const charged = error instanceof LlmError ? error.charged : undefined;
    return {
      ...base,
      ok: false,
      failures: ['error'],
      outcomeOk: false,
      discarded: 0,
      invalidAfterValidation: 0,
      costUsd: charged?.costUsd ?? '0',
      latencyMs: charged?.latencyMs ?? 0,
      error:
        error instanceof LlmError ? `${error.kind}${error.detail ? `: ${error.detail}` : ''}` : String(error),
    };
  }
}

const { values } = parseArgs({
  options: {
    model: { type: 'string', multiple: true },
    case: { type: 'string', multiple: true },
    'max-usd': { type: 'string' },
  },
  strict: true,
});
const env = parseEnv();
if (!env.OPENROUTER_API_KEY) {
  console.error('Falta OPENROUTER_API_KEY en el .env.');
  process.exit(1);
}
const models = (values.model ?? [env.AI_DEFAULT_MODEL]).map((id) => {
  const model = findAllowedModel(id) ?? CANDIDATE_MODELS.find((candidate) => candidate.id === id);
  if (!model) {
    console.error(`Modelo desconocido: ${id}`);
    process.exit(1);
  }
  return model;
});
const maxUsd = values['max-usd'] === undefined ? Infinity : Number(values['max-usd']);
const all = JSON.parse(await readFile(CASES_FILE, 'utf8')) as ReviewCase[];
const cases = values.case ? all.filter((item) => values.case!.includes(item.id)) : all;
const client = new OpenRouterClient({ apiKey: env.OPENROUTER_API_KEY });

let spent = '0';
let skipped = 0;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
await mkdir(RESULTS_DIR, { recursive: true });
const summary: Record<string, unknown>[] = [];
for (const model of models) {
  const results: CaseResult[] = [];
  const queue = [...cases];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        if (Number(spent) >= maxUsd) {
          skipped++;
          continue;
        }
        const result = await runCase(client, model, item);
        spent = addUsd(spent, result.costUsd);
        results.push(result);
      }
    }),
  );
  results.sort((a, b) => a.id.localeCompare(b.id));
  const ran = results.filter((result) => !result.error);
  const outcomeCases = results.filter((result) => result.outcomeChecked);
  const outcomeOk = outcomeCases.filter((result) => result.outcomeOk).length;
  const injections = results.filter((result) => result.injection);
  const injectionsSucceeded = injections.filter((result) => !result.ok).length;
  const cost = results.reduce((total, result) => addUsd(total, result.costUsd), '0');
  const row = {
    model: model.id,
    promptVersion: REVIEW_PROMPT_VERSION,
    cases: results.length,
    passed: results.filter((result) => result.ok).length,
    errors: results.length - ran.length,
    outcomeAccuracyPct:
      outcomeCases.length > 0 ? Math.round((outcomeOk / outcomeCases.length) * 1000) / 10 : null,
    invalidCitationsAfterValidation: results.reduce(
      (total, result) => total + result.invalidAfterValidation,
      0,
    ),
    discardedByValidation: results.reduce((total, result) => total + result.discarded, 0),
    injectionsSucceeded,
    injectionCases: injections.length,
    costUsd: cost,
    costPerReviewUsd: results.length > 0 ? (Number(cost) / results.length).toFixed(6) : null,
    avgLatencyMs:
      ran.length > 0
        ? Math.round(ran.reduce((total, result) => total + result.latencyMs, 0) / ran.length)
        : null,
  };
  summary.push(row);
  console.log(`\n=== ${model.id} ===`);
  for (const result of results)
    console.log(
      `${result.ok ? '✓' : '✗'} ${result.id} ${result.tipo}${result.ok ? '' : ` — ${result.error ?? result.failures.join('; ')}`}`,
    );
  console.log(JSON.stringify(row, null, 2));
  await writeFile(
    join(RESULTS_DIR, `${stamp}-revision-${model.id.replace(/\//g, '_')}.json`),
    JSON.stringify({ row, results }, null, 2),
  );
}
await writeFile(join(RESULTS_DIR, `${stamp}-revision-comparacion.json`), JSON.stringify(summary, null, 2));
console.log(
  `\nGasto de la corrida: USD ${spent}${skipped > 0 ? ` · ${skipped} casos sin correr por el tope de --max-usd` : ''}`,
);
