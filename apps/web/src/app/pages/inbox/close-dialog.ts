import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, Injectable, computed, inject, signal } from '@angular/core';
import type { Observable } from 'rxjs';
import { InboxApi } from '../../api/inbox-api';
import type { CloseOutcome, ConversationDetail } from '../../api/generated';
import { NotifyService } from '../../ui/toast';
import { parseAmount } from './amount';
import { CLOSE_OUTCOME_LABELS } from './format';

const OUTCOMES: readonly CloseOutcome[] = ['sold', 'not_sold', 'no_response', 'not_a_lead', 'other'];
export const CLOSE_NOTE_MAX = 500;

let nextId = 0;

/**
 * Cerrar una conversación (tarea 026): resultado obligatorio, nota opcional y, si se vendió, el monto
 * aproximado opcional (tarea 028, para el embudo). El diálogo hace el pedido y se
 * cierra con la conversación actualizada (o null si se canceló). CDK: atrapa el foco y Esc cancela.
 */
@Component({
  selector: 'app-close-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block w-[min(92vw,440px)] p-5 shadow-3' },
  template: `
    <form (submit)="$event.preventDefault(); save()">
      <h2 class="text-lg font-semibold text-text" [id]="titleId">Cerrar conversación</h2>
      <p class="mt-1 text-sm text-muted">
        Sale de la grilla y de la bandeja. Si el cliente vuelve a escribir, empieza una conversación nueva.
      </p>
      <fieldset class="mt-4">
        <legend class="text-sm font-semibold text-text">¿Cómo terminó?</legend>
        <div class="mt-2 flex flex-col gap-1.5" role="radiogroup">
          @for (outcome of outcomes; track outcome) {
            <label
              class="flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-text"
              [class]="
                selected() === outcome ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-2'
              "
            >
              <input
                type="radio"
                name="close-outcome"
                class="accent-primary"
                [value]="outcome"
                [checked]="selected() === outcome"
                (change)="selected.set(outcome)"
                [attr.data-testid]="'outcome-' + outcome"
              />
              {{ labels[outcome] }}
            </label>
          }
        </div>
        @if (showRequired()) {
          <p class="mt-1.5 text-sm text-error" role="alert">Elegí cómo terminó.</p>
        }
      </fieldset>
      @if (selected() === 'sold') {
        <label class="mt-4 block text-sm font-semibold text-text" [for]="amountId"
          >Monto aproximado (ARS, opcional)</label
        >
        <input
          class="input mt-1.5"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          placeholder="Por ejemplo, 150.000"
          [id]="amountId"
          [attr.aria-describedby]="amountHintId"
          [attr.aria-invalid]="amountInvalid() ? 'true' : null"
          data-testid="close-amount"
          [value]="amount()"
          (input)="amount.set($any($event.target).value)"
        />
        @if (amountInvalid()) {
          <p class="mt-1.5 text-sm text-error" role="alert" [id]="amountHintId">
            Escribí un monto mayor que 0, con hasta 2 decimales.
          </p>
        } @else {
          <p class="mt-1 text-xs text-subtle" [id]="amountHintId">
            Sirve para ver el total vendido en el embudo.
          </p>
        }
      }
      <label class="mt-4 block text-sm font-semibold text-text" [for]="noteId">Nota (opcional)</label>
      <textarea
        class="input mt-1.5 min-h-20 py-2"
        [id]="noteId"
        [maxLength]="noteMax"
        data-testid="close-note"
        [value]="note()"
        (input)="note.set($any($event.target).value)"
      ></textarea>
      <p class="mt-1 text-right text-xs text-subtle tabular">{{ note().length }}/{{ noteMax }}</p>
      <div class="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" class="btn btn-secondary" (click)="ref.close(null)">Cancelar</button>
        <button type="submit" class="btn btn-primary" [disabled]="saving()" data-testid="close-confirm">
          Cerrar conversación
        </button>
      </div>
    </form>
  `,
})
export class CloseDialog {
  private readonly api = inject(InboxApi);
  private readonly notify = inject(NotifyService);
  protected readonly data = inject<{ id: string; titleId: string }>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<ConversationDetail | null>>(DialogRef);
  protected readonly titleId = this.data.titleId;
  protected readonly noteId = `${this.data.titleId}-note`;
  protected readonly amountId = `${this.data.titleId}-amount`;
  protected readonly amountHintId = `${this.data.titleId}-amount-hint`;

  protected readonly outcomes = OUTCOMES;
  protected readonly labels = CLOSE_OUTCOME_LABELS;
  protected readonly noteMax = CLOSE_NOTE_MAX;
  protected readonly selected = signal<CloseOutcome | null>(null);
  protected readonly note = signal('');
  protected readonly amount = signal('');
  private readonly parsedAmount = computed(() => parseAmount(this.amount()));
  protected readonly amountInvalid = computed(
    () => this.selected() === 'sold' && this.tried() && this.parsedAmount() === 'invalid',
  );
  protected readonly saving = signal(false);
  private readonly tried = signal(false);
  protected readonly showRequired = computed(() => this.tried() && this.selected() === null);

  protected save() {
    this.tried.set(true);
    const outcome = this.selected();
    if (!outcome || this.saving()) return;
    const amount = outcome === 'sold' ? this.parsedAmount() : null;
    if (amount === 'invalid') return;
    this.saving.set(true);
    this.api.close(this.data.id, outcome, this.note().trim(), amount).subscribe({
      next: (detail) => {
        this.notify.success(`Conversación cerrada: ${CLOSE_OUTCOME_LABELS[outcome].toLowerCase()}.`);
        this.ref.close(detail);
      },
      // Queda abierto para reintentar (los errores de red y los 401/403 ya los avisa el interceptor).
      error: () => {
        this.saving.set(false);
        this.notify.show('No pudimos cerrar la conversación. Probá de nuevo.');
      },
    });
  }
}

@Injectable({ providedIn: 'root' })
export class CloseConversation {
  private readonly dialog = inject(Dialog);

  /** Emite la conversación cerrada, o null si se canceló. */
  open(id: string): Observable<ConversationDetail | null | undefined> {
    // El id del título va en la config: el contenedor del diálogo se nombra al crearse.
    const titleId = `close-title-${++nextId}`;
    const ref = this.dialog.open<ConversationDetail | null, { id: string; titleId: string }, CloseDialog>(
      CloseDialog,
      {
        data: { id, titleId },
        ariaLabelledBy: titleId,
        role: 'dialog',
        hasBackdrop: true,
        backdropClass: 'app-backdrop',
        autoFocus: 'first-tabbable',
        restoreFocus: true,
      },
    );
    return ref.closed;
  }
}
