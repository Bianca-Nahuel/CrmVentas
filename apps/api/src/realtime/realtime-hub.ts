import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AuthService } from '@thallesp/nestjs-better-auth';
import { roleCan, type TenantPermission } from '@ventas/shared';
import type { Response } from 'express';
import type { Auth } from '../auth/auth.js';
import type { AuthSession } from '../auth/request.js';
import { loadMembership } from '../auth/tenant.guard.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { APP_DB, type AppDatabase } from '../db/database.module.js';
import { withTenantTransaction, type TenantContext } from '../db/tenant-context.js';
import { ConversationScope, type Scope } from '../inbox/conversation-scope.js';
import type { InboxEvent, StreamEndReason } from './events.contracts.js';
import { sessionHash, type Notice } from './publish.js';
import { RealtimeListener } from './realtime-listener.js';

/** Tope de streams por instancia, aparte del límite por usuario: protege la memoria y los sockets. */
export const MAX_STREAMS_PER_INSTANCE = 1000;
// Un cliente que no lee (pestaña colgada, red lenta) acumula bytes en el socket: pasado este tope se le
// corta el stream y, al reconectar, vuelve a consultar.
const MAX_BUFFERED_BYTES = 64 * 1024;
// Revalidaciones en paralelo en la vuelta periódica: con muchos streams, de a uno tardaría más que el
// intervalo; todos a la vez saturarían los pools (auth tiene 5 conexiones).
const REVALIDATE_CONCURRENCY = 4;
// Permiso que pide el stream (el mismo que el detalle de una conversación); lo usa también el controller.
export const STREAM_PERMISSION: TenantPermission = { conversation: ['read'] };

interface Stream {
  id: number;
  userId: string;
  tenantId: string;
  role: string;
  sessionId: string;
  sessionHash: string;
  /** Solo el header Cookie, para revalidar la sesión con Better Auth. Nunca se loguea. */
  cookie: string;
  scope: Scope;
  response: Response;
  closed: boolean;
  revalidating: Promise<void> | null;
  revalidateAgain: boolean;
}

/**
 * Streams SSE abiertos en esta instancia. Recibe los avisos de RealtimeListener y le manda a cada stream
 * solo los que puede ver:
 *   - la empresa del aviso tiene que ser la activa del stream;
 *   - el número (canal) tiene que estar en su scope, calculado con ConversationScope (la regla de la 014);
 *   - `conversation.read` va solo a los streams de quien la leyó.
 * Al navegador le llega `{ type, conversationId }` (o `{ type, channelId }`): nada de texto ni datos
 * personales.
 *
 * Revalidación (sesión viva y con la misma empresa activa, membresía y empresa activas, permiso y scope):
 *   - cada REALTIME_REVALIDATE_SECONDS, todos;
 *   - al instante con un aviso access (asignaciones de la empresa), user (logout, revocar sesiones, cambiar
 *     de empresa) o session (una sesión puntual).
 * Si algo no da, manda `event: end` con el motivo y cierra.
 */
@Injectable()
export class RealtimeHub implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('RealtimeHub');
  private readonly byTenant = new Map<string, Set<Stream>>();
  private readonly all = new Set<Stream>();
  private nextId = 1;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private revalidateTimer: NodeJS.Timeout | null = null;
  private revalidatingAll = false;
  /** Lugares reservados por streams que se están abriendo (todavía calculando el scope), por usuario. */
  private readonly opening = new Map<string, number>();
  private openingTotal = 0;
  /** Cuenta los avisos de acceso (access, user, session): si llega uno mientras un stream se abre, se revalida. */
  private accessNotices = 0;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(APP_DB) private readonly database: AppDatabase,
    private readonly authService: AuthService<Auth>,
    private readonly scopes: ConversationScope,
    private readonly listener: RealtimeListener,
  ) {}

  onApplicationBootstrap(): void {
    this.listener.on('notice', (notice) => this.dispatch(notice));
    // Se perdieron avisos: el panel vuelve a consultar y acá se revalida todo (pudo perderse un logout o una
    // asignación quitada).
    this.listener.on('resync', () => {
      this.broadcastResync();
      void this.revalidateAll();
    });
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.env.REALTIME_HEARTBEAT_SECONDS * 1000);
    this.heartbeatTimer.unref();
    this.revalidateTimer = setInterval(
      () => void this.revalidateAll(),
      this.env.REALTIME_REVALIDATE_SECONDS * 1000,
    );
    this.revalidateTimer.unref();
  }

  /** Antes de cerrar el servidor HTTP: si no, los streams abiertos frenan el apagado. */
  onModuleDestroy(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.revalidateTimer) clearInterval(this.revalidateTimer);
    for (const stream of [...this.all]) this.end(stream, 'restart');
  }

  /** Cuántos streams tiene el usuario en esta instancia (abiertos o abriéndose). */
  countFor(userId: string): number {
    let count = this.opening.get(userId) ?? 0;
    for (const stream of this.all) if (stream.userId === userId) count += 1;
    return count;
  }

  /**
   * Abre un stream para un request que ya pasó por TenantGuard, o responde 429 si el usuario o la instancia
   * llegaron al límite. El lugar se reserva antes de cualquier await: pedidos en paralelo no pasan el límite.
   */
  async open(
    session: AuthSession,
    context: TenantContext,
    cookie: string,
    response: Response,
  ): Promise<void> {
    const rejected =
      this.all.size + this.openingTotal >= MAX_STREAMS_PER_INSTANCE
        ? 'SERVER_BUSY'
        : this.countFor(context.userId) >= this.env.REALTIME_MAX_STREAMS_PER_USER
          ? 'TOO_MANY_STREAMS'
          : null;
    if (rejected) {
      response.status(429).json({ statusCode: 429, code: rejected });
      return;
    }
    this.opening.set(context.userId, (this.opening.get(context.userId) ?? 0) + 1);
    this.openingTotal += 1;
    const noticesAtStart = this.accessNotices;
    // El navegador puede cortar mientras se calcula el scope (recargar, navegar): ese `close` llega antes de
    // registrar el stream y, sin esto, quedaría contado para siempre (y a los N el usuario recibe 429).
    let gone = false;
    const onEarlyClose = () => (gone = true);
    response.once('close', onEarlyClose);
    let scope: Scope;
    try {
      scope = await this.resolveScope(context);
    } finally {
      response.off('close', onEarlyClose);
      const left = (this.opening.get(context.userId) ?? 1) - 1;
      if (left > 0) this.opening.set(context.userId, left);
      else this.opening.delete(context.userId);
      this.openingTotal -= 1;
    }
    if (gone || response.destroyed) return;
    const stream: Stream = {
      id: this.nextId++,
      userId: context.userId,
      tenantId: context.tenantId,
      role: context.role,
      sessionId: session.session.id,
      sessionHash: sessionHash(session.session.token),
      cookie,
      scope,
      response,
      closed: false,
      revalidating: null,
      revalidateAgain: false,
    };

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // no-transform: que ningún proxy lo comprima ni lo junte. X-Accel-Buffering: sin buffer en nginx.
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
    response.socket?.setNoDelay(true);
    response.socket?.setTimeout(0);

    this.all.add(stream);
    let set = this.byTenant.get(stream.tenantId);
    if (!set) this.byTenant.set(stream.tenantId, (set = new Set()));
    set.add(stream);
    response.on('close', () => this.remove(stream));

    // `ready` le dice al panel que quedó conectado (y que vuelva a consultar si era una reconexión).
    this.write(stream, 'event: ready\ndata: {}\n\n');
    // Un aviso de acceso (número quitado, sesión cerrada) que llegó mientras se abría no lo vio este stream.
    if (this.accessNotices !== noticesAtStart) void this.revalidate(stream);
  }

  /** Revalida todos los streams (lo llama el timer; los tests lo llaman directo). */
  async revalidateAll(): Promise<void> {
    if (this.revalidatingAll) return;
    this.revalidatingAll = true;
    try {
      const queue = [...this.all];
      const worker = async () => {
        for (let stream = queue.shift(); stream; stream = queue.shift()) await this.revalidate(stream);
      };
      await Promise.all(Array.from({ length: REVALIDATE_CONCURRENCY }, worker));
    } finally {
      this.revalidatingAll = false;
    }
  }

  private dispatch(notice: Notice): void {
    switch (notice.kind) {
      case 'conversation': {
        const event: InboxEvent = { type: notice.type, conversationId: notice.conversationId };
        for (const stream of this.byTenant.get(notice.tenantId) ?? []) {
          if (!sees(stream.scope, notice.channelId)) continue;
          if (notice.type === 'conversation.read' && notice.userId !== stream.userId) continue;
          this.send(stream, event);
        }
        return;
      }
      case 'channel': {
        const event: InboxEvent = { type: 'channel.updated', channelId: notice.channelId };
        for (const stream of this.byTenant.get(notice.tenantId) ?? []) {
          if (sees(stream.scope, notice.channelId)) this.send(stream, event);
        }
        return;
      }
      case 'access':
        this.accessNotices += 1;
        for (const stream of [...(this.byTenant.get(notice.tenantId) ?? [])]) void this.revalidate(stream);
        return;
      case 'user':
        this.accessNotices += 1;
        for (const stream of [...this.all]) if (stream.userId === notice.userId) void this.revalidate(stream);
        return;
      case 'session':
        this.accessNotices += 1;
        for (const stream of [...this.all]) {
          if (stream.sessionHash === notice.sessionHash) void this.revalidate(stream);
        }
        return;
    }
  }

  /** Revalida un stream. Si ya se está revalidando, lo repite al terminar (pudo cambiar algo en el medio). */
  private revalidate(stream: Stream): Promise<void> {
    if (stream.closed) return Promise.resolve();
    if (stream.revalidating) {
      stream.revalidateAgain = true;
      return stream.revalidating;
    }
    stream.revalidating = (async () => {
      do {
        stream.revalidateAgain = false;
        await this.revalidateOnce(stream);
      } while (stream.revalidateAgain && !stream.closed);
    })().finally(() => {
      stream.revalidating = null;
    });
    return stream.revalidating;
  }

  private async revalidateOnce(stream: Stream): Promise<void> {
    try {
      const session = await this.authService.api.getSession({
        headers: new Headers({ cookie: stream.cookie }),
      });
      if (!session || session.session.id !== stream.sessionId) return this.end(stream, 'unauthenticated');
      if (session.session.activeOrganizationId !== stream.tenantId) return this.end(stream, 'tenant_changed');

      const membership = await loadMembership(this.database, stream.userId, stream.tenantId);
      if (
        !membership ||
        membership.status !== 'active' ||
        membership.tenantStatus !== 'active' ||
        !roleCan(membership.role, STREAM_PERMISSION)
      ) {
        return this.end(stream, 'forbidden');
      }
      const scope = await this.resolveScope({
        userId: stream.userId,
        tenantId: stream.tenantId,
        role: membership.role,
      });
      if (stream.closed) return;
      stream.role = membership.role;
      stream.scope = scope;
    } catch (error) {
      // Base o Better Auth con problemas: se deja el stream como está y se reintenta en la próxima vuelta.
      this.logger.warn({
        msg: 'realtime',
        streamId: stream.id,
        result: 'revalidacion_fallida',
        code: codeOf(error),
      });
    }
  }

  private resolveScope(context: TenantContext): Promise<Scope> {
    return withTenantTransaction(
      this.database.db,
      { tenantId: context.tenantId, userId: context.userId },
      (tx) => this.scopes.resolve(tx, context),
    );
  }

  private broadcastResync(): void {
    for (const stream of this.all) this.write(stream, 'event: resync\ndata: {}\n\n');
  }

  private heartbeat(): void {
    for (const stream of [...this.all]) this.write(stream, ': ping\n\n');
  }

  private send(stream: Stream, event: InboxEvent): void {
    this.write(stream, `data: ${JSON.stringify(event)}\n\n`);
  }

  private end(stream: Stream, reason: StreamEndReason): void {
    if (stream.closed) return;
    this.write(stream, `event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
    this.remove(stream);
    stream.response.end();
  }

  private write(stream: Stream, chunk: string): void {
    if (stream.closed) return;
    if (stream.response.writableLength > MAX_BUFFERED_BYTES) {
      this.remove(stream);
      stream.response.destroy();
      return;
    }
    stream.response.write(chunk);
  }

  private remove(stream: Stream): void {
    if (stream.closed) return;
    stream.closed = true;
    this.all.delete(stream);
    const set = this.byTenant.get(stream.tenantId);
    set?.delete(stream);
    if (set?.size === 0) this.byTenant.delete(stream.tenantId);
  }
}

function sees(scope: Scope, channelId: string): boolean {
  return scope.all || scope.channelIds.includes(channelId);
}

function codeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error.name;
}
