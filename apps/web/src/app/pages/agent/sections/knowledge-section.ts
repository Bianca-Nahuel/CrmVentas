import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Plus } from 'lucide';
import { Icon } from '../../../ui/icon';
import { AgentDraft } from '../agent-draft';
import { NullableInput, RowActions, TextInput } from '../form-ui';

/** Conocimiento: preguntas frecuentes (agregar, editar, reordenar, borrar) y políticas. */
@Component({
  selector: 'app-agent-knowledge-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, NullableInput, RowActions, TextInput],
  template: `
    <div class="flex flex-col gap-5">
      <div class="card flex flex-col gap-4 p-5">
        <div>
          <h2 class="text-lg font-semibold text-text">Preguntas frecuentes</h2>
          <p class="text-sm text-subtle">
            Lo que el asistente puede responder tal cual. Primero las más consultadas.
          </p>
        </div>
        @for (faq of form.knowledge.faqs; track $index; let i = $index) {
          <div class="flex flex-col gap-3 rounded-md border border-border p-4" data-testid="faq">
            <div class="flex items-center justify-between gap-2">
              <p class="font-semibold text-text">Pregunta {{ i + 1 }}</p>
              <app-row-actions
                [list]="form.knowledge.faqs"
                [index]="i"
                [count]="form.knowledge.faqs.length"
                [name]="'pregunta ' + (i + 1)"
              />
            </div>
            <app-text-input [field]="faq.question" label="Pregunta" [max]="300" />
            <app-text-input [field]="faq.answer" label="Respuesta" [rows]="3" [max]="1000" />
          </div>
        } @empty {
          <p class="text-sm text-muted">Todavía no hay preguntas frecuentes.</p>
        }
        @if (form.knowledge.faqs.length < 50) {
          <button
            type="button"
            class="btn btn-secondary btn-sm self-start"
            (click)="addFaq()"
            data-testid="add-faq"
          >
            <app-icon [icon]="addIcon" [size]="16" /> Agregar pregunta
          </button>
        }
      </div>

      <div class="card flex flex-col gap-4 p-5">
        <div>
          <h2 class="text-lg font-semibold text-text">Políticas</h2>
          <p class="text-sm text-subtle">
            Vacío: el asistente no habla del tema y, si se lo preguntan, deriva.
          </p>
        </div>
        <app-nullable-input
          [field]="form.knowledge.policies.returns"
          label="Cambios y devoluciones"
          [rows]="3"
          [max]="1500"
        />
        <app-nullable-input
          [field]="form.knowledge.policies.warranty"
          label="Garantía"
          [rows]="3"
          [max]="1500"
        />
        <app-nullable-input
          [field]="form.knowledge.policies.shipping"
          label="Envíos y retiros"
          [rows]="3"
          [max]="1500"
        />
        <app-nullable-input
          [field]="form.knowledge.policies.financing"
          label="Financiación"
          [rows]="3"
          [max]="1500"
        />
      </div>
    </div>
  `,
})
export class KnowledgeSection {
  protected readonly form = inject(AgentDraft).form;
  protected readonly addIcon = Plus;

  protected addFaq() {
    this.form.knowledge.faqs().value.update((list) => [...list, { question: '', answer: '' }]);
  }
}
