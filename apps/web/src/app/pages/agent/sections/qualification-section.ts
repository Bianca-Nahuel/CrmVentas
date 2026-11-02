import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { QUALIFICATION_FIELD_TYPES, type QualificationField } from '@ventas/shared/ai';
import { CircleAlert, Plus } from 'lucide';
import { Icon } from '../../../ui/icon';
import { AgentDraft } from '../agent-draft';
import { asksSensitiveData } from '../config-model';
import { NumberInput, RowActions, TextInput, TextList, fieldError } from '../form-ui';
import { freeKey } from './personality-section';

const TYPE_LABELS: Record<(typeof QUALIFICATION_FIELD_TYPES)[number], string> = {
  string: 'Texto',
  number: 'Número',
  date: 'Fecha',
  enum: 'Una opción de una lista',
  boolean: 'Sí o no',
};

/** Calificación: los datos a obtener, la guía de descubrimiento y los límites de preguntas y turnos. */
@Component({
  selector: 'app-agent-qualification-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, Icon, NumberInput, RowActions, TextInput, TextList],
  template: `
    <div class="flex flex-col gap-5">
      <div class="card flex flex-col gap-4 p-5">
        <div>
          <h2 class="text-lg font-semibold text-text">Datos a obtener</h2>
          <p class="text-sm text-subtle">
            Lo que el asistente le pregunta a cada interesado antes de pasarlo a un vendedor, por prioridad.
          </p>
        </div>
        @for (field of form.qualification.fields; track $index; let i = $index) {
          <div
            class="flex flex-col gap-3 rounded-md border border-border p-4"
            data-testid="qualification-field"
          >
            <div class="flex items-center justify-between gap-2">
              <p class="font-semibold text-text">
                {{ model().qualification.fields[i]?.label || 'Dato ' + (i + 1) }}
              </p>
              <app-row-actions
                [list]="form.qualification.fields"
                [index]="i"
                [count]="form.qualification.fields.length"
                [name]="'dato ' + (i + 1)"
              />
            </div>
            @if (sensitive(i)) {
              <p
                class="flex items-start gap-2 rounded-md bg-error-soft p-2.5 text-sm text-error"
                role="alert"
              >
                <app-icon [icon]="alertIcon" [size]="16" class="mt-0.5 shrink-0" />
                El asistente no puede pedir datos sensibles (DNI, tarjeta, CBU o CVU, contraseñas o códigos):
                no se va a poder guardar.
              </p>
            } @else if (error(field); as message) {
              <p class="text-sm font-medium text-error">{{ message }}</p>
            }
            <div class="grid gap-3 sm:grid-cols-2">
              <app-text-input [field]="field.label" label="Nombre del dato" [max]="60" />
              <div class="flex flex-col gap-1.5">
                <label class="text-sm font-semibold text-text" [attr.for]="'qtype-' + i">Tipo</label>
                <select
                  class="input"
                  [id]="'qtype-' + i"
                  [value]="model().qualification.fields[i]?.type"
                  (change)="setType(i, $any($event.target).value)"
                >
                  @for (type of types; track type) {
                    <option [value]="type">{{ typeLabels[type] }}</option>
                  }
                </select>
              </div>
            </div>
            @if (model().qualification.fields[i]?.type === 'enum') {
              <app-text-list
                [items]="$any(field.options)"
                label="Opciones"
                [max]="20"
                addLabel="Agregar opción"
              />
            }
            <app-text-input
              [field]="field.how_to_ask"
              label="Cómo preguntarlo"
              hint="La pregunta tal como se la haría a un cliente. El asistente la adapta a la conversación."
              [max]="200"
            />
            <div class="flex flex-wrap items-end gap-4">
              <label class="flex min-h-11 items-center gap-2">
                <input type="checkbox" class="size-5" [formField]="field.required" />
                <span class="text-sm text-text">Obligatorio para derivar</span>
              </label>
              <app-number-input [field]="field.priority" label="Prioridad" hint="1 = se pregunta primero." />
              <div class="flex flex-col gap-1.5">
                <label class="text-sm font-semibold text-text" [attr.for]="'qscore-' + i">
                  Preguntar desde el puntaje
                </label>
                <input
                  class="input w-32"
                  type="number"
                  inputmode="numeric"
                  [id]="'qscore-' + i"
                  [value]="model().qualification.fields[i]?.ask_when_score_gte ?? ''"
                  (input)="setScoreGate(i, $any($event.target).value)"
                  placeholder="Siempre"
                />
              </div>
            </div>
          </div>
        } @empty {
          <p class="text-sm text-muted">
            Sin datos: el asistente califica solo con la guía de descubrimiento.
          </p>
        }
        @if (form.qualification.fields.length < 15) {
          <button type="button" class="btn btn-secondary btn-sm self-start" (click)="addField()">
            <app-icon [icon]="addIcon" [size]="16" /> Agregar dato
          </button>
        }
      </div>

      <div class="card flex flex-col gap-4 p-5">
        <h2 class="text-lg font-semibold text-text">Cómo conversar</h2>
        <app-text-input
          [field]="form.qualification.discovery_guidance"
          label="Guía de descubrimiento"
          hint="Qué conviene averiguar además de los datos de arriba (para qué ambiente, estilo, presupuesto…)."
          [rows]="4"
          [max]="2000"
        />
        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-semibold text-text" for="q-per-message">Preguntas por mensaje</label>
          <select
            id="q-per-message"
            class="input w-32"
            [value]="model().qualification.max_questions_per_message"
            (change)="setPerMessage($any($event.target).value)"
          >
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </div>
        <app-number-input
          [field]="form.qualification.max_qualification_turns"
          label="Mensajes como máximo para calificar"
          hint="Pasados estos, deriva aunque falten datos."
        />
        <app-number-input
          [field]="form.qualification.max_turns_when_hot"
          label="Mensajes de más con un interesado caliente"
          hint="Con un lead caliente, cuántos mensajes más antes de derivar (0 = deriva enseguida)."
        />
      </div>
    </div>
  `,
})
export class QualificationSection {
  private readonly draft = inject(AgentDraft);
  protected readonly form = this.draft.form;
  protected readonly model = this.draft.model;
  protected readonly types = QUALIFICATION_FIELD_TYPES;
  protected readonly typeLabels = TYPE_LABELS;
  protected readonly addIcon = Plus;
  protected readonly alertIcon = CircleAlert;
  protected readonly error = fieldError;

  protected sensitive(index: number): boolean {
    const field = this.model().qualification.fields[index];
    return !!field && asksSensitiveData(field);
  }

  private updateField(index: number, fn: (field: QualificationField) => QualificationField) {
    this.form.qualification
      .fields()
      .value.update((list) => list.map((field, i) => (i === index ? fn(field) : field)));
  }

  protected setType(index: number, type: QualificationField['type']) {
    this.updateField(index, (field) => {
      const next = { ...field, type };
      if (type === 'enum') next.options = field.options ?? ['', ''];
      else delete next.options;
      return next;
    });
  }

  protected setScoreGate(index: number, raw: string) {
    this.updateField(index, (field) => {
      const next = { ...field };
      if (raw === '') delete next.ask_when_score_gte;
      else next.ask_when_score_gte = Number(raw);
      return next;
    });
  }

  protected setPerMessage(value: string) {
    this.form.qualification.max_questions_per_message().value.set(value === '2' ? 2 : 1);
  }

  protected addField() {
    this.form.qualification.fields().value.update((list) => [
      ...list,
      {
        key: freeKey(
          'dato',
          list.map((field) => field.key),
        ),
        label: '',
        type: 'string',
        how_to_ask: '',
        required: false,
        priority: list.length + 1,
      },
    ]);
  }
}
