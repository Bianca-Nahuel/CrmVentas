import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ArrowLeft, Bot, ChevronDown, FileQuestion, ShieldAlert } from 'lucide';
import { filter, switchMap } from 'rxjs';
import { InboxApi } from '../../api/inbox-api';
import type { ConversationDetail, Message } from '../../api/generated';
import { AuthService } from '../../core/auth/auth.service';
import { DOCUMENT } from '@angular/common';
import { InboxSummary } from '../../core/inbox-summary';
import { can } from '../../core/nav';
import { pollWhileVisible } from '../../core/poll';
import { query } from '../../core/query';
import { ConfirmService } from '../../ui/confirm-dialog';
import { Icon } from '../../ui/icon';
import { Score } from '../../ui/score';
import { NotifyService } from '../../ui/toast';
import {
  AI_STATE_LABELS,
  MESSAGE_TYPE_LABELS,
  SENDER_LABELS,
  contactName,
  fullWhen,
  groupByDay,
  reasonLabel,
  timeLabel,
} from './format';
import { InboxReads } from './inbox-reads';

const DESKTOP = '(min-width: 1024px)';

/**
 * Conversación de solo lectura (tarea 014). Todo lo que viene de WhatsApp y el resumen de la IA son
 * contenido no confiable: se muestran por interpolación (texto), sin links ni formato. Responder desde el
 * panel llega con la 024.
 */
@Component({
  selector: 'app-conversation-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, Score],
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
        class="flex flex-col gap-3 lg:min-h-0 lg:flex-1 xl:grid xl:grid-cols-[minmax(0,1fr)_288px] xl:grid-rows-[auto_minmax(0,1fr)] xl:gap-0"
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
          <span
            class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold"
            [class]="
              c.ai.state === 'active' ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning'
            "
            data-testid="ai-state"
          >
            <app-icon [icon]="botIcon" [size]="15" /> {{ aiLabel(c) }}
          </span>
        </header>

        <aside
          class="flex flex-col gap-3 lg:px-5 xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:overflow-y-auto xl:border-l xl:border-border xl:p-4"
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
          class="flex flex-col-reverse lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-5 lg:pb-4 xl:col-start-1 xl:row-start-2 xl:pt-3"
        >
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
                      <time
                        class="tabular mt-0.5 block text-right text-[11px] text-subtle"
                        [attr.datetime]="message.sentAt"
                        [attr.title]="fullWhen(message.sentAt)"
                        >{{ time(message.sentAt) }}</time
                      >
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
  protected readonly canReactivate = computed(() => can(this.auth.role(), { conversation: ['reply'] }));
  /** El resumen arranca abierto en el escritorio y cerrado en el celular. */
  protected readonly openSummary = globalThis.matchMedia?.(DESKTOP).matches ?? true;

  protected readonly backIcon = ArrowLeft;
  protected readonly botIcon = Bot;
  protected readonly alertIcon = ShieldAlert;
  protected readonly chevronIcon = ChevronDown;
  protected readonly notFoundIcon = FileQuestion;
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
    pollWhileVisible(() => this.refresh());
  }

  protected refresh() {
    if (this.notFound()) return;
    this.detail.reload();
    this.firstPage.reload();
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
