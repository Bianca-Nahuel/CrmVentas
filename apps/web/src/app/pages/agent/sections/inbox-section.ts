import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { ALLOWED_MODELS, REVIEW_DEFAULT_MODEL_ID } from '@ventas/shared/ai';
import { Plus, ShieldCheck } from 'lucide';
import { AuthService } from '../../../core/auth/auth.service';
import { Icon } from '../../../ui/icon';
import { AgentDraft } from '../agent-draft';
import { TRANSPARENCY_TEXT } from '../config-model';
import { NumberInput, RowActions, TextInput } from '../form-ui';
import { freeKey } from './personality-section';

/**
 * Bandeja y revisión: qué números ve cada vendedor, el cierre por inactividad y el analista de calidad.
 * Activar el analista es solo del owner, con la confirmación de transparencia (la pide "Guardar"); lo decide
 * la API, acá solo se explica.
 */
@Component({
  selector: 'app-agent-inbox-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, Icon, NumberInput, RowActions, TextInput],
  template: `
    <div class="flex flex-col gap-5">
      <div class="card flex flex-col gap-4 p-5">
        <h2 class="text-lg font-semibold text-text">Bandeja</h2>
        <label class="flex items-start gap-3">
          <input type="checkbox" class="mt-1 size-5" [formField]="form.inbox.sellers_see_all_channels" />
          <span>
            <span class="text-text">Los vendedores ven las conversaciones de todos los números</span>
            <span class="block text-sm text-subtle"
              >Apagado, cada vendedor ve solo los números que tiene asignados.</span
            >
          </span>
        </label>
        <label class="flex items-start gap-3">
          <input
            type="checkbox"
            class="mt-1 size-5"
            [checked]="autoClose() !== null"
            (change)="setAutoClose($any($event.target).checked ? 14 : null)"
          />
          <span class="text-text">Cerrar solas las conversaciones sin mensajes</span>
        </label>
        @if (autoClose() !== null) {
          <label class="flex flex-col gap-1.5">
            <span class="text-sm font-semibold text-text">Días sin mensajes para cerrarla</span>
            <input
              class="input w-32"
              type="number"
              inputmode="numeric"
              [value]="autoClose()"
              (input)="setAutoClose(+$any($event.target).value || 1)"
            />
          </label>
        }
      </div>

      <div class="card flex flex-col gap-4 p-5">
        <h2 class="text-lg font-semibold text-text">Revisión de calidad</h2>
        <p class="text-sm text-subtle">{{ transparency }}</p>
        <label class="flex items-start gap-3">
          <input
            type="checkbox"
            class="mt-1 size-5"
            [formField]="form.review.enabled"
            data-testid="review-enabled"
          />
          <span>
            <span class="text-text">Revisar las conversaciones de los vendedores</span>
            @if (!isOwner() && !model().review.enabled) {
              <span class="block text-sm text-subtle">Solo el dueño de la cuenta puede activarla.</span>
            }
          </span>
        </label>
        @if (model().review.transparency_ack; as ack) {
          <p class="flex items-center gap-2 text-sm text-muted">
            <app-icon [icon]="ackIcon" [size]="16" class="text-success" />
            Transparencia confirmada el {{ date(ack.at) }}.
          </p>
        }
        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-semibold text-text" for="review-model">Modelo del analista</label>
          <select
            id="review-model"
            class="input"
            [value]="model().review.model ?? ''"
            (change)="setReviewModel($any($event.target).value)"
          >
            <option value="">El recomendado ({{ defaultModel }})</option>
            @for (model of models; track model.id) {
              <option [value]="model.id">{{ model.id }}</option>
            }
          </select>
        </div>
        <app-number-input [field]="form.review.max_per_day" label="Revisiones por día como máximo" />
        <label class="flex items-start gap-3">
          <input type="checkbox" class="mt-1 size-5" [formField]="form.review.weekly_digest" />
          <span class="text-text">Armar un resumen semanal por número</span>
        </label>
        <app-text-input
          [field]="form.review.guidance"
          label="Indicaciones para el analista"
          hint="Qué valora tu empresa (por ejemplo: no tutear, ofrecer siempre el envío)."
          [rows]="3"
          [max]="1000"
        />

        <p class="mt-2 text-sm font-semibold text-text">Criterios</p>
        @for (criterion of form.review.criteria; track $index; let i = $index) {
          <div class="flex flex-col gap-3 rounded-md border border-border p-4">
            <div class="flex items-center justify-between">
              <p class="font-semibold text-text">Criterio {{ i + 1 }}</p>
              <app-row-actions
                [list]="form.review.criteria"
                [index]="i"
                [count]="form.review.criteria.length"
                [name]="'criterio ' + (i + 1)"
              />
            </div>
            <app-text-input [field]="criterion.label" label="Nombre" [max]="60" />
            <app-text-input [field]="criterion.description" label="Qué se mira" [max]="300" />
          </div>
        }
        @if (form.review.criteria.length < 8) {
          <button type="button" class="btn btn-secondary btn-sm self-start" (click)="addCriterion()">
            <app-icon [icon]="addIcon" [size]="16" /> Agregar criterio
          </button>
        }
      </div>
    </div>
  `,
})
export class InboxSection {
  private readonly draft = inject(AgentDraft);
  private readonly auth = inject(AuthService);
  protected readonly form = this.draft.form;
  protected readonly model = this.draft.model;
  protected readonly models = ALLOWED_MODELS;
  protected readonly defaultModel = REVIEW_DEFAULT_MODEL_ID;
  protected readonly transparency = TRANSPARENCY_TEXT;
  protected readonly addIcon = Plus;
  protected readonly ackIcon = ShieldCheck;
  protected readonly isOwner = computed(() => this.auth.role() === 'owner');
  protected readonly autoClose = computed(() => this.model().inbox.auto_close_after_days);

  protected date(iso: string) {
    return new Date(iso).toLocaleDateString('es-AR');
  }

  protected setAutoClose(days: number | null) {
    this.draft.model.update((config) => ({
      ...config,
      inbox: { ...config.inbox, auto_close_after_days: days },
    }));
  }

  protected setReviewModel(id: string) {
    this.draft.model.update((config) => {
      const review = { ...config.review };
      if (id) review.model = id;
      else delete review.model;
      return { ...config, review };
    });
  }

  protected addCriterion() {
    this.form.review.criteria().value.update((list) => [
      ...list,
      {
        key: freeKey(
          'criterio',
          list.map((criterion) => criterion.key),
        ),
        label: '',
        description: '',
      },
    ]);
  }
}
