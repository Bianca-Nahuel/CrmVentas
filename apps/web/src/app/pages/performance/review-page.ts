import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ArrowLeft, Flag } from 'lucide';
import { of } from 'rxjs';
import { InboxApi } from '../../api/inbox-api';
import { PerformanceApi } from '../../api/performance-api';
import type { Message, ReviewDetail, ReviewEvidence } from '../../api/generated';
import { query } from '../../core/query';
import { Icon } from '../../ui/icon';
import { NotifyService } from '../../ui/toast';
import { SENDER_LABELS, fullWhen, timeLabel } from '../inbox/format';
import {
  CUSTOMER_OUTCOME_LABELS,
  ISSUE_LABELS,
  RESOLVED_LABELS,
  highlightSegments,
  type Segment,
} from './performance-format';

let nextId = 0;

/** "No es correcta": nota opcional. Cierra con la nota (texto) o null si se canceló. */
@Component({
  selector: 'app-dispute-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block w-[min(92vw,420px)] p-5 shadow-3' },
  template: `
    <form (submit)="$event.preventDefault(); ref.close(note())">
      <h2 class="text-lg font-semibold text-text" [id]="titleId">Marcar como no correcta</h2>
      <p class="mt-1 text-sm text-muted">
        La revisión deja de contar en los promedios. Queda registrado quién la marcó.
      </p>
      <label class="mt-4 block text-sm font-semibold text-text" [for]="noteId">Nota (opcional)</label>
      <textarea
        class="input mt-1.5 min-h-20 py-2"
        [id]="noteId"
        maxlength="500"
        [value]="note()"
        (input)="note.set($any($event.target).value)"
      ></textarea>
      <div class="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" class="btn btn-secondary" (click)="ref.close(null)">Cancelar</button>
        <button type="submit" class="btn btn-primary" data-testid="dispute-confirm">Marcar</button>
      </div>
    </form>
  `,
})
export class DisputeDialog {
  protected readonly ref = inject<DialogRef<string | null>>(DialogRef);
  protected readonly titleId = inject<{ titleId: string }>(DIALOG_DATA).titleId;
  protected readonly noteId = `${this.titleId}-note`;
  protected readonly note = signal('');
}

/**
 * Una revisión de calidad (tarea 026): la conversación con las citas resaltadas y la revisión al costado.
 * Las citas se pintan con nodos (<mark> por interpolación), nunca con innerHTML: los mensajes y el texto del
 * analista son contenido no confiable.
 */
@Component({
  selector: 'app-review-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon],
  template: `
    <a class="btn btn-ghost btn-sm mb-3" routerLink="/rendimiento">
      <app-icon [icon]="backIcon" [size]="16" /> Rendimiento
    </a>

    @if (notFound()) {
      <div class="card p-5"><p class="font-semibold text-text">Revisión no encontrada.</p></div>
    } @else if (review.value(); as r) {
      <h1 class="text-2xl">Revisión de calidad</h1>
      <p class="mt-1 text-sm text-muted">
        {{ r.channel.name }}{{ r.seller ? ' · ' + r.seller.name : '' }} · Revisada {{ when(r.createdAt) }}
      </p>

      <div class="mt-4 flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <aside
          class="card flex flex-col gap-4 p-4 text-sm lg:sticky lg:top-4 lg:order-2"
          aria-label="Revisión"
          data-testid="review-panel"
        >
          @if (r.dispute; as d) {
            <div class="rounded-md bg-surface-2 p-3" data-testid="review-disputed">
              <p class="font-semibold text-text">Marcada como no correcta</p>
              <p class="text-subtle">{{ d.byName ?? 'Alguien del equipo' }} · {{ when(d.at) }}</p>
              @if (d.note) {
                <p class="mt-1 whitespace-pre-wrap break-words text-text" [textContent]="d.note"></p>
              }
            </div>
          }
          <dl class="grid grid-cols-2 gap-2">
            <div>
              <dt class="text-xs font-semibold text-muted">Cliente</dt>
              <dd class="font-semibold text-text">{{ outcomeLabels[r.customerOutcome.value] }}</dd>
            </div>
            <div>
              <dt class="text-xs font-semibold text-muted">Resolución</dt>
              <dd class="font-semibold text-text">{{ resolvedLabels[r.resolved] }}</dd>
            </div>
          </dl>
          @if (r.customerOutcome.evidence; as e) {
            <blockquote class="border-l-2 border-border-strong pl-3 text-muted">“{{ e.quote }}”</blockquote>
          }

          <div>
            <h2 class="font-semibold text-text">Criterios</h2>
            <ul class="mt-2 flex flex-col gap-2.5">
              @for (criterion of r.criteria; track criterion.key) {
                <li data-testid="review-criterion">
                  <p class="flex justify-between gap-2">
                    <span class="text-text">{{ criterion.label ?? criterion.key }}</span>
                    <span class="tabular font-semibold text-text">{{
                      criterion.score === null ? 'Sin nota' : criterion.score + ' / 5'
                    }}</span>
                  </p>
                  @if (criterion.evidence; as e) {
                    <button
                      type="button"
                      class="mt-0.5 text-left text-muted hover:text-text"
                      (click)="focus(e)"
                    >
                      “{{ e.quote }}”
                    </button>
                  }
                </li>
              }
            </ul>
          </div>

          @if (r.issues.length) {
            <div>
              <h2 class="font-semibold text-text">Problemas</h2>
              <ul class="mt-2 flex flex-col gap-2.5">
                @for (issue of r.issues; track $index) {
                  <li>
                    <p class="font-semibold text-text">{{ issueLabels[issue.type] }}</p>
                    <p class="text-text">{{ issue.description }}</p>
                    <button
                      type="button"
                      class="mt-0.5 text-left text-muted hover:text-text"
                      (click)="focus(issue.evidence)"
                    >
                      “{{ issue.evidence?.quote }}”
                    </button>
                  </li>
                }
              </ul>
            </div>
          }

          @if (r.highlights.length) {
            <div>
              <h2 class="font-semibold text-text">Bien hecho</h2>
              <ul class="mt-2 flex flex-col gap-2.5">
                @for (highlight of r.highlights; track $index) {
                  <li>
                    <p class="text-text">{{ highlight.description }}</p>
                    <button
                      type="button"
                      class="mt-0.5 text-left text-muted hover:text-text"
                      (click)="focus(highlight.evidence)"
                    >
                      “{{ highlight.evidence?.quote }}”
                    </button>
                  </li>
                }
              </ul>
            </div>
          }

          @if (r.coachingTip) {
            <div>
              <h2 class="font-semibold text-text">Sugerencia</h2>
              <p class="mt-1 text-text">{{ r.coachingTip }}</p>
            </div>
          }
          <div>
            <h2 class="font-semibold text-text">Resumen</h2>
            <p class="mt-1 text-text">{{ r.summary }}</p>
          </div>
          @if (r.discardedCount) {
            <p class="text-xs text-subtle">
              Se descartaron {{ r.discardedCount }} {{ r.discardedCount === 1 ? 'ítem' : 'ítems' }} cuya cita
              no estaba en la conversación.
            </p>
          }
          @if (!r.dispute) {
            <button
              type="button"
              class="btn btn-secondary btn-sm self-start"
              data-testid="dispute"
              [disabled]="disputing()"
              (click)="dispute(r)"
            >
              <app-icon [icon]="flagIcon" [size]="15" /> No es correcta
            </button>
          }
        </aside>

        <section class="card p-3 sm:p-4 lg:order-1" aria-label="Conversación revisada">
          @if (olderCursor()) {
            <div class="flex justify-center pb-2">
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
          <div role="log" aria-label="Mensajes" class="flex flex-col gap-2">
            @for (message of messages(); track message.id) {
              <div
                class="flex flex-col"
                [class]="message.senderType === 'contact' ? 'items-start' : 'items-end'"
                [id]="'msg-' + message.id"
                data-testid="review-message"
              >
                <div
                  class="max-w-[85%] rounded-lg px-3 py-2 sm:max-w-[75%]"
                  [class]="
                    message.senderType === 'contact'
                      ? 'border border-border bg-surface'
                      : 'border border-border-strong bg-surface-2'
                  "
                  [class.opacity-60]="after(message, r)"
                  [class.ring-2]="focused() === message.id"
                  [class.ring-primary]="focused() === message.id"
                >
                  <p class="text-xs font-semibold text-muted">{{ senderLabels[message.senderType] }}</p>
                  @if (message.body) {
                    <p class="whitespace-pre-wrap break-words text-text" data-testid="review-message-body">
                      @for (segment of segments(message); track $index) {
                        @if (segment.mark) {
                          <mark class="rounded-sm bg-warning-soft text-text" data-testid="quote-mark">{{
                            segment.text
                          }}</mark>
                        } @else {
                          {{ segment.text }}
                        }
                      }
                    </p>
                  }
                  <p class="tabular mt-0.5 text-right text-[11px] text-subtle">
                    {{ time(message.sentAt) }}{{ after(message, r) ? ' · posterior a la revisión' : '' }}
                  </p>
                </div>
              </div>
            } @empty {
              <p class="py-6 text-center text-muted">
                {{ firstPage.isLoading() ? 'Cargando mensajes…' : 'No hay mensajes.' }}
              </p>
            }
          </div>
        </section>
      </div>
    } @else if (review.loadFailed()) {
      <div class="card p-5"><p class="font-semibold text-text">No pudimos cargar la revisión.</p></div>
    } @else {
      <p class="text-muted">Cargando revisión…</p>
    }
  `,
})
export class ReviewPage {
  private readonly api = inject(PerformanceApi);
  private readonly inbox = inject(InboxApi);
  private readonly dialog = inject(Dialog);
  private readonly notify = inject(NotifyService);

  readonly id = input.required<string>();
  protected readonly review = query(
    () => this.id(),
    (id) => this.api.review(id),
  );
  protected readonly firstPage = query(
    () => (this.review.hasValue() ? this.review.value().conversationId : null),
    (conversationId) => (conversationId ? this.inbox.messages(conversationId) : of(null)),
  );
  private readonly older = signal<Message[]>([]);
  private readonly olderNext = signal<string | null | undefined>(undefined);
  protected readonly loadingOlder = signal(false);
  protected readonly disputing = signal(false);
  protected readonly focused = signal<string | null>(null);

  protected readonly notFound = computed(() => {
    const error = this.review.error();
    return error instanceof HttpErrorResponse && error.status === 404;
  });
  protected readonly olderCursor = computed(() => {
    const next = this.olderNext();
    if (next !== undefined) return next;
    return this.firstPage.value()?.nextBefore ?? null;
  });
  protected readonly messages = computed(() => {
    const first = this.firstPage.value()?.items ?? [];
    const seen = new Set<string>();
    return [...this.older(), ...first].filter((m) => !seen.has(m.id) && seen.add(m.id) !== undefined);
  });
  /** Citas por mensaje (las de todos los ítems de la revisión). */
  private readonly quotes = computed(() => {
    const map = new Map<string, string[]>();
    const r = this.review.value();
    if (!r) return map;
    const all: (ReviewEvidence | null)[] = [
      r.customerOutcome.evidence,
      ...r.criteria.map((c) => c.evidence),
      ...r.issues.map((i) => i.evidence),
      ...r.highlights.map((h) => h.evidence),
    ];
    for (const evidence of all) {
      if (!evidence || !evidence.messageId) continue;
      map.set(evidence.messageId, [...(map.get(evidence.messageId) ?? []), evidence.quote]);
    }
    return map;
  });

  protected readonly outcomeLabels = CUSTOMER_OUTCOME_LABELS;
  protected readonly resolvedLabels = RESOLVED_LABELS;
  protected readonly issueLabels = ISSUE_LABELS;
  protected readonly senderLabels = SENDER_LABELS;
  protected readonly when = fullWhen;
  protected readonly time = timeLabel;
  protected readonly backIcon = ArrowLeft;
  protected readonly flagIcon = Flag;

  protected segments(message: Message): Segment[] {
    return highlightSegments(message.body ?? '', this.quotes().get(message.id) ?? []);
  }

  protected after(message: Message, r: ReviewDetail): boolean {
    return new Date(message.sentAt).getTime() > new Date(r.lastMessageAt).getTime();
  }

  /** Lleva al mensaje de la cita. */
  protected focus(evidence: ReviewEvidence | null) {
    if (!evidence?.messageId) return;
    this.focused.set(evidence.messageId);
    document
      .getElementById(`msg-${evidence.messageId}`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  protected loadOlder() {
    const cursor = this.olderCursor();
    const r = this.review.value();
    if (!cursor || !r) return;
    this.loadingOlder.set(true);
    this.inbox.messages(r.conversationId, cursor).subscribe({
      next: (page) => {
        this.older.update((list) => [...page.items, ...list]);
        this.olderNext.set(page.nextBefore);
        this.loadingOlder.set(false);
      },
      error: () => this.loadingOlder.set(false),
    });
  }

  protected dispute(r: ReviewDetail) {
    const titleId = `dispute-title-${++nextId}`;
    const ref = this.dialog.open<string | null, { titleId: string }, DisputeDialog>(DisputeDialog, {
      data: { titleId },
      ariaLabelledBy: titleId,
      role: 'dialog',
      hasBackdrop: true,
      backdropClass: 'app-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    ref.closed.subscribe((note) => {
      if (note === null || note === undefined) return;
      this.disputing.set(true);
      this.api.dispute(r.id, note.trim()).subscribe({
        next: (updated) => {
          this.review.set(updated);
          this.disputing.set(false);
          this.notify.success('Listo: la revisión ya no cuenta en los promedios.');
        },
        error: () => this.disputing.set(false),
      });
    });
  }
}
