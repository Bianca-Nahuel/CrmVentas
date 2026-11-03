import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormField, disabled, form } from '@angular/forms/signals';
import { CircleAlert, Info, SendHorizontal, TriangleAlert } from 'lucide';
import { InboxApi } from '../../api/inbox-api';
import type { ConversationDetail, Message } from '../../api/generated';
import { Icon } from '../../ui/icon';
import { REPLY_BLOCKED_TEXT, REPLY_CONFLICT_CODES, type ReplyBlockedReason } from './format';
import { Spinner } from '../../ui/spinner';

/** Tope de un mensaje de WhatsApp (el mismo que valida la API, en caracteres). */
export const REPLY_MAX_CHARS = 4096;
/** Desde acá se muestra el contador. */
const COUNTER_FROM = 3500;

/**
 * Caja para responder por WhatsApp desde la conversación (tarea 024). El backend decide si se puede
 * (conversation.reply y el 409 del envío); acá solo se explica y se deshabilita.
 * Idempotencia: la clave se crea al primer intento y se conserva mientras el texto no cambie, así un
 * doble clic o un reintento después de un error de red no mandan el mensaje dos veces.
 */
@Component({
  selector: 'app-reply-box',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, Icon, Spinner],
  host: { class: 'block', 'data-testid': 'reply-box' },
  template: `
    <form class="flex flex-col gap-2" novalidate (submit)="onSubmit($event)">
      @if (blockedReason(); as reason) {
        <p
          class="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-text"
          role="status"
          data-testid="reply-blocked"
          [attr.data-reason]="reason"
          [id]="noticeId"
        >
          <app-icon [icon]="warnIcon" [size]="18" class="mt-0.5 text-warning" />
          <span>{{ blockedText(reason) }}</span>
        </p>
      }
      <div class="flex items-end gap-2">
        <textarea
          class="input max-h-40 min-h-11 flex-1 resize-none py-2.5 leading-snug [field-sizing:content]"
          rows="1"
          placeholder="Escribí una respuesta…"
          aria-label="Respuesta por WhatsApp"
          data-testid="reply-input"
          [attr.aria-describedby]="noticeId"
          [attr.aria-invalid]="tooLong() ? 'true' : null"
          [formField]="replyForm.text"
          (keydown)="onKeydown($event)"
        ></textarea>
        <button
          type="submit"
          class="btn btn-primary h-11 shrink-0 px-3 sm:px-4"
          data-testid="reply-send"
          [disabled]="!canSend()"
          [attr.aria-label]="sending() ? 'Enviando' : 'Enviar'"
        >
          @if (sending()) {
            <app-spinner [size]="18" />
          } @else {
            <app-icon [icon]="sendIcon" [size]="18" />
          }
          <span class="hidden sm:inline">{{ sending() ? 'Enviando…' : 'Enviar' }}</span>
        </button>
      </div>
      @if (error(); as message) {
        <p
          class="flex items-start gap-1.5 text-sm font-medium text-error"
          role="alert"
          data-testid="reply-error"
        >
          <app-icon [icon]="errorIcon" [size]="16" class="mt-0.5" />
          {{ message }}
        </p>
      }
      @if (!blockedReason()) {
        <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle" [id]="noticeId">
          <span class="inline-flex items-center gap-1" data-testid="reply-channel">
            <app-icon [icon]="infoIcon" [size]="14" />
            Sale por WhatsApp desde {{ conversation().channel.name }} ({{
              conversation().channel.phoneNumber
            }})
          </span>
          <span class="hidden lg:inline">Enter para enviar · Shift + Enter para un salto de línea</span>
          @if (showCounter()) {
            <span class="tabular ml-auto" [class.text-error]="tooLong()" data-testid="reply-counter">
              {{ chars() }} / {{ max }}
            </span>
          }
        </p>
      }
    </form>
  `,
})
export class ReplyBox {
  private readonly api = inject(InboxApi);

  readonly conversation = input.required<ConversationDetail>();
  /** El mensaje encolado (o el de la primera vez, si era un reintento con la misma clave). */
  readonly sent = output<Message>();
  /** El envío chocó con una regla (409): hay que recargar el detalle para ver por qué. */
  readonly blocked = output<ReplyBlockedReason>();

  private readonly model = signal({ text: '' });
  protected readonly sending = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Motivo de un 409 que todavía no llegó en el detalle. */
  private readonly conflict = signal<ReplyBlockedReason | null>(null);
  /** Clave del intento en curso y el texto con el que se creó. */
  private attempt: { key: string; text: string } | null = null;

  protected readonly blockedReason = computed(
    () => this.conflict() ?? (this.conversation().reply.allowed ? null : this.conversation().reply.reason),
  );
  protected readonly replyForm = form(this.model, (path) => {
    disabled(path.text, () => this.blockedReason() !== null);
  });
  protected readonly chars = computed(() => [...this.model().text.trim()].length);
  protected readonly tooLong = computed(() => this.chars() > REPLY_MAX_CHARS);
  protected readonly showCounter = computed(() => this.chars() > COUNTER_FROM);
  protected readonly canSend = computed(
    () => !this.sending() && !this.blockedReason() && this.chars() > 0 && !this.tooLong(),
  );

  protected readonly max = REPLY_MAX_CHARS;
  protected readonly noticeId = `reply-notice-${Math.random().toString(36).slice(2, 8)}`;
  protected readonly sendIcon = SendHorizontal;
  protected readonly infoIcon = Info;
  protected readonly warnIcon = TriangleAlert;
  protected readonly errorIcon = CircleAlert;

  constructor() {
    // Otra conversación (o un detalle nuevo después de un 409): se descarta el motivo provisorio.
    effect(() => {
      this.conversation();
      untracked(() => this.conflict.set(null));
    });
    // Al cambiar de conversación, el borrador y el intento no se arrastran.
    let lastId: string | null = null;
    effect(() => {
      const id = this.conversation().id;
      if (id === lastId) return;
      lastId = id;
      untracked(() => {
        this.model.set({ text: '' });
        this.error.set(null);
        this.attempt = null;
      });
    });
  }

  protected blockedText(reason: ReplyBlockedReason): string {
    return REPLY_BLOCKED_TEXT[reason];
  }

  /** Enter envía; Shift + Enter hace un salto de línea (y Enter mientras se compone un acento, nada). */
  protected onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.send();
    }
  }

  protected onSubmit(event: Event) {
    event.preventDefault();
    this.send();
  }

  private send() {
    if (!this.canSend()) return;
    const text = this.model().text.trim();
    // Mismo texto que el intento anterior (que falló sin respuesta): misma clave, no se duplica.
    if (this.attempt?.text !== text) this.attempt = { key: crypto.randomUUID(), text };
    const { key } = this.attempt;
    const conversationId = this.conversation().id;
    this.sending.set(true);
    this.error.set(null);
    this.api.sendMessage(conversationId, text, key).subscribe({
      next: (message) => {
        this.sending.set(false);
        this.attempt = null;
        // Si siguió escribiendo mientras se enviaba, no se pierde lo nuevo.
        if (this.model().text.trim() === text) this.model.set({ text: '' });
        this.sent.emit(message);
      },
      error: (cause: unknown) => {
        this.sending.set(false);
        const code =
          cause instanceof HttpErrorResponse ? (cause.error as { code?: unknown } | null)?.code : null;
        const reason = typeof code === 'string' ? REPLY_CONFLICT_CODES[code] : undefined;
        if (cause instanceof HttpErrorResponse && cause.status === 409 && reason) {
          // No salió nada: el borrador queda y se explica por qué.
          this.attempt = null;
          this.conflict.set(reason);
          this.blocked.emit(reason);
          return;
        }
        if (cause instanceof HttpErrorResponse && cause.status === 409) {
          this.attempt = null;
          this.error.set('No pudimos enviar el mensaje. Recargá la conversación y probá de nuevo.');
          return;
        }
        if (cause instanceof HttpErrorResponse && (cause.status === 401 || cause.status === 403)) return;
        // Sin respuesta (red o servidor): reintentar con la misma clave no lo manda dos veces.
        this.error.set('No pudimos confirmar el envío. Probá de nuevo: si ya había salido, no se repite.');
      },
    });
  }
}
