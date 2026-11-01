// Cliente SSE mínimo para los tests (fetch + lector del cuerpo): como EventSource, pero con la cookie que
// se le pase y acceso a todo lo que llega (eventos, latidos y el cierre).
import type { TestContext } from './helpers.js';

export interface SseMessage {
  event: string;
  data: string;
}

export class SseClient {
  readonly messages: SseMessage[] = [];
  /** Texto crudo recibido (para buscar datos personales en todo lo que mandó el servidor). */
  raw = '';
  pings = 0;
  closed = false;
  readonly done: Promise<void>;
  private readonly abort: AbortController;

  private constructor(
    readonly status: number,
    body: ReadableStream<Uint8Array> | null,
    abort: AbortController,
  ) {
    this.abort = abort;
    this.done = body ? this.read(body) : Promise.resolve();
  }

  /** Abre GET /api/events. Si no es 200, el cliente queda cerrado con ese status. */
  static async open(ctx: TestContext, cookie: string | null): Promise<SseClient> {
    const abort = new AbortController();
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(`${ctx.baseUrl}/api/events`, { headers, signal: abort.signal });
    if (response.status !== 200) {
      await response.arrayBuffer();
      const client = new SseClient(response.status, null, abort);
      client.closed = true;
      return client;
    }
    const client = new SseClient(200, response.body, abort);
    await client.waitFor((message) => message.event === 'ready');
    return client;
  }

  /** Los `data:` del evento por defecto (los InboxEvent), ya parseados. */
  get events(): Record<string, unknown>[] {
    return this.messages
      .filter((message) => message.event === 'message')
      .map((message) => JSON.parse(message.data) as Record<string, unknown>);
  }

  hasEventFor(id: string): boolean {
    return this.events.some((event) => event.conversationId === id || event.channelId === id);
  }

  /** Espera un mensaje que cumpla la condición (también mira los que ya llegaron). */
  async waitFor(match: (message: SseMessage) => boolean, timeoutMs = 5_000): Promise<SseMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(match);
      if (found) return found;
      if (this.closed) throw new Error('SseClient: el stream se cerró antes del mensaje esperado');
      if (Date.now() > deadline) throw new Error('SseClient: se venció el plazo');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  waitForEvent(id: string, timeoutMs = 5_000): Promise<SseMessage> {
    return this.waitFor((message) => {
      if (message.event !== 'message') return false;
      const event = JSON.parse(message.data) as Record<string, unknown>;
      return event.conversationId === id || event.channelId === id;
    }, timeoutMs);
  }

  /** Espera a que el servidor cierre el stream. */
  async waitClosed(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('SseClient: el stream sigue abierto');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  close(): void {
    this.abort.abort();
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.raw += text;
        buffer += text;
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          this.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
        }
      }
    } catch {
      // Abortado por el test o cortado por el servidor.
    } finally {
      this.closed = true;
    }
  }

  private parse(block: string): void {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        this.pings += 1;
      } else if (line.startsWith('event: ')) {
        event = line.slice(7);
      } else if (line.startsWith('data: ')) {
        data.push(line.slice(6));
      }
    }
    if (data.length > 0) this.messages.push({ event, data: data.join('\n') });
  }
}
