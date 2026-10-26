// Cliente de OpenRouter (Chat Completions). Lo único de la app que conoce su API.
// Docs: https://openrouter.ai/docs/guides/features/structured-outputs ,
// .../routing/provider-selection , .../administration/usage-accounting , .../features/tool-calling ,
// https://openrouter.ai/docs/api/reference/errors-and-debugging (consultadas el 2026-10-25).
import { findAllowedModel } from '@ventas/shared';
import { LLM_CALL_TIMEOUT_MS, LLM_TURN_TIMEOUT_MS, MAX_TOOL_CALLS_PER_TURN } from '../../../ai.constants.js';
import { jsonForPrompt } from '../../json-for-prompt.js';
import {
  LlmError,
  type CostSource,
  type LlmClient,
  type LlmErrorKind,
  type LlmRequest,
  type LlmResult,
  type LlmToolCallRecord,
  type LlmUsage,
} from '../../llm-client.js';
import { addUsd, tokensCostUsd, usdFromNumber } from '../../money.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_RETRY_WAIT_MS = 5_000;

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  callTimeoutMs?: number;
  turnTimeoutMs?: number;
}

// Preferencias de proveedor de cada llamada:
// - require_parameters: solo endpoints que soportan TODO lo pedido (response_format con json_schema,
//   tools). Sin esto, OpenRouter puede elegir uno que tome el schema como sugerencia.
// - data_collection 'deny' + zdr: solo proveedores que no guardan ni entrenan con los datos.
// parallel_tool_calls no se manda nunca: los endpoints de Anthropic no lo listan y, con
// require_parameters, dejaría cero proveedores.
const PROVIDER_PREFERENCES = { require_parameters: true, data_collection: 'deny', zdr: true } as const;

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatResponse {
  model?: string;
  error?: { code?: number | string; message?: string };
  choices?: {
    finish_reason?: string | null;
    error?: { code?: number | string };
    message?: { content?: string | null; tool_calls?: ChatToolCall[] };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export class OpenRouterClient implements LlmClient {
  readonly provider = 'openrouter' as const;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly callTimeoutMs: number;
  private readonly turnTimeoutMs: number;

  constructor(private readonly options: OpenRouterOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.callTimeoutMs = options.callTimeoutMs ?? LLM_CALL_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? LLM_TURN_TIMEOUT_MS;
  }

  async complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    const started = Date.now();
    const deadline = started + this.turnTimeoutMs;
    const tools = request.tools ?? [];
    const maxToolCalls = request.maxToolCalls ?? MAX_TOOL_CALLS_PER_TURN;
    const messages: ChatMessage[] = [{ role: 'system', content: request.system }, ...request.messages];
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    const costs: string[] = [];
    let costSource: CostSource = 'provider';
    let respondedModel = request.model;
    const toolCalls: LlmToolCallRecord[] = [];

    const charged = () => ({
      usage: { ...usage },
      costUsd: addUsd('0', ...costs),
      costSource,
      model: respondedModel,
      latencyMs: Date.now() - started,
    });
    const fail = (kind: LlmErrorKind, detail?: string): never => {
      throw new LlmError(kind, false, costs.length > 0 ? charged() : undefined, detail);
    };

    for (;;) {
      const toolsExhausted = toolCalls.length >= maxToolCalls;
      const body = {
        model: request.model,
        messages,
        max_tokens: request.maxOutputTokens,
        // exclude: el razonamiento no vuelve en la respuesta (no se usa y es más texto del cliente dando vueltas).
        ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort, exclude: true } } : {}),
        response_format: {
          type: 'json_schema',
          json_schema: { name: request.schema.name, strict: true, schema: request.schema.jsonSchema },
        },
        provider: PROVIDER_PREFERENCES,
        ...(tools.length > 0
          ? {
              tools: tools.map((tool) => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.parameters },
              })),
              tool_choice: toolsExhausted ? 'none' : 'auto',
            }
          : {}),
      };

      const response = await this.post(body, deadline, costs.length > 0 ? charged : undefined);
      respondedModel = response.model ?? respondedModel;
      const callUsage = {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      };
      usage.inputTokens += callUsage.inputTokens;
      usage.outputTokens += callUsage.outputTokens;
      if (typeof response.usage?.cost === 'number') {
        costs.push(usdFromNumber(response.usage.cost));
      } else {
        // Sin costo informado: se estima con la tabla de precios (y queda marcado así).
        costSource = 'estimated';
        costs.push(estimateCost(request.model, callUsage));
      }

      const choice = response.choices?.[0];
      // Error dentro de un 200 (después de que el proveedor aceptó el pedido).
      if (!choice || response.error || choice.error || choice.finish_reason === 'error') fail('unavailable');
      const finish = choice!.finish_reason;
      const calls = choice!.message?.tool_calls ?? [];

      if (finish === 'tool_calls' || calls.length > 0) {
        if (tools.length === 0 || toolsExhausted || calls.length === 0) fail('invalid_output');
        messages.push({ role: 'assistant', content: choice!.message?.content ?? null, tool_calls: calls });
        for (const call of calls) {
          const outcome = await this.runTool(tools, call, toolCalls.length >= maxToolCalls);
          toolCalls.push(outcome.record);
          messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.content });
        }
        continue;
      }
      if (finish === 'length') fail('truncated');
      if (finish === 'content_filter') fail('moderated');
      if (finish !== 'stop' && finish !== null && finish !== undefined) fail('unavailable');

      const content = choice!.message?.content;
      if (typeof content !== 'string') fail('invalid_output', 'sin contenido');
      let raw: unknown;
      try {
        raw = JSON.parse(content!);
      } catch {
        fail('invalid_output', 'json roto');
      }
      const parsed = request.schema.zod.safeParse(raw);
      if (!parsed.success) {
        fail(
          'invalid_output',
          parsed.error.issues.map((issue) => `${issue.path.join('.') || '(raíz)'}:${issue.code}`).join(', '),
        );
      }

      return {
        parsed: parsed.data as T,
        usage,
        costUsd: addUsd('0', ...costs),
        costSource,
        provider: this.provider,
        model: respondedModel,
        latencyMs: Date.now() - started,
        toolCalls,
      };
    }
  }

  private async runTool(
    tools: NonNullable<LlmRequest<unknown>['tools']>,
    call: ChatToolCall,
    overLimit: boolean,
  ): Promise<{ record: LlmToolCallRecord; content: string }> {
    const started = Date.now();
    const tool = tools.find((candidate) => candidate.name === call.function.name);
    const done = (ok: boolean, result: unknown) => ({
      record: { name: tool ? tool.name : 'unknown', ok, latencyMs: Date.now() - started },
      content: jsonForPrompt(result),
    });
    if (!tool) return done(false, { error: 'unknown_tool' });
    if (overLimit) return done(false, { error: 'tool_call_limit' });
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return done(false, { error: 'invalid_arguments' });
    }
    const parsed = tool.args.safeParse(args);
    if (!parsed.success) return done(false, { error: 'invalid_arguments' });
    try {
      return done(true, await tool.execute(parsed.data));
    } catch {
      return done(false, { error: 'tool_failed' });
    }
  }

  /**
   * Un POST con un reintento ante errores transitorios (sin conexión, timeout, 408, 429, 5xx, también
   * dentro de un 200). Sin reintento ante 4xx. Nunca incluye el cuerpo ni el mensaje del proveedor en
   * el error.
   */
  private async post(
    body: unknown,
    deadline: number,
    charged: (() => NonNullable<LlmError['charged']>) | undefined,
  ): Promise<ChatResponse> {
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new LlmError('timeout', true, charged?.());
      let status: number;
      let retryAfterMs: number | null;
      let json: ChatResponse | null;
      try {
        const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(this.callTimeoutMs, remaining)),
        });
        status = response.status;
        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        try {
          json = (await response.json()) as ChatResponse;
        } catch {
          json = null;
        }
        // Error con HTTP 200 sin choices: el código del error manda.
        if (status === 200 && json?.error && !json.choices?.length) status = errorStatus(json.error.code);
      } catch (error) {
        const timedOut = (error as { name?: string }).name === 'TimeoutError';
        if (attempt === 0 && Date.now() < deadline) {
          await this.sleep(1_000);
          continue;
        }
        throw new LlmError(timedOut ? 'timeout' : 'unavailable', true, charged?.());
      }

      if (status === 200 && json) return json;
      const kind = statusKind(status);
      const retryable =
        kind === 'timeout' || kind === 'rate_limited' || kind === 'unavailable' || kind === 'no_provider';
      if (retryable && attempt === 0) {
        await this.sleep(Math.min(retryAfterMs ?? 1_000, MAX_RETRY_WAIT_MS));
        continue;
      }
      throw new LlmError(kind, retryable, charged?.());
    }
  }
}

function statusKind(status: number): LlmErrorKind {
  if (status === 401) return 'auth';
  if (status === 402) return 'quota';
  if (status === 403) return 'moderated';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'no_provider';
  if (status >= 500 || status === 200) return 'unavailable';
  return 'bad_request';
}

function errorStatus(code: number | string | undefined): number {
  const value = typeof code === 'string' ? Number.parseInt(code, 10) : code;
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value < 600 ? value : 502;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

function estimateCost(modelId: string, usage: LlmUsage): string {
  const model = findAllowedModel(modelId);
  if (!model) return '0';
  return addUsd(
    tokensCostUsd(usage.inputTokens, model.inputUsdPerMTok),
    tokensCostUsd(usage.outputTokens, model.outputUsdPerMTok),
  );
}
