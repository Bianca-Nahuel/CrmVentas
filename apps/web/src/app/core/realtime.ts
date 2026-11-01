import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import type { ChannelEvent, ConversationEvent } from '../api/generated';
import { AuthService } from './auth/auth.service';
import { safeRedirect } from './auth/safe-redirect';

export type InboxEvent = ConversationEvent | ChannelEvent;

/**
 * idle: sin empezar o detenido · connecting: primera conexión · live: conectado · reconnecting: se cortó y
 * reintenta · offline: el navegador no tiene red · fallback: no logra conectar (varias fallas seguidas o
 * demasiadas pestañas abiertas): las pantallas vuelven al refresco de 30 s mientras sigue reintentando ·
 * paused: pestaña oculta (no hay conexión abierta).
 */
export type RealtimeStatus =
  'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline' | 'fallback' | 'paused';

export const STREAM_URL = '/api/events';
/** Esperas entre reintentos (la última se repite), con ±25 % al azar para que no reconecten todos juntos. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Fallas seguidas sin llegar a conectar después de las cuales se pasa al refresco de 30 s. */
export const FALLBACK_AFTER_FAILURES = 3;
/** Con la pestaña oculta, se cierra la conexión pasado este tiempo (cambiar de app un momento no corta). */
export const HIDDEN_CLOSE_MS = 10_000;

type EndReason = 'unauthenticated' | 'forbidden' | 'tenant_changed' | 'restart';

/**
 * Tiempo real de la bandeja (tarea 025): un EventSource a GET /api/events (mismo origen, la cookie viaja
 * sola). Los eventos traen solo el tipo y un id: cada pantalla vuelve a pedir lo que muestra por los
 * endpoints de siempre, que aplican la visibilidad.
 * - Reconexión propia con espera creciente (no la del navegador: un 401/403/429 no se distingue de un corte).
 *   Antes de conectar, una falla se chequea contra /api/me/context: sin sesión va al login.
 * - Al reconectar (y si el servidor manda `resync`) emite `resync$`: pudo perder eventos.
 * - Con la pestaña oculta cierra la conexión y la vuelve a abrir al mostrarla; sin red espera a `online`.
 * Lo arranca y lo detiene el layout. Nada de la sesión se guarda acá: es solo la cookie HttpOnly.
 */
@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private readonly document = inject(DOCUMENT);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly status = signal<RealtimeStatus>('idle');
  /** Las pantallas vuelven al refresco periódico mientras no hay tiempo real. */
  readonly needsPolling = computed(() => this.status() === 'fallback');
  readonly events$ = new Subject<InboxEvent>();
  readonly resync$ = new Subject<void>();

  private source: EventSource | null = null;
  private started = false;
  private everConnected = false;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onVisibility = () => this.visibilityChanged();
  private readonly onOnline = () => this.connectNow();
  private readonly onOffline = () => {
    this.close();
    this.status.set('offline');
  };

  /** Lo llama el layout (contexto de inyección): se detiene solo cuando el layout se destruye. */
  start(destroyRef = inject(DestroyRef)): void {
    if (this.started) return;
    this.started = true;
    this.everConnected = false;
    this.failures = 0;
    const view = this.document.defaultView;
    this.document.addEventListener('visibilitychange', this.onVisibility);
    view?.addEventListener('online', this.onOnline);
    view?.addEventListener('offline', this.onOffline);
    destroyRef.onDestroy(() => this.stop());
    this.connectNow();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    const view = this.document.defaultView;
    this.document.removeEventListener('visibilitychange', this.onVisibility);
    view?.removeEventListener('online', this.onOnline);
    view?.removeEventListener('offline', this.onOffline);
    clearTimeout(this.hiddenTimer);
    this.close();
    this.status.set('idle');
  }

  /** "Reintentar" del indicador: conecta ya y, al conectar, las pantallas vuelven a consultar. */
  retryNow(): void {
    if (!this.started) return;
    this.failures = 0;
    this.connectNow();
    this.resync$.next();
  }

  private connectNow(): void {
    if (!this.started) return;
    clearTimeout(this.retryTimer);
    if (this.document.visibilityState === 'hidden') {
      this.status.set('paused');
      return;
    }
    if (this.document.defaultView?.navigator.onLine === false) {
      this.status.set('offline');
      return;
    }
    this.close();
    if (this.status() !== 'fallback') this.status.set(this.everConnected ? 'reconnecting' : 'connecting');

    const source = new EventSource(STREAM_URL);
    this.source = source;
    let opened = false;
    source.addEventListener('ready', () => {
      opened = true;
      this.failures = 0;
      this.status.set('live');
      if (this.everConnected) this.resync$.next();
      this.everConnected = true;
    });
    source.addEventListener('message', (message: MessageEvent<string>) => {
      const event = parseEvent(message.data);
      if (event) this.events$.next(event);
    });
    source.addEventListener('resync', () => this.resync$.next());
    source.addEventListener('end', (message: MessageEvent<string>) => {
      this.close();
      void this.ended(parseEnd(message.data));
    });
    source.addEventListener('error', () => {
      if (this.source !== source) return;
      this.close();
      void this.failed(opened);
    });
  }

  private async ended(reason: EndReason | null): Promise<void> {
    if (this.auth.leaving()) return this.stop();
    if (reason === 'tenant_changed') {
      // Cambió la empresa activa (otra pestaña): igual que al cambiar de empresa acá, se carga de nuevo el
      // panel desde el inicio (decisión #69).
      this.stop();
      this.document.defaultView?.location.assign('/');
      return;
    }
    if (reason === 'unauthenticated' || reason === 'forbidden') {
      if (!(await this.sessionStillValid())) return;
    }
    this.scheduleRetry();
  }

  private async failed(wasOpen: boolean): Promise<void> {
    if (!this.started) return;
    if (this.auth.leaving()) return this.stop();
    if (this.document.defaultView?.navigator.onLine === false) {
      this.status.set('offline');
      return;
    }
    // No llegó a conectar: puede ser 401/403 (EventSource no da el status). Se pregunta por la sesión.
    if (!wasOpen && !(await this.sessionStillValid())) return;
    this.failures += 1;
    this.status.set(this.failures >= FALLBACK_AFTER_FAILURES ? 'fallback' : 'reconnecting');
    this.scheduleRetry();
  }

  /** false si la sesión ya no sirve: se detiene y se va a la pantalla que corresponde. */
  private async sessionStillValid(): Promise<boolean> {
    const status = await this.auth.load();
    if (status === 'ready' || status === 'offline') return true;
    if (!this.started || this.auth.leaving()) {
      this.stop();
      return false;
    }
    this.stop();
    if (status === 'anonymous') {
      const redirect = safeRedirect(this.router.url);
      void this.router.navigate(['/ingresar'], { queryParams: redirect === '/' ? {} : { redirect } });
    } else if (status === 'no-tenant') {
      void this.router.navigateByUrl('/elegir-empresa');
    } else {
      void this.router.navigateByUrl('/sin-acceso');
    }
    return false;
  }

  private scheduleRetry(): void {
    if (!this.started) return;
    clearTimeout(this.retryTimer);
    // La primera falla espera lo mínimo; cada falla seguida, el escalón siguiente.
    const step = Math.min(Math.max(this.failures - 1, 0), RECONNECT_DELAYS_MS.length - 1);
    const base = RECONNECT_DELAYS_MS[step]!;
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.retryTimer = setTimeout(() => this.connectNow(), delay);
  }

  private visibilityChanged(): void {
    if (!this.started) return;
    clearTimeout(this.hiddenTimer);
    if (this.document.visibilityState === 'hidden') {
      this.hiddenTimer = setTimeout(() => {
        clearTimeout(this.retryTimer);
        this.close();
        this.status.set('paused');
      }, HIDDEN_CLOSE_MS);
    } else if (!this.source) {
      this.connectNow();
    }
  }

  private close(): void {
    this.source?.close();
    this.source = null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION_TYPES = new Set([
  'message.created',
  'message.updated',
  'conversation.updated',
  'conversation.read',
]);

/** Solo lo esperado: cualquier otra cosa se descarta. */
export function parseEvent(data: string): InboxEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const { type, conversationId, channelId } = value as Record<string, unknown>;
  if (typeof type !== 'string') return null;
  if (CONVERSATION_TYPES.has(type) && typeof conversationId === 'string' && UUID.test(conversationId)) {
    return { type: type as ConversationEvent['type'], conversationId };
  }
  if (type === 'channel.updated' && typeof channelId === 'string' && UUID.test(channelId)) {
    return { type, channelId };
  }
  return null;
}

function parseEnd(data: string): EndReason | null {
  try {
    const reason = (JSON.parse(data) as { reason?: unknown }).reason;
    return reason === 'unauthenticated' ||
      reason === 'forbidden' ||
      reason === 'tenant_changed' ||
      reason === 'restart'
      ? reason
      : null;
  } catch {
    return null;
  }
}

/** Cambios juntados durante la espera: qué conversaciones y números se tocaron, y si hay que reconsultar. */
export interface InboxChanges {
  resync: boolean;
  conversations: ReadonlySet<string>;
  channels: ReadonlySet<string>;
  /** Tipos de evento que llegaron (por ejemplo, para ignorar los que son solo `conversation.read`). */
  types: ReadonlySet<InboxEvent['type']>;
}

/**
 * Llama a `handler` con los cambios juntados cada `delayMs` (un mensaje dispara varios eventos seguidos:
 * entrante, puntaje, respuesta en cola). Se corta al destruirse quien lo llamó. Contexto de inyección.
 */
export function onInboxChanges(handler: (changes: InboxChanges) => void, delayMs = 300): void {
  const realtime = inject(RealtimeService);
  let pending: {
    resync: boolean;
    conversations: Set<string>;
    channels: Set<string>;
    types: Set<InboxEvent['type']>;
  } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    const changes = pending;
    pending = null;
    if (changes) handler(changes);
  };
  const add = (fn: (p: NonNullable<typeof pending>) => void) => {
    pending ??= { resync: false, conversations: new Set(), channels: new Set(), types: new Set() };
    fn(pending);
    clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  };
  const events = realtime.events$.subscribe((event) =>
    add((p) => {
      p.types.add(event.type);
      if ('conversationId' in event) p.conversations.add(event.conversationId);
      else p.channels.add(event.channelId);
    }),
  );
  const resyncs = realtime.resync$.subscribe(() => add((p) => (p.resync = true)));
  inject(DestroyRef).onDestroy(() => {
    events.unsubscribe();
    resyncs.unsubscribe();
    clearTimeout(timer);
  });
}
