import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ArrowDown, ArrowLeft, Bot, ChevronDown, FileQuestion, RotateCw, ShieldAlert } from 'lucide';
import { filter, switchMap } from 'rxjs';
import { InboxApi } from '../../api/inbox-api';
import type { ConversationDetail, Message } from '../../api/generated';
import { AuthService } from '../../core/auth/auth.service';
import { DOCUMENT } from '@angular/common';
import { InboxSummary } from '../../core/inbox-summary';
import { can } from '../../core/nav';
import { pollWhileNoRealtime } from '../../core/poll';
import { query } from '../../core/query';
import { onInboxChanges } from '../../core/realtime';
import { ConfirmService } from '../../ui/confirm-dialog';
import { Icon } from '../../ui/icon';
import { Score } from '../../ui/score';
import { NotifyService } from '../../ui/toast';
import {
  AI_STATE_LABELS,
  REPLY_BLOCKED_TEXT,
  REPLY_CONFLICT_CODES,
  deliveryHelp,
  MESSAGE_TYPE_LABELS,
  SENDER_LABELS,
  contactName,
  fullWhen,
  groupByDay,
  reasonLabel,
  timeLabel,
} from './format';
import { DeliveryStatus } from './delivery-status';
import { InboxReads } from './inbox-reads';
import { ReplyBox } from './reply-box';

const DESKTOP = '(min-width: 1024px)';

/**
 * Conversación (tarea 014) con la respuesta desde el panel (024). Todo lo que viene de WhatsApp y el
 * resumen de la IA son contenido no confiable: se muestran por interpolación (texto), sin links ni formato.
 * Tiempo real (025): los mensajes nuevos se suman abajo y los estados de los envíos se actualizan solos. Si
 * el usuario está leyendo más arriba, no se mueve nada y aparece "↓ N mensajes nuevos".
 */
@Component({
  selector: 'app-conversation-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, Score, ReplyBox, DeliveryStatus],
  host: { class: 'flex flex-col lg:h-full lg:min-h-0' },
  template: `
    <a class="btn btn-ghost btn-sm mb-3 self-start lg:hidden" routerLink="/conversaciones">
      <app-icon [icon]="backIcon" [size]="16" /> Volver
    </a>

    @if (notFound()) {
      <div class="card flex flex-col items-start gap-3 p-5 lg:m-4" data-testid="conversation-not-found">
        <app-icon [icon]="notFoundIcon" [size]="24" class="text-muted" />
        <h2 class="text-lg font-semibold text-text">Conversación no encontrada</h2>
        <p class="text-muted">No existe o es de un número que no tenés asignado.</p>
        <a class="btn btn-secondary btn-sm" routerLink="/conversaciones">Ir a la bandeja</a>
      </div>
    } @else if (detail.loadFailed()) {
      <div class="card flex flex-col items-start gap-3 p-5 lg:m-4">
        <p class="font-semibold text-text">No pudimos cargar la conversación.</p>
        <button type="button" class="btn btn-secondary btn-sm" (click)="refresh()">Reintentar</button>
      </div>
    } @else if (conversation(); as c) {
      <!--
        ≥ 1280 px: chat a la izquierda y, a la derecha, puntaje, resumen y datos (no tapan los mensajes).
        Entre 1024 y 1279 px no entran tres columnas: el resumen va arriba del chat, con alto acotado.
        Celular: todo apilado y el resumen desplegable.
      -->
      <div
        class="flex flex-col gap-3 lg:min-h-0 lg:flex-1 xl:grid xl:grid-cols-[minmax(0,1fr)_288px] xl:grid-rows-[auto_minmax(0,1fr)_auto] xl:gap-0"
      >
        <header
          class="flex flex-wrap items-start justify-between gap-3 border-border lg:border-b lg:px-5 lg:pt-4 lg:pb-3 xl:col-start-1 xl:row-start-1"
        >
          <div class="min-w-0">
            <h2 class="truncate text-xl font-semibold text-text" data-testid="conversation-title">
              {{ name(c) }}
            </h2>
            <p class="tabular text-sm text-muted">
              {{ c.contact.waId }} · {{ c.channel.name }} ({{ c.channel.phoneNumber }})
            </p>
          </div>
          <div class="flex items-center gap-2">
            <span
              class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold"
              [class]="
                c.ai.state === 'active' ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning'
              "
              data-testid="ai-state"
            >
              <app-icon [icon]="botIcon" [size]="15" /> {{ aiLabel(c) }}
            </span>
          </div>
        </header>

        <aside
          class="flex flex-col gap-3 lg:px-5 xl:col-start-2 xl:row-span-3 xl:row-start-1 xl:overflow-y-auto xl:border-l xl:border-border xl:p-4"
          aria-label="Datos del lead"
        >
          <app-score [score]="c.score" [level]="c.tier" variant="full" />
          @if (c.ai.lastReactivation; as r) {
            <p class="text-xs text-subtle">
              IA reactivada{{ r.byName ? ' por ' + r.byName : '' }} · {{ fullWhen(r.at) }}
            </p>
          }
          @if (c.ai.state !== 'active' && canReactivate()) {
            <button
              type="button"
              class="btn btn-primary btn-sm self-start xl:self-stretch"
              [disabled]="reactivating()"
              (click)="reactivate(c)"
            >
              Volver a activar la IA
            </button>
          }

          @if (c.handoff || c.ai.state === 'paused' || c.extractedData.length) {
            <details class="group card" [open]="openSummary" data-testid="handoff-panel">
              <summary
                class="flex cursor-pointer list-none items-center gap-2 p-3.5 [&::-webkit-details-marker]:hidden"
              >
                @if (c.handoff) {
                  <app-icon [icon]="alertIcon" [size]="18" class="shrink-0 text-warning" />
                  <span class="flex-1 font-semibold text-text">Resumen automático, no verificado</span>
                } @else {
                  <span class="flex-1 font-semibold text-text">Datos de la conversación</span>
                }
                <app-icon
                  [icon]="chevronIcon"
                  [size]="18"
                  class="text-muted transition-transform group-open:rotate-180"
                />
              </summary>
              <div
                class="flex flex-col gap-3 border-t border-border p-3.5 text-sm lg:max-h-44 lg:overflow-y-auto xl:max-h-none xl:overflow-visible"
              >
                @if (c.handoff; as h) {
                  <p class="text-subtle">
                    Lo escribió la IA a partir de lo que dijo el cliente: puede tener errores o datos
                    inventados. Confirmalo antes de actuar.
                  </p>
                  <dl class="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr] xl:grid-cols-1">
                    <dt class="font-semibold text-muted">Motivo</dt>
                    <dd class="text-text" data-testid="handoff-reason">{{ reason(h.reason) }}</dd>
                    <dt class="font-semibold text-muted">Derivada</dt>
                    <dd class="text-text">{{ fullWhen(h.at) }}</dd>
                  </dl>
                  @if (h.summary) {
                    <!-- textContent (texto plano, como la interpolación) sin espacios del template: pre-wrap los mostraría. -->
                    <p
                      class="rounded-md bg-surface-2 p-3 whitespace-pre-wrap break-words text-text"
                      data-testid="handoff-summary"
                      [textContent]="h.summary"
                    ></p>
                  }
                } @else if (c.ai.state === 'paused') {
                  <p class="text-muted">
                    Una persona del equipo respondió y la IA está pausada{{
                      c.ai.pausedUntil ? ' hasta ' + fullWhen(c.ai.pausedUntil) : ''
                    }}.
                  </p>
                }
                @if (c.extractedData.length) {
                  <div>
                    <p class="font-semibold text-muted">Datos obtenidos</p>
                    <dl class="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr] xl:grid-cols-1">
                      @for (item of c.extractedData; track item.key) {
                        <dt class="text-muted xl:mt-1">{{ item.label ?? item.key }}</dt>
                        <dd class="break-words text-text">{{ item.value }}</dd>
                      }
                    </dl>
                  </div>
                }
              </div>
            </details>
          }
        </aside>

        <div
          #chat
          class="flex flex-col-reverse lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-5 lg:pb-4 xl:col-start-1 xl:row-start-2 xl:pt-3"
          (scroll)="onChatScroll()"
        >
          <!-- En una columna invertida, lo primero queda abajo: la pastilla flota sobre el último mensaje. -->
          @if (unseenNew() > 0) {
            <div class="pointer-events-none sticky bottom-24 z-10 flex justify-center lg:bottom-2">
              <button
                type="button"
                class="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-sm font-semibold text-on-primary shadow-2"
                data-testid="new-messages"
                (click)="scrollToLatest()"
              >
                <app-icon [icon]="downIcon" [size]="15" /> {{ unseenText() }}
              </button>
            </div>
          }
          <div>
            @if (olderCursor()) {
              <div class="flex justify-center py-2">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  [disabled]="loadingOlder()"
                  (click)="loadOlder()"
                >
                  Cargar mensajes anteriores
                </button>
              </div>
            }
            <div role="log" aria-label="Mensajes" class="flex flex-col gap-2" data-testid="messages">
              @for (group of groups(); track group.key) {
                <div class="flex justify-center py-1.5">
                  <span
                    class="rounded-full bg-surface-2 px-3 py-0.5 text-xs font-semibold text-muted first-letter:uppercase"
                    >{{ group.label }}</span
                  >
                </div>
                @for (message of group.items; track message.id) {
                  <div
                    class="flex flex-col"
                    [class]="align(message)"
                    data-testid="message"
                    [attr.data-sender]="message.senderType"
                  >
                    <div class="max-w-[85%] rounded-lg px-3 py-2 sm:max-w-[75%]" [class]="bubble(message)">
                      <p
                        class="text-xs font-semibold"
                        [class]="message.senderType === 'contact' ? 'text-muted' : 'text-primary-strong'"
                      >
                        {{ sender(message) }}
                      </p>
                      @if (message.body) {
                        <p
                          class="whitespace-pre-wrap break-words text-text"
                          data-testid="message-body"
                          [textContent]="message.body"
                        ></p>
                      }
                      @if (message.type !== 'text') {
                        <p class="text-sm text-muted italic">
                          {{ typeLabel(message) }} (todavía no se puede ver en el panel)
                        </p>
                      }
                      <div class="mt-0.5 flex items-center justify-end gap-2">
                        <time
                          class="tabular text-[11px] text-subtle"
                          [attr.datetime]="message.sentAt"
                          [attr.title]="fullWhen(message.sentAt)"
                          >{{ time(message.sentAt) }}</time
                        >
                        @if (message.delivery; as d) {
                          <app-delivery-status [delivery]="d" />
                        }
                      </div>
                      @if (message.delivery; as d) {
                        @if (deliveryHelp(d); as help) {
                          <p class="mt-1 text-xs text-muted">{{ help }}</p>
                        }
                        @if (canRetry(message, c)) {
                          <button
                            type="button"
                            class="btn btn-secondary btn-sm mt-1.5"
                            data-testid="retry"
                            [disabled]="retrying() === message.id"
                            (click)="retry(message)"
                          >
                            <app-icon [icon]="retryIcon" [size]="15" /> Reintentar
                          </button>
                        }
                      }
                    </div>
                  </div>
                }
              } @empty {
                @if (firstPage.hasValue()) {
                  <p class="py-6 text-center text-muted">Todavía no hay mensajes.</p>
                } @else {
                  <p class="py-6 text-center text-muted">Cargando mensajes…</p>
                }
              }
            </div>
          </div>
        </div>

        @if (canReply()) {
          <!--
            Celular: fija abajo (sticky dentro de la página, que es la que hace scroll) y con el margen del
            área segura; el viewport se achica con el teclado (interactive-widget en index.html).
            Escritorio: al pie de la columna del chat.
          -->
          <app-reply-box
            class="sticky bottom-0 z-10 -mx-4 border-t border-border bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:bg-surface lg:px-5 lg:pb-4 xl:col-start-1 xl:row-start-3"
            [conversation]="c"
            (sent)="onSent($event)"
            (blocked)="detail.reload()"
          />
        }
      </div>
    } @else {
      <p class="p-5 text-muted">Cargando conversación…</p>
    }
  `,
})
export class ConversationPage {
  private readonly api = inject(InboxApi);
  private readonly auth = inject(AuthService);
  private readonly confirm = inject(ConfirmService);
  private readonly notify = inject(NotifyService);
  private readonly summary = inject(InboxSummary);
  private readonly reads = inject(InboxReads);
  private readonly document = inject(DOCUMENT);
  private readonly chat = viewChild<ElementRef<HTMLElement>>('chat');
  /** Mensajes que ya vio la pantalla (para contar los que llegan por el tiempo real) y de qué conversación. */
  private known: { id: string; ids: Set<string> } | null = null;
  /** Mensajes nuevos que llegaron mientras el usuario leía más arriba. */
  protected readonly unseenNew = signal(0);
  protected readonly unseenText = computed(() =>
    this.unseenNew() === 1 ? '1 mensaje nuevo' : `${this.unseenNew()} mensajes nuevos`,
  );
  /** Conversación y último mensaje del cliente ya marcados como vistos (para no repetir el pedido). */
  private markedKey = '';

  /** :id de la ruta (withComponentInputBinding). */
  readonly id = input.required<string>();

  protected readonly detail = query(
    () => this.id(),
    (id) => this.api.conversation(id),
  );
  protected readonly firstPage = query(
    () => this.id(),
    (id) => this.api.messages(id),
  );
  /** Páginas anteriores ya cargadas (del más viejo al más nuevo). Se vacían al cambiar de conversación. */
  private readonly older = signal<Message[]>([]);
  /** Cursor de lo ya cargado hacia atrás; undefined = todavía no se pidió nada anterior. */
  private readonly olderNext = signal<string | null | undefined>(undefined);
  protected readonly olderCursor = computed(() => {
    const next = this.olderNext();
    if (next !== undefined) return next;
    return this.firstPage.hasValue() ? this.firstPage.value().nextBefore : null;
  });
  protected readonly loadingOlder = signal(false);
  protected readonly reactivating = signal(false);
  /** Mensaje fallido que se está reenviando. */
  protected readonly retrying = signal<string | null>(null);
  /** Fallidos ya reenviados desde esta pantalla (el botón no se vuelve a ofrecer). */
  private readonly retried = signal<ReadonlySet<string>>(new Set());
  /** Clave del reintento de cada fallido, hasta que el servidor lo confirma. */
  private readonly retryKeys = new Map<string, string>();

  protected readonly conversation = computed<ConversationDetail | null>(() =>
    this.detail.hasValue() ? this.detail.value() : null,
  );
  protected readonly notFound = computed(() => {
    const error = this.detail.error();
    return error instanceof HttpErrorResponse && error.status === 404;
  });
  protected readonly groups = computed(() => {
    const first = this.firstPage.hasValue() ? this.firstPage.value().items : [];
    // El refresco puede correr la primera página sobre lo ya cargado: sin repetidos.
    const seen = new Set<string>();
    return groupByDay(
      [...this.older(), ...first].filter((m) => !seen.has(m.id) && seen.add(m.id) !== undefined),
    );
  });
  protected readonly canReply = computed(() => can(this.auth.role(), { conversation: ['reply'] }));
  protected readonly canReactivate = this.canReply;
  /** El resumen arranca abierto en el escritorio y cerrado en el celular. */
  protected readonly openSummary = globalThis.matchMedia?.(DESKTOP).matches ?? true;

  protected readonly backIcon = ArrowLeft;
  protected readonly botIcon = Bot;
  protected readonly alertIcon = ShieldAlert;
  protected readonly chevronIcon = ChevronDown;
  protected readonly notFoundIcon = FileQuestion;
  protected readonly downIcon = ArrowDown;
  protected readonly retryIcon = RotateCw;
  protected readonly deliveryHelp = deliveryHelp;
  protected readonly fullWhen = fullWhen;
  protected readonly time = timeLabel;
  protected readonly reason = reasonLabel;
  protected readonly name = (c: ConversationDetail) => contactName(c.contact);
  protected readonly aiLabel = (c: ConversationDetail) => AI_STATE_LABELS[c.ai.state];
  protected readonly typeLabel = (m: Message) => MESSAGE_TYPE_LABELS[m.type];
  protected readonly sender = (m: Message) =>
    m.senderType === 'user' && m.sentByName
      ? `${SENDER_LABELS.user} · ${m.sentByName}`
      : SENDER_LABELS[m.senderType];

  constructor() {
    effect(() => {
      this.id();
      untracked(() => {
        this.older.set([]);
        this.olderNext.set(undefined);
      });
    });
    // "Sin ver" es por persona: abrir la conversación (o que lleguen mensajes nuevos del cliente mientras
    // está abierta y la pestaña se ve) la marca como vista hasta ahora.
    effect(() => {
      if (!this.firstPage.hasValue()) return;
      const lastFromContact = this.firstPage
        .value()
        .items.filter((m) => m.senderType === 'contact')
        .at(-1);
      const key = `${this.id()}|${lastFromContact?.id ?? ''}`;
      untracked(() => {
        if (key === this.markedKey || this.document.visibilityState !== 'visible') return;
        this.markedKey = key;
        const id = this.id();
        this.api.markRead(id).subscribe({ next: () => this.reads.markedRead(id), error: () => undefined });
      });
    });
    // Mensajes que llegan por el tiempo real: si el usuario está abajo, se queda abajo; si está leyendo más
    // arriba, no se mueve nada y se cuentan para la pastilla.
    effect(() => {
      if (!this.firstPage.hasValue()) return;
      const items = this.firstPage.value().items;
      const id = this.id();
      untracked(() => {
        if (this.known?.id !== id) {
          this.known = { id, ids: new Set(items.map((m) => m.id)) };
          this.unseenNew.set(0);
          return;
        }
        const ids = this.known.ids;
        const arrived = items.filter((m) => !ids.has(m.id));
        for (const m of arrived) ids.add(m.id);
        if (arrived.length === 0) return;
        if (this.atBottom()) setTimeout(() => this.scrollToLatest());
        else this.unseenNew.update((n) => n + arrived.length);
      });
    });
    onInboxChanges((changes) => {
      if (this.notFound()) return;
      if (changes.resync) return this.refresh();
      const id = this.id();
      const onlyRead = [...changes.types].every((type) => type === 'conversation.read');
      if (changes.conversations.has(id) && !onlyRead) this.refresh();
      else if (this.conversation() && changes.channels.has(this.conversation()!.channel.id))
        this.detail.reload();
    });
    pollWhileNoRealtime(() => this.refresh());
    const view = this.document.defaultView;
    const onWindowScroll = () => this.onChatScroll();
    view?.addEventListener('scroll', onWindowScroll, { passive: true });
    inject(DestroyRef).onDestroy(() => view?.removeEventListener('scroll', onWindowScroll));
  }

  /** ¿Se ve el último mensaje? Escritorio: el chat scrollea (columna invertida, 0 = abajo). Celular: la página. */
  private atBottom(): boolean {
    const chat = this.chat()?.nativeElement;
    if (chat && chat.scrollHeight > chat.clientHeight + 1) return chat.scrollTop > -80;
    const view = this.document.defaultView;
    if (!view) return true;
    return view.innerHeight + view.scrollY >= this.document.documentElement.scrollHeight - 160;
  }

  protected onChatScroll() {
    if (this.unseenNew() > 0 && this.atBottom()) this.unseenNew.set(0);
  }

  protected scrollToLatest() {
    this.unseenNew.set(0);
    const chat = this.chat()?.nativeElement;
    if (chat && chat.scrollHeight > chat.clientHeight + 1) chat.scrollTo({ top: 0 });
    else this.document.defaultView?.scrollTo({ top: this.document.documentElement.scrollHeight });
  }

  protected refresh() {
    if (this.notFound()) return;
    this.detail.reload();
    this.firstPage.reload();
  }

  /** Recién encolado: se ve al instante y se pide de nuevo la primera página (y el estado de la IA). */
  protected onSent(message: Message) {
    // Lo mandó este usuario: no cuenta como "mensaje nuevo".
    this.known?.ids.add(message.id);
    this.scrollToLatest();
    this.firstPage.update((page) =>
      page && !page.items.some((m) => m.id === message.id)
        ? { ...page, items: [...page.items, message] }
        : page,
    );
    this.firstPage.reload();
    this.detail.reload();
    this.summary.refresh();
  }

  /**
   * Solo lo que seguro no salió (nunca maybe_sent), si se puede responder y si todavía no se reenvió: ni
   * desde esta pantalla ni con un mensaje posterior del equipo con el mismo texto (otra pestaña, otra
   * persona). Así un segundo clic no le manda el texto dos veces al cliente.
   */
  protected canRetry(message: Message, c: ConversationDetail): boolean {
    if (
      !this.canReply() ||
      !c.reply.allowed ||
      message.senderType !== 'user' ||
      message.delivery?.state !== 'failed' ||
      message.delivery.reason !== 'not_sent' ||
      !message.body ||
      this.retried().has(message.id)
    ) {
      return false;
    }
    const items = this.groups().flatMap((group) => group.items);
    const index = items.findIndex((m) => m.id === message.id);
    return !items
      .slice(index + 1)
      .some((m) => m.senderType === 'user' && m.body === message.body && m.delivery?.state !== 'failed');
  }

  /**
   * Reenviar es un envío nuevo: el fallido queda en el historial como "No se envió". La clave se guarda
   * por mensaje hasta que el servidor confirma, así un reintento después de un corte no lo duplica.
   */
  protected retry(message: Message) {
    if (!message.body) return;
    const key = this.retryKeys.get(message.id) ?? crypto.randomUUID();
    this.retryKeys.set(message.id, key);
    this.retrying.set(message.id);
    this.api.sendMessage(this.id(), message.body, key).subscribe({
      next: (sent) => {
        this.retrying.set(null);
        this.retryKeys.delete(message.id);
        this.retried.update((ids) => new Set(ids).add(message.id));
        this.onSent(sent);
      },
      error: (cause: unknown) => {
        this.retrying.set(null);
        const status = cause instanceof HttpErrorResponse ? cause.status : null;
        const code =
          cause instanceof HttpErrorResponse ? (cause.error as { code?: unknown } | null)?.code : null;
        const reason = typeof code === 'string' ? REPLY_CONFLICT_CODES[code] : undefined;
        if (status === 409) this.retryKeys.delete(message.id);
        if (reason) this.notify.show(REPLY_BLOCKED_TEXT[reason]);
        // Sin conexión ya avisa el interceptor; 401/403 llevan a otra pantalla.
        else if (status !== 0 && status !== 401 && status !== 403) {
          this.notify.show('No pudimos reenviar el mensaje. Probá de nuevo en un momento.');
        }
        this.detail.reload();
      },
    });
  }

  protected align(message: Message): string {
    if (message.senderType === 'app') return 'items-center';
    return message.senderType === 'contact' ? 'items-start' : 'items-end';
  }

  protected bubble(message: Message): string {
    switch (message.senderType) {
      case 'contact':
        return 'bg-surface border border-border';
      case 'ai':
        return 'bg-primary-soft';
      case 'user':
        return 'bg-surface-2 border border-border-strong';
      default:
        return 'bg-surface-2 text-sm';
    }
  }

  protected loadOlder() {
    const cursor = this.olderCursor();
    if (!cursor) return;
    this.loadingOlder.set(true);
    this.api.messages(this.id(), cursor).subscribe({
      next: (page) => {
        this.older.update((list) => [...page.items, ...list]);
        this.olderNext.set(page.nextBefore);
        this.loadingOlder.set(false);
      },
      error: () => this.loadingOlder.set(false),
    });
  }

  protected reactivate(c: ConversationDetail) {
    this.confirm
      .ask({
        title: '¿Volver a activar la IA?',
        message: 'La IA va a volver a responder en esta conversación.',
        confirmLabel: 'Volver a activar',
      })
      .pipe(
        filter(Boolean),
        switchMap(() => {
          this.reactivating.set(true);
          return this.api.reactivateAi(c.id);
        }),
      )
      .subscribe({
        next: (updated) => {
          this.detail.set(updated);
          this.reactivating.set(false);
          this.summary.refresh();
          this.notify.success('Listo: la IA vuelve a responder en esta conversación.');
        },
        error: () => this.reactivating.set(false),
      });
  }
}
