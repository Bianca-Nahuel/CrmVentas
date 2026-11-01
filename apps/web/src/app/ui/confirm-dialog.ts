import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
}

let nextId = 0;

/** Diálogo de confirmación (CDK): atrapa el foco, Esc cancela y el foco vuelve al botón que lo abrió. */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block w-[min(92vw,420px)] p-5 shadow-3' },
  template: `
    <h2 class="text-lg font-semibold text-text" [id]="titleId">{{ data.title }}</h2>
    <p class="mt-2 text-muted" [id]="messageId">{{ data.message }}</p>
    <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <button type="button" class="btn btn-secondary" (click)="ref.close(false)">
        {{ data.cancelLabel ?? 'Cancelar' }}
      </button>
      <button type="button" class="btn btn-primary" (click)="ref.close(true)" data-testid="confirm">
        {{ data.confirmLabel }}
      </button>
    </div>
  `,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmOptions>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  readonly titleId = `confirm-title-${++nextId}`;
  readonly messageId = `confirm-message-${nextId}`;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly dialog = inject(Dialog);

  /** Emite true si la persona confirmó. */
  ask(options: ConfirmOptions): Observable<boolean> {
    const ref = this.dialog.open<boolean, ConfirmOptions, ConfirmDialog>(ConfirmDialog, {
      data: options,
      role: 'alertdialog',
      hasBackdrop: true,
      backdropClass: 'app-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    const instance = ref.componentInstance!;
    ref.config.ariaLabelledBy = instance.titleId;
    ref.config.ariaDescribedBy = instance.messageId;
    return ref.closed.pipe(map((result) => result === true));
  }
}
