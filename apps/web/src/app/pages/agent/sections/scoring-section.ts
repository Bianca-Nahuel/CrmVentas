import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { computeScore, tenantConfigSchema } from '@ventas/shared/ai';
import { Plus } from 'lucide';
import { Icon } from '../../../ui/icon';
import { Score } from '../../../ui/score';
import { AgentDraft } from '../agent-draft';
import { NumberInput, RowActions, TextInput } from '../form-ui';
import { freeKey } from './personality-section';

/**
 * Puntaje: dimensiones con su peso, peso de la completitud y umbrales, con una vista de ejemplo calculada
 * en el navegador con la misma función que usa la API (computeScore de libs/shared).
 */
@Component({
  selector: 'app-agent-scoring-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, NumberInput, RowActions, Score, TextInput],
  template: `
    <div class="flex flex-col gap-5">
      <div class="card flex flex-col gap-4 p-5">
        <div>
          <h2 class="text-lg font-semibold text-text">Qué mira el puntaje</h2>
          <p class="text-sm text-subtle">
            El asistente da una señal de 0 a 5 en cada aspecto y el sistema calcula el puntaje con estos
            pesos.
          </p>
        </div>
        @for (dimension of form.scoring.dimensions; track $index; let i = $index) {
          <div class="flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-start">
            <app-text-input
              class="flex-1"
              [field]="dimension.description"
              [label]="'Aspecto ' + (i + 1)"
              [max]="300"
            />
            <app-number-input [field]="dimension.weight" label="Peso" />
            <app-row-actions
              class="sm:mt-7"
              [list]="form.scoring.dimensions"
              [index]="i"
              [count]="form.scoring.dimensions.length"
              [name]="'aspecto ' + (i + 1)"
            />
          </div>
        }
        @if (form.scoring.dimensions.length < 8) {
          <button type="button" class="btn btn-secondary btn-sm self-start" (click)="addDimension()">
            <app-icon [icon]="addIcon" [size]="16" /> Agregar aspecto
          </button>
        }
        <app-number-input
          [field]="form.scoring.completeness_weight"
          label="Peso de los datos obligatorios"
          hint="Cuánto suma tener todos los datos obligatorios de la calificación."
        />
        <div class="grid gap-4 sm:grid-cols-2">
          <app-number-input [field]="form.scoring.thresholds.hot" label="Caliente desde" hint="De 1 a 100." />
          <app-number-input
            [field]="form.scoring.thresholds.warm"
            label="Tibio desde"
            hint="Menor que el de caliente."
          />
        </div>
      </div>

      <div class="card flex flex-col gap-4 p-5" data-testid="score-preview">
        <div>
          <h2 class="text-lg font-semibold text-text">Vista de ejemplo</h2>
          <p class="text-sm text-subtle">
            Mové las señales para ver qué puntaje y nivel saldrían con esta configuración.
          </p>
        </div>
        @for (dimension of model().scoring.dimensions; track dimension.key) {
          <label class="flex flex-col gap-1">
            <span class="text-sm text-text"
              >{{ dimension.description || dimension.key }}: {{ signals()[dimension.key] ?? 0 }}/5</span
            >
            <input
              type="range"
              min="0"
              max="5"
              step="1"
              [value]="signals()[dimension.key] ?? 0"
              (input)="setSignal(dimension.key, $any($event.target).value)"
            />
          </label>
        }
        @if (requiredCount() > 0) {
          <label class="flex flex-col gap-1">
            <span class="text-sm text-text"
              >Datos obligatorios obtenidos: {{ obtained() }} de {{ requiredCount() }}</span
            >
            <input
              type="range"
              min="0"
              [max]="requiredCount()"
              step="1"
              [value]="obtained()"
              (input)="obtained.set(+$any($event.target).value)"
            />
          </label>
        }
        @if (preview(); as result) {
          <app-score [score]="result.score" [level]="result.tier" variant="full" />
        } @else {
          <p class="text-sm text-muted">Completá los pesos y umbrales para ver el ejemplo.</p>
        }
      </div>
    </div>
  `,
})
export class ScoringSection {
  private readonly draft = inject(AgentDraft);
  protected readonly form = this.draft.form;
  protected readonly model = this.draft.model;
  protected readonly addIcon = Plus;
  protected readonly signals = signal<Record<string, number>>({});
  protected readonly obtained = signal(0);

  protected readonly requiredCount = computed(
    () => this.model().qualification.fields.filter((field) => field.required).length,
  );

  /** El puntaje con las señales de prueba. null si la sección todavía no valida (pesos vacíos, umbrales al revés). */
  protected readonly preview = computed(() => {
    const parsed = tenantConfigSchema.shape.scoring.safeParse(this.model().scoring);
    if (!parsed.success) return null;
    const config = { ...this.model(), scoring: parsed.data };
    const required = config.qualification.fields.filter((field) => field.required).map((field) => field.key);
    const obtainedKeys = new Set(required.slice(0, Math.min(this.obtained(), required.length)));
    const signals = Object.fromEntries(
      Object.entries(this.signals()).map(([key, score]) => [key, { score }]),
    );
    return computeScore(config, signals, obtainedKeys);
  });

  protected setSignal(key: string, value: string) {
    this.signals.update((current) => ({ ...current, [key]: Number(value) }));
  }

  protected addDimension() {
    this.form.scoring.dimensions().value.update((list) => [
      ...list,
      {
        key: freeKey(
          'aspecto',
          list.map((dimension) => dimension.key),
        ),
        description: '',
        weight: 1,
      },
    ]);
  }
}
