import { Component, signal } from '@angular/core';
import type { DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthService, type AuthStatus } from './auth/auth.service';
import {
  FALLBACK_AFTER_FAILURES,
  HIDDEN_CLOSE_MS,
  RealtimeService,
  onInboxChanges,
  parseEvent,
  type InboxChanges,
  type InboxEvent,
} from './realtime';

const CONVERSATION = '01a1984f-28ac-7460-b6e0-f6dcb22cc56c';
const CHANNEL = '01a1984f-2181-74c2-9272-2b26d9232401';

/** EventSource falso: el test dispara los eventos a mano. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data = '{}') {
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent<string>);
  }
  static get last(): FakeEventSource {
    return FakeEventSource.instances.at(-1)!;
  }
}

const noDestroy = { onDestroy: () => () => undefined } as unknown as DestroyRef;

describe('RealtimeService', () => {
  let service: RealtimeService;
  let authStatus: AuthStatus;
  let visibility: DocumentVisibilityState;
  let online: boolean;
  const leaving = signal(false);

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    authStatus = 'ready';
    leaving.set(false);
    visibility = 'visible';
    online = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { load: vi.fn(() => Promise.resolve(authStatus)), leaving } },
      ],
    });
    service = TestBed.inject(RealtimeService);
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('se conecta al stream y queda en vivo con `ready`; reenvía los eventos válidos', () => {
    const events: InboxEvent[] = [];
    service.events$.subscribe((event) => events.push(event));
    service.start(noDestroy);
    expect(FakeEventSource.last.url).toBe('/api/events');
    expect(service.status()).toBe('connecting');
    FakeEventSource.last.emit('ready');
    expect(service.status()).toBe('live');
    FakeEventSource.last.emit(
      'message',
      JSON.stringify({ type: 'message.created', conversationId: CONVERSATION }),
    );
    FakeEventSource.last.emit('message', '{"type":"message.created","conversationId":"no-es-un-uuid"}');
    FakeEventSource.last.emit('message', 'no es json');
    expect(events).toEqual([{ type: 'message.created', conversationId: CONVERSATION }]);
  });

  it('si se corta, reconecta con espera y al volver emite resync (pudo perder eventos)', async () => {
    let resyncs = 0;
    service.resync$.subscribe(() => resyncs++);
    service.start(noDestroy);
    const first = FakeEventSource.last;
    first.emit('ready');
    expect(resyncs).toBe(0);
    first.emit('error');
    await vi.advanceTimersByTimeAsync(0);
    expect(first.closed).toBe(true);
    expect(service.status()).toBe('reconnecting');
    expect(FakeEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.last.emit('ready');
    expect(service.status()).toBe('live');
    expect(resyncs).toBe(1);
  });

  it('una falla antes de conectar sin sesión deja de reintentar y va al login', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    authStatus = 'anonymous';
    service.start(noDestroy);
    FakeEventSource.last.emit('error');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(navigate).toHaveBeenCalledWith(['/ingresar'], expect.anything());
    expect(service.status()).toBe('idle');
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it(`después de ${FALLBACK_AFTER_FAILURES} fallas seguidas pasa al refresco periódico y sigue reintentando`, async () => {
    service.start(noDestroy);
    for (let i = 0; i < FALLBACK_AFTER_FAILURES; i++) {
      FakeEventSource.last.emit('error');
      await vi.advanceTimersByTimeAsync(40_000);
    }
    expect(service.status()).toBe('fallback');
    expect(service.needsPolling()).toBe(true);
    FakeEventSource.last.emit('ready');
    expect(service.status()).toBe('live');
    expect(service.needsPolling()).toBe(false);
  });

  it('con la pestaña oculta cierra la conexión y al mostrarla vuelve a abrir', async () => {
    service.start(noDestroy);
    FakeEventSource.last.emit('ready');
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS - 1);
    expect(FakeEventSource.last.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.last.closed).toBe(true);
    expect(service.status()).toBe('paused');
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.last.closed).toBe(false);
  });

  it('sin red cierra y espera; al volver la red se reconecta', () => {
    service.start(noDestroy);
    FakeEventSource.last.emit('ready');
    online = false;
    window.dispatchEvent(new Event('offline'));
    expect(FakeEventSource.last.closed).toBe(true);
    expect(service.status()).toBe('offline');
    online = true;
    window.dispatchEvent(new Event('online'));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(service.status()).toBe('reconnecting');
  });

  it('`end` por reinicio del servidor reconecta; por sesión, consulta la sesión antes', async () => {
    service.start(noDestroy);
    FakeEventSource.last.emit('ready');
    FakeEventSource.last.emit('end', JSON.stringify({ reason: 'restart' }));
    await vi.advanceTimersByTimeAsync(1_300);
    expect(FakeEventSource.instances).toHaveLength(2);

    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    authStatus = 'forbidden';
    FakeEventSource.last.emit('end', JSON.stringify({ reason: 'forbidden' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(navigate).toHaveBeenCalledWith('/sin-acceso');
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});

describe('RealtimeService al cerrar sesión', () => {
  it('si el panel ya está saliendo (logout o cambio de empresa), el corte del stream no navega', async () => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    const leaving = signal(false);
    const load = vi.fn(() => Promise.resolve<AuthStatus>('anonymous'));
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: { load, leaving } }],
    });
    const service = TestBed.inject(RealtimeService);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    service.start(noDestroy);
    FakeEventSource.last.emit('ready');
    leaving.set(true);
    FakeEventSource.last.emit('end', JSON.stringify({ reason: 'unauthenticated' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.status()).toBe('idle');
    expect(navigate).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

describe('parseEvent', () => {
  it('acepta solo los tipos conocidos con un UUID y descarta cualquier campo extra', () => {
    expect(parseEvent(JSON.stringify({ type: 'channel.updated', channelId: CHANNEL, name: 'x' }))).toEqual({
      type: 'channel.updated',
      channelId: CHANNEL,
    });
    expect(parseEvent(JSON.stringify({ type: 'otro', conversationId: CONVERSATION }))).toBeNull();
    expect(parseEvent(JSON.stringify({ type: 'channel.updated', conversationId: CONVERSATION }))).toBeNull();
    expect(parseEvent('null')).toBeNull();
  });
});

describe('onInboxChanges', () => {
  it('junta los eventos seguidos en un solo llamado y marca la reconexión', async () => {
    vi.useFakeTimers();
    const calls: InboxChanges[] = [];
    @Component({ template: '' })
    class Host {
      constructor() {
        onInboxChanges((changes) => calls.push(changes), 300);
      }
    }
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { load: vi.fn(), leaving: signal(false) } },
      ],
    });
    const realtime = TestBed.inject(RealtimeService);
    const fixture = TestBed.createComponent(Host);
    realtime.events$.next({ type: 'message.created', conversationId: CONVERSATION });
    realtime.events$.next({ type: 'conversation.updated', conversationId: CONVERSATION });
    realtime.events$.next({ type: 'channel.updated', channelId: CHANNEL });
    await vi.advanceTimersByTimeAsync(299);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect([...calls[0]!.conversations]).toEqual([CONVERSATION]);
    expect([...calls[0]!.channels]).toEqual([CHANNEL]);
    expect(calls[0]!.resync).toBe(false);
    realtime.resync$.next();
    await vi.advanceTimersByTimeAsync(300);
    expect(calls[1]!.resync).toBe(true);
    fixture.destroy();
    realtime.events$.next({ type: 'message.created', conversationId: CONVERSATION });
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(2);
    vi.useRealTimers();
  });
});
