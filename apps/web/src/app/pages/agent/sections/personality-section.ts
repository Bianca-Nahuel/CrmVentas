import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Plus } from 'lucide';
import { Icon } from '../../../ui/icon';
import { AgentDraft } from '../agent-draft';
import { NullableInput, RowActions, TextInput, TextList } from '../form-ui';

/** Una clave que no esté en la lista: prefijo_1, prefijo_2… (el usuario nunca escribe claves). */
export function freeKey(prefix: string, used: readonly string[]): string {
  for (let n = 1; ; n++) if (!used.includes(`${prefix}_${n}`)) return `${prefix}_${n}`;
}

/** Personalidad y reglas: nombre y tono, instrucciones, reglas del negocio, ofertas y lo que nunca debe hacer. */
@Component({
  selector: 'app-agent-personality-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, NullableInput, RowActions, TextInput, TextList],
  template: `
    <div class="flex flex-col gap-5">
      <div class="card flex flex-col gap-4 p-5">
        <h2 class="text-lg font-semibold text-text">Personalidad</h2>
        <app-nullable-input
          [field]="form.agent.persona.name"
          label="Nombre del asistente (opcional)"
          hint="Si lo dejás vacío, se presenta como el asistente de la empresa."
          [max]="40"
        />
        <app-text-input
          [field]="form.agent.persona.tone"
          label="Tono"
          hint="Cómo habla: por ejemplo, cercano y claro, tratando de vos."
          [max]="300"
          data-testid="tone"
        />
        <app-text-input
          [field]="form.agent.custom_instructions"
          label="Instrucciones"
          hint="Indicaciones generales para el asistente. Nunca pueden pasar por encima de las reglas de seguridad del sistema."
          [rows]="5"
          [max]="2000"
        />
        <app-text-input
          [field]="form.agent.sales_guidance"
          label="Guía de sugerencias de venta"
          hint="Qué productos complementarios puede sugerir y cuándo (por ejemplo: pegamento y pastina con un porcelanato)."
          [rows]="4"
          [max]="1500"
        />
      </div>

      <div class="card flex flex-col gap-4 p-5">
        <div>
          <h2 class="text-lg font-semibold text-text">Reglas del negocio</h2>
          <p class="text-sm text-subtle">Cosas que el asistente tiene que tener en cuenta siempre.</p>
        </div>
        @for (rule of form.agent.business_rules; track $index; let i = $index) {
          <div class="flex items-start gap-2" data-testid="business-rule">
            <app-text-input class="flex-1" [field]="rule.text" [label]="'Regla ' + (i + 1)" [max]="300" />
            <app-row-actions
              class="mt-7"
              [list]="form.agent.business_rules"
              [index]="i"
              [count]="form.agent.business_rules.length"
              [name]="'regla ' + (i + 1)"
            />
          </div>
        }
        @if (form.agent.business_rules.length < 30) {
          <button
            type="button"
            class="btn btn-secondary btn-sm self-start"
            (click)="addRule()"
            data-testid="add-rule"
          >
            <app-icon [icon]="addIcon" [size]="16" /> Agregar regla
          </button>
        }
      </div>

      <div class="card flex flex-col gap-4 p-5">
        <div>
          <h2 class="text-lg font-semibold text-text">Ofertas</h2>
          <p class="text-sm text-subtle">Servicios o beneficios que puede ofrecer, y en qué situación.</p>
        </div>
        @for (offer of form.agent.offers; track $index; let i = $index) {
          <div class="flex flex-col gap-3 rounded-md border border-border p-4">
            <div class="flex items-center justify-between">
              <p class="font-semibold text-text">Oferta {{ i + 1 }}</p>
              <app-row-actions
                [list]="form.agent.offers"
                [index]="i"
                [count]="form.agent.offers.length"
                [name]="'oferta ' + (i + 1)"
              />
            </div>
            <app-text-input [field]="offer.description" label="Qué se ofrece" [max]="300" />
            <app-text-input [field]="offer.when" label="Cuándo ofrecerla" [max]="300" />
          </div>
        }
        @if (form.agent.offers.length < 15) {
          <button type="button" class="btn btn-secondary btn-sm self-start" (click)="addOffer()">
            <app-icon [icon]="addIcon" [size]="16" /> Agregar oferta
          </button>
        }
      </div>

      <div class="card p-5">
        <app-text-list
          [items]="form.agent.must_not"
          label="Cosas que nunca debe hacer"
          hint="Se suman a las prohibiciones fijas del sistema (negociar, prometer, reservar, cobrar)."
          placeholder="Hablar de la competencia"
          [max]="30"
        />
      </div>
    </div>
  `,
})
export class PersonalitySection {
  private readonly draft = inject(AgentDraft);
  protected readonly form = this.draft.form;
  protected readonly addIcon = Plus;

  protected addRule() {
    this.form.agent.business_rules().value.update((list) => [
      ...list,
      {
        id: freeKey(
          'regla',
          list.map((rule) => rule.id),
        ),
        text: '',
      },
    ]);
  }

  protected addOffer() {
    this.form.agent.offers().value.update((list) => [
      ...list,
      {
        id: freeKey(
          'oferta',
          list.map((offer) => offer.id),
        ),
        description: '',
        when: '',
      },
    ]);
  }
}
