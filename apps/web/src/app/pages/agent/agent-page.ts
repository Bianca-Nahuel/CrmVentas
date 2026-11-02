import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal, type OnInit } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { CircleAlert, FlaskConical, History, Save, X } from 'lucide';
import { firstValueFrom } from 'rxjs';
import { AgentConfigApi } from '../../api/agent-config-api';
import { ConfirmService } from '../../ui/confirm-dialog';
import { Icon } from '../../ui/icon';
import { NotifyService } from '../../ui/toast';
import { AgentDraft, type ServerIssue } from './agent-draft';
import { TRANSPARENCY_TEXT, describePath, diffConfigs, sectionOf, type FieldChange } from './config-model';
import { Playground } from './playground';

export const AGENT_SECTIONS = [
  { path: 'general', label: 'General' },
  { path: 'negocio', label: 'Negocio' },
  { path: 'conocimiento', label: 'Conocimiento' },
  { path: 'personalidad', label: 'Personalidad y reglas' },
  { path: 'calificacion', label: 'Calificación' },
  { path: 'puntaje', label: 'Puntaje' },
  { path: 'derivacion', label: 'Derivación' },
  { path: 'bandeja', label: 'Bandeja y revisión' },
  { path: 'historial', label: 'Historial' },
] as const;

/**
 * Configuración del agente (tarea 027, owner y admin): una sección por parte de la config, todas sobre el
 * mismo borrador (AgentDraft), con "Guardar" fijo abajo, el resumen de cambios, el historial y el playground.
 * Validan el navegador (el mismo zod) y, al guardar, el servidor: sus errores quedan en cada campo.
 */
@Component({
  selector: 'app-agent-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Playground, RouterLink, RouterLinkActive, RouterOutlet],
  providers: [AgentDraft],
  host: { class: 'block pb-28' },
  template: `
    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 class="text-2xl sm:text-[28px] sm:leading-[34px]">Configuración del agente</h1>
        <p class="mt-1 text-muted">
          Qué responde el asistente, qué datos pide y cuándo pasa la conversación a una persona.
        </p>
        @if (draft.status() === 'ready') {
          <p class="mt-1 text-sm text-subtle" data-testid="agent-version">
            @if (draft.version() > 0) {
              Versión {{ draft.version() }}
              @if (draft.savedBy(); as name) {
                · guardada por {{ name }}
              }
              @if (draft.savedAt(); as at) {
                · {{ when(at) }}
              }
            } @else {
              Todavía no hay una configuración guardada.
            }
          </p>
        }
      </div>
      <button
        type="button"
        class="btn btn-secondary w-full shrink-0 sm:w-auto"
        (click)="playgroundOpen.set(!playgroundOpen())"
        [attr.aria-expanded]="playgroundOpen()"
        data-testid="open-playground"
      >
        <app-icon [icon]="playgroundIcon" [size]="18" /> Probar el agente
      </button>
    </div>

    @if (draft.status() === 'failed') {
      <div class="card mt-5 flex flex-col items-start gap-3 p-5">
        <p class="font-semibold text-text">No pudimos cargar la configuración.</p>
        <button type="button" class="btn btn-secondary btn-sm" (click)="draft.load()">Reintentar</button>
      </div>
    } @else if (draft.status() === 'loading') {
      <p class="mt-5 text-muted">Cargando…</p>
    } @else {
      @if (draft.loadedInvalid()) {
        <p class="mt-4 flex items-start gap-2 rounded-md bg-warning-soft p-3 text-sm text-text">
          <app-icon [icon]="alertIcon" [size]="16" class="mt-0.5 shrink-0 text-warning" />
          La versión guardada tiene datos que ya no son válidos y el asistente no responde hasta que guardes
          una nueva. Revisá los campos marcados.
        </p>
      }
      @if (conflict(); as current) {
        <div class="card mt-4 flex flex-col gap-3 border-warning p-4" role="alert" data-testid="conflict">
          <p class="text-sm text-text">
            <span class="font-semibold">Otra persona guardó la versión {{ current }}</span> mientras editabas.
            Tus cambios no se guardaron.
          </p>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn btn-secondary btn-sm" (click)="compareWithServer(current)">
              Comparar con la mía
            </button>
            <button type="button" class="btn btn-primary btn-sm" (click)="reloadAfterConflict()">
              Recargar (descarta mis cambios)
            </button>
          </div>
          @if (conflictDiff(); as diff) {
            <ul class="max-h-64 overflow-auto rounded-md border border-border text-sm">
              @for (change of diff; track change.path) {
                <li class="border-t border-border p-2 first:border-t-0">
                  <p class="font-medium text-text">{{ describe(change.path) }}</p>
                  <p class="text-muted">Guardada: {{ change.before }}</p>
                  <p class="text-muted">Tuya: {{ change.after }}</p>
                </li>
              } @empty {
                <li class="p-2 text-muted">Son iguales.</li>
              }
            </ul>
          }
        </div>
      }
      @if (issues().length) {
        <div class="card mt-4 border-error p-4" role="alert" data-testid="save-issues">
          <p class="flex items-center gap-2 font-semibold text-error">
            <app-icon [icon]="alertIcon" [size]="16" /> Hay {{ issues().length }} campos para revisar
          </p>
          <ul class="mt-2 flex flex-col gap-1 text-sm">
            @for (issue of issues().slice(0, 8); track $index) {
              <li>
                <a class="text-primary underline" [routerLink]="['/agente', section(issue)]">{{
                  describe(issue.path.join('.'))
                }}</a
                >:
                <span class="text-text">{{ issue.message }}</span>
              </li>
            }
          </ul>
        </div>
      }

      <div class="mt-5 flex flex-col gap-5 lg:flex-row">
        <nav aria-label="Secciones de la configuración" class="lg:w-52 lg:shrink-0">
          <ul
            class="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
          >
            @for (item of sections; track item.path) {
              <li class="shrink-0">
                <a
                  [routerLink]="['/agente', item.path]"
                  routerLinkActive="bg-primary-soft text-primary-strong"
                  [routerLinkActiveOptions]="{ exact: false }"
                  class="flex min-h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-text"
                >
                  @if (item.path === 'historial') {
                    <app-icon [icon]="historyIcon" [size]="16" />
                  }
                  {{ item.label }}
                </a>
              </li>
            }
          </ul>
        </nav>

        <section class="min-w-0 flex-1" aria-live="polite">
          <router-outlet />
        </section>

        @if (playgroundOpen()) {
          <aside
            class="fixed inset-0 z-[900] flex flex-col bg-bg p-4 lg:static lg:z-auto lg:w-[380px] lg:shrink-0 lg:bg-transparent lg:p-0"
            aria-label="Probar el agente"
          >
            <div class="mb-2 flex items-center justify-between lg:hidden">
              <p class="font-semibold text-text">Probar el agente</p>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                (click)="playgroundOpen.set(false)"
                aria-label="Cerrar"
              >
                <app-icon [icon]="closeIcon" [size]="18" />
              </button>
            </div>
            <app-playground class="min-h-0 flex-1" />
          </aside>
        }
      </div>

      <div
        class="fixed inset-x-0 bottom-0 z-[800] border-t border-border bg-surface px-4 py-3 shadow-3 lg:left-[var(--sidebar-width)]"
        data-testid="save-bar"
      >
        <div class="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div class="text-sm">
            @if (draft.dirty()) {
              <button
                type="button"
                class="font-semibold text-text underline"
                (click)="showChanges.set(!showChanges())"
              >
                {{ draft.changes().length }} {{ draft.changes().length === 1 ? 'cambio' : 'cambios' }} sin
                guardar
              </button>
            } @else {
              <span class="text-muted">Sin cambios</span>
            }
          </div>
          <div class="flex gap-2">
            <button
              type="button"
              class="btn btn-secondary flex-1 sm:flex-none"
              [disabled]="!draft.dirty() || draft.saving()"
              (click)="discard()"
            >
              Descartar
            </button>
            <button
              type="button"
              class="btn btn-primary flex-1 sm:flex-none"
              [disabled]="!draft.dirty() || draft.saving()"
              (click)="save()"
              data-testid="save-config"
            >
              <app-icon [icon]="saveIcon" [size]="18" /> {{ draft.saving() ? 'Guardando…' : 'Guardar' }}
            </button>
          </div>
        </div>
        @if (showChanges() && draft.dirty()) {
          <ul
            class="mx-auto mt-2 max-h-48 max-w-6xl overflow-auto rounded-md border border-border text-sm"
            data-testid="pending-changes"
          >
            @for (change of draft.changes().slice(0, 50); track change.path) {
              <li class="border-t border-border p-2 first:border-t-0">
                <span class="font-medium text-text">{{ describe(change.path) }}</span
                >:
                <span class="text-muted">{{ change.before }} → {{ change.after }}</span>
              </li>
            }
          </ul>
        }
      </div>
    }
  `,
})
export class AgentPage implements OnInit {
  readonly draft = inject(AgentDraft);
  private readonly api = inject(AgentConfigApi);
  private readonly confirm = inject(ConfirmService);
  private readonly notify = inject(NotifyService);
  private readonly router = inject(Router);

  protected readonly sections = AGENT_SECTIONS;
  protected readonly playgroundOpen = signal(false);
  protected readonly showChanges = signal(false);
  protected readonly issues = signal<ServerIssue[]>([]);
  protected readonly conflict = signal<number | null>(null);
  protected readonly conflictDiff = signal<FieldChange[] | null>(null);
  protected readonly describe = describePath;
  protected readonly playgroundIcon = FlaskConical;
  protected readonly historyIcon = History;
  protected readonly saveIcon = Save;
  protected readonly alertIcon = CircleAlert;
  protected readonly closeIcon = X;

  constructor() {
    // Aviso del navegador al cerrar o recargar la pestaña con cambios sin guardar.
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (this.draft.dirty()) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('beforeunload', beforeUnload));
  }

  ngOnInit(): void {
    void this.draft.load();
  }

  protected when(iso: string): string {
    return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  }

  protected section(issue: ServerIssue): string {
    return sectionOf(issue.path);
  }

  protected discard(): void {
    this.draft.discard();
    this.issues.set([]);
  }

  async save(confirmTransparency = false): Promise<void> {
    this.conflict.set(null);
    this.conflictDiff.set(null);
    const result = await this.draft.save({ confirmTransparency });
    switch (result.kind) {
      case 'saved':
        this.issues.set([]);
        this.showChanges.set(false);
        this.notify.success(`Guardaste la versión ${result.version}.`);
        break;
      case 'invalid':
        this.issues.set(result.issues);
        if (result.issues[0]) void this.router.navigate(['/agente', sectionOf(result.issues[0].path)]);
        break;
      case 'conflict':
        this.conflict.set(result.currentVersion);
        break;
      case 'confirm_transparency': {
        const ok = await firstValueFrom(
          this.confirm.ask({
            title: 'Activar la revisión de calidad',
            message: TRANSPARENCY_TEXT,
            confirmLabel: 'Ya le avisé al equipo',
          }),
        );
        if (ok) await this.save(true);
        break;
      }
      case 'owner_only':
        this.notify.show('Solo el dueño de la cuenta puede activar la revisión de calidad.');
        break;
      default:
        this.notify.show('No pudimos guardar la configuración. Probá de nuevo.');
    }
  }

  protected async compareWithServer(version: number): Promise<void> {
    try {
      const saved = await firstValueFrom(this.api.version(version));
      this.conflictDiff.set(diffConfigs(saved.config, this.draft.model()));
    } catch {
      this.notify.show('No pudimos traer la versión guardada.');
    }
  }

  protected async reloadAfterConflict(): Promise<void> {
    this.conflict.set(null);
    this.conflictDiff.set(null);
    await this.draft.load();
  }

  /** Para el guard de salida: true si se puede salir (sin cambios, o la persona confirma). */
  canLeave(): Promise<boolean> | boolean {
    if (!this.draft.dirty()) return true;
    return firstValueFrom(
      this.confirm.ask({
        title: 'Tenés cambios sin guardar',
        message: 'Si salís ahora, se pierden los cambios de la configuración.',
        confirmLabel: 'Salir sin guardar',
        cancelLabel: 'Seguir editando',
      }),
    );
  }
}
