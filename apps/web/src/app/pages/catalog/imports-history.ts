import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RotateCcw } from 'lucide';
import { firstValueFrom } from 'rxjs';
import { CatalogApi } from '../../api/catalog-api';
import { query } from '../../core/query';
import { ConfirmService } from '../../ui/confirm-dialog';
import { Icon } from '../../ui/icon';
import { NotifyService } from '../../ui/toast';
import { shortDateTime } from './catalog-format';

const STATUS_LABELS: Record<string, string> = {
  applied: 'Aplicada',
  reverted: 'Revertida',
  failed: 'Falló',
  preview: 'Vista previa',
};

/** Historial de importaciones, con "Volver a la anterior" (reaplica la aplicada anterior). */
@Component({
  selector: 'app-catalog-imports-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @if (imports.hasValue()) {
      @if (imports.value().canRevert) {
        <button
          type="button"
          class="btn btn-secondary mb-4"
          [disabled]="busy()"
          (click)="revert()"
          data-testid="revert-import"
        >
          <app-icon [icon]="revertIcon" [size]="18" /> Volver a la anterior
        </button>
      }
      <ul class="card divide-y divide-border" aria-label="Importaciones">
        @for (item of imports.value().items; track item.id) {
          <li
            class="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between"
            data-testid="import-row"
          >
            <div class="min-w-0">
              <p class="truncate font-semibold text-text">{{ item.fileName }}</p>
              <p class="text-sm text-muted">
                {{ when(item.appliedAt ?? item.createdAt) }}
                @if (item.createdBy; as person) {
                  · {{ person.name }}
                }
              </p>
              <p class="text-sm text-subtle">
                {{ item.counts.rows }} filas · {{ item.counts.new }} nuevos ·
                {{ item.counts.changed }} cambiados · {{ item.counts.missing }} ausentes ·
                {{ item.counts.invalid }} inválidas
              </p>
            </div>
            <span
              class="inline-flex shrink-0 items-center self-start rounded-full px-2.5 py-1 text-xs font-semibold sm:self-center"
              [class]="item.current ? 'bg-success-soft text-success' : 'bg-surface-2 text-muted'"
            >
              {{ item.current ? 'Vigente' : status(item.status) }}
            </span>
          </li>
        } @empty {
          <li class="p-4 text-muted">Todavía no se aplicó ninguna importación.</li>
        }
      </ul>
    } @else if (imports.loadFailed()) {
      <div class="card flex flex-col items-start gap-3 p-5">
        <p class="font-semibold text-text">No pudimos cargar el historial.</p>
        <button type="button" class="btn btn-secondary btn-sm" (click)="imports.reload()">Reintentar</button>
      </div>
    } @else {
      <p class="text-muted">Cargando…</p>
    }
  `,
})
export class ImportsHistory {
  private readonly api = inject(CatalogApi);
  private readonly confirm = inject(ConfirmService);
  private readonly notify = inject(NotifyService);
  protected readonly revertIcon = RotateCcw;
  protected readonly when = shortDateTime;
  protected readonly busy = signal(false);
  protected readonly imports = query(
    () => null,
    () => this.api.imports(),
  );

  protected status(status: string) {
    return STATUS_LABELS[status] ?? status;
  }

  protected async revert() {
    const ok = await firstValueFrom(
      this.confirm.ask({
        title: 'Volver a la importación anterior',
        message:
          'El catálogo vuelve a quedar como en la importación anterior: los productos que no estaban pasan a inactivos y los datos vuelven a los de ese archivo.',
        confirmLabel: 'Volver a la anterior',
      }),
    );
    if (!ok) return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.revert());
      this.notify.success('Listo: el catálogo volvió a la importación anterior.');
      this.imports.reload();
    } catch {
      this.notify.show('No pudimos volver a la importación anterior.');
    } finally {
      this.busy.set(false);
    }
  }
}
