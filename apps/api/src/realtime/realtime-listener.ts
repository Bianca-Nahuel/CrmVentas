import { EventEmitter } from 'node:events';
import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { INBOX_EVENTS_CHANNEL, noticeSchema, type Notice } from './publish.js';

// Esperas entre intentos de reconexión (la última se repite).
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000];
// Cada cuánto se prueba la conexión: una conexión muerta en silencio (red caída sin RST) no avisa sola.
const PING_INTERVAL_MS = 30_000;

export interface ListenerEvents {
  notice: [Notice];
  /** Volvió a escuchar después de un corte: los avisos de ese rato se perdieron. */
  resync: [];
}

/**
 * UNA conexión dedicada por instancia de la API (fuera del pool, como ventas_app) con LISTEN inbox_events.
 * Postgres manda cada aviso a todas las instancias que escuchan: así funciona con varias instancias sin un
 * broker. Si la conexión se cae, reintenta con espera creciente y, al volver, emite `resync` para que los
 * streams le pidan al panel que vuelva a consultar.
 * Logs sin el contenido de los avisos (solo ids, pero igual no hace falta).
 */
@Injectable()
export class RealtimeListener
  extends EventEmitter<ListenerEvents>
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger('RealtimeListener');
  private client: pg.Client | null = null;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private everConnected = false;

  constructor(@Inject(ENV) private readonly env: Env) {
    super();
    this.setMaxListeners(0);
  }

  async onModuleInit(): Promise<void> {
    // La primera conexión se espera: si la base no está, la app no levanta (igual que pg-boss).
    await this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  get connected(): boolean {
    return this.client !== null;
  }

  /** Solo para los tests: corta la conexión como si se cayera la red. */
  simulateDrop(): void {
    const client = this.client as (pg.Client & { connection?: { stream?: { destroy(): void } } }) | null;
    client?.connection?.stream?.destroy();
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.env.DATABASE_URL,
      application_name: 'ventas-realtime',
      keepAlive: true,
    });
    client.on('notification', (message) => this.onNotification(message));
    client.on('error', (error) => this.onLost(client, error));
    client.on('end', () => this.onLost(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${INBOX_EVENTS_CHANNEL}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    this.client = client;
    this.attempt = 0;
    this.pingTimer = setInterval(() => {
      client.query('SELECT 1').catch((error: Error) => this.onLost(client, error));
    }, PING_INTERVAL_MS);
    this.pingTimer.unref();
    if (this.everConnected) {
      this.logger.log({ msg: 'realtime', result: 'reconectado' });
      this.emit('resync');
    }
    this.everConnected = true;
  }

  private onNotification(message: pg.Notification): void {
    if (message.channel !== INBOX_EVENTS_CHANNEL || !message.payload) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.payload);
    } catch {
      this.logger.warn({ msg: 'realtime', result: 'aviso_invalido' });
      return;
    }
    const notice = noticeSchema.safeParse(parsed);
    if (!notice.success) {
      this.logger.warn({ msg: 'realtime', result: 'aviso_invalido' });
      return;
    }
    this.emit('notice', notice.data);
  }

  private onLost(client: pg.Client, error?: Error): void {
    if (this.client !== client) return; // ya se manejó (error y end llegan los dos)
    this.client = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    client.removeAllListeners('notification');
    client.end().catch(() => undefined);
    if (this.stopped) return;
    this.logger.warn({ msg: 'realtime', result: 'conexion_perdida', code: errorCodeOf(error) });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error: Error) => {
        this.logger.warn({ msg: 'realtime', result: 'reconexion_fallida', code: errorCodeOf(error) });
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref();
  }
}

function errorCodeOf(error: Error | undefined): string | undefined {
  if (!error) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error.name;
}
