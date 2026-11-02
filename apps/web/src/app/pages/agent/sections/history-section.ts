import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RotateCcw } from 'lucide';
import { firstValueFrom } from 'rxjs';
import { AgentConfigApi } from '../../../api/agent-config-api';
import type { AgentConfigVersion } from '../../../api/generated';
import { query } from '../../../core/query';
import { ConfirmService } from '../../../ui/confirm-dialog';
import { Icon } from '../../../ui/icon';
import { NotifyService } from '../../../ui/toast';
import { AgentDraft } from '../agent-draft';
import { TRANSPARENCY_TEXT, describePath, diffConfigs } from '../config-model';

/**
 * Historial: las versiones (número, quién y cuándo), la comparación de dos campo por campo (texto plano) y
 * "Restaurar esta versión", que crea una versión nueva copiando esa.
 */
@Component({
  selector: 'app-agent-history-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="flex flex-col gap-5">
      <div class="card flex flex-col gap-3 p-5">
        <h2 class="text-lg font-semibold text-text">Versiones guardadas</h2>
        <p class="text-sm text-subtle">
          Elegí dos para compararlas. Restaurar crea una versión nueva: nunca se borra ninguna.
        </p>
        @if (versions.hasValue()) {
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="text-muted">
                <tr>
                  <th scope="col" class="p-2">Versión</th>
                  <th scope="col" class="p-2">Guardada por</th>
                  <th scope="col" class="p-2">Cuándo</th>
                  <th scope="col" class="p-2">Comparar</th>
                  <th scope="col" class="p-2"><span class="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                @for (item of versions.value().items; track item.version) {
                  <tr class="border-t border-border" data-testid="version-row">
                    <td class="tabular p-2 font-semibold text-text">
                      {{ item.version }}
                      @if (item.version === draft.version()) {
                        <span class="ml-1 text-xs font-normal text-success">vigente</span>
                      }
                      @if (!item.valid) {
                        <span class="ml-1 text-xs font-normal text-warning">no válida hoy</span>
                      }
                    </td>
                    <td class="p-2 text-text">{{ item.savedBy?.name ?? '—' }}</td>
                    <td class="p-2 text-muted">{{ when(item.savedAt) }}</td>
                    <td class="p-2">
                      <label class="mr-3 inline-flex items-center gap-1">
                        <input
                          type="radio"
                          name="compare-a"
                          [checked]="left() === item.version"
                          (change)="left.set(item.version)"
                        />
                        A
                      </label>
                      <label class="inline-flex items-center gap-1">
                        <input
                          type="radio"
                          name="compare-b"
                          [checked]="right() === item.version"
                          (change)="right.set(item.version)"
                        />
                        B
                      </label>
                    </td>
                    <td class="p-2 text-right">
                      @if (item.version !== draft.version()) {
                        <button
                          type="button"
                          class="btn btn-ghost btn-sm"
                          (click)="restore(item.version)"
                          [disabled]="busy()"
                          data-testid="restore-version"
                        >
                          <app-icon [icon]="restoreIcon" [size]="16" /> Restaurar
                        </button>
                      }
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td class="p-2 text-muted" colspan="5">Todavía no hay versiones guardadas.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (versions.loadFailed()) {
          <p class="text-sm text-error">No pudimos cargar el historial.</p>
        } @else {
          <p class="text-sm text-muted">Cargando…</p>
        }
        <button
          type="button"
          class="btn btn-secondary btn-sm self-start"
          [disabled]="!left() || !right() || left() === right()"
          (click)="compare()"
          data-testid="compare-versions"
        >
          Comparar A con B
        </button>
      </div>

      @if (diff(); as changes) {
        <div class="card p-5" data-testid="version-diff">
          <h2 class="text-lg font-semibold text-text">
            Versión {{ compared()?.a }} → versión {{ compared()?.b }}
          </h2>
          <ul class="mt-3 flex flex-col divide-y divide-border text-sm">
            @for (change of changes; track change.path) {
              <li class="py-2">
                <p class="font-medium text-text">{{ describe(change.path) }}</p>
                <p class="whitespace-pre-wrap text-muted">
                  <span class="font-semibold">A:</span> {{ change.before }}
                </p>
                <p class="whitespace-pre-wrap text-muted">
                  <span class="font-semibold">B:</span> {{ change.after }}
                </p>
              </li>
            } @empty {
              <li class="py-2 text-muted">Son iguales.</li>
            }
          </ul>
        </div>
      }
    </div>
  `,
})
export class HistorySection {
  protected readonly draft = inject(AgentDraft);
  private readonly api = inject(AgentConfigApi);
  private readonly confirm = inject(ConfirmService);
  private readonly notify = inject(NotifyService);
  protected readonly restoreIcon = RotateCcw;
  protected readonly describe = describePath;
  protected readonly versions = query(
    () => this.draft.version(),
    () => this.api.versions(),
  );
  protected readonly left = signal<number | null>(null);
  protected readonly right = signal<number | null>(null);
  protected readonly busy = signal(false);
  protected readonly compared = signal<{
    a: number;
    b: number;
    versions: [AgentConfigVersion, AgentConfigVersion];
  } | null>(null);
  protected readonly diff = computed(() => {
    const compared = this.compared();
    return compared ? diffConfigs(compared.versions[0].config, compared.versions[1].config) : null;
  });

  protected when(iso: string) {
    return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  }

  protected async compare() {
    const a = this.left();
    const b = this.right();
    if (!a || !b) return;
    try {
      const [first, second] = await Promise.all([
        firstValueFrom(this.api.version(a)),
        firstValueFrom(this.api.version(b)),
      ]);
      this.compared.set({ a, b, versions: [first, second] });
    } catch {
      this.notify.show('No pudimos traer las versiones para comparar.');
    }
  }

  protected async restore(version: number, confirmTransparency = false) {
    if (!confirmTransparency) {
      const ok = await firstValueFrom(
        this.confirm.ask({
          title: `Restaurar la versión ${version}`,
          message: this.draft.dirty()
            ? 'Se crea una versión nueva igual a esa. Los cambios que no guardaste se pierden.'
            : 'Se crea una versión nueva igual a esa, y pasa a ser la vigente.',
          confirmLabel: 'Restaurar',
        }),
      );
      if (!ok) return;
    }
    this.busy.set(true);
    try {
      const saved = await firstValueFrom(
        this.api.restore(version, this.draft.version(), confirmTransparency),
      );
      this.notify.success(`Restauraste la versión ${version} como versión ${saved.version}.`);
      await this.draft.load();
    } catch (error) {
      const code =
        error instanceof HttpErrorResponse ? (error.error as { code?: string } | null)?.code : null;
      if (code === 'TRANSPARENCY_CONFIRM_REQUIRED') {
        const ok = await firstValueFrom(
          this.confirm.ask({
            title: 'Esa versión activa la revisión de calidad',
            message: TRANSPARENCY_TEXT,
            confirmLabel: 'Ya le avisé al equipo',
          }),
        );
        this.busy.set(false);
        if (ok) await this.restore(version, true);
        return;
      }
      this.notify.show(
        code === 'VERSION_CONFLICT'
          ? 'Otra persona guardó una versión en el medio. Recargá la página y probá de nuevo.'
          : code === 'REVIEW_OWNER_ONLY'
            ? 'Esa versión activa la revisión de calidad: solo el dueño de la cuenta puede restaurarla.'
            : code === 'INVALID_CONFIG'
              ? 'Esa versión ya no es válida con las reglas actuales: no se puede restaurar tal cual.'
              : 'No pudimos restaurar la versión.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
