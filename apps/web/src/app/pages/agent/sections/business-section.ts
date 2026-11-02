import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Plus } from 'lucide';
import { Icon } from '../../../ui/icon';
import { AgentDraft } from '../agent-draft';
import { NullableInput, RowActions, TextInput, TextList, WeeklyHoursEditor } from '../form-ui';

/** Negocio: nombre, rubro, sucursales con su horario, horario de atención, pagos, envíos, web y email. */
@Component({
  selector: 'app-agent-business-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, NullableInput, RowActions, TextInput, TextList, WeeklyHoursEditor],
  template: `
    <div class="flex flex-col gap-5">
      <div class="card flex flex-col gap-4 p-5">
        <h2 class="text-lg font-semibold text-text">Negocio</h2>
        <app-text-input [field]="form.business.name" label="Nombre del negocio" [max]="100" />
        <app-text-input
          [field]="form.business.industry"
          label="Rubro"
          hint="Qué vende la empresa, en una frase (por ejemplo: cerámicos, porcelanatos y sanitarios)."
          [max]="100"
        />
        <app-weekly-hours
          [hours]="form.business.service_hours"
          label="Horario de atención del WhatsApp (cuándo responde una persona)"
        />
        <app-text-list
          [items]="form.business.payment_methods"
          label="Medios de pago"
          hint="Lo que el asistente puede contar. Nunca cobra ni pasa datos para pagar."
          placeholder="Transferencia, tarjeta en cuotas…"
          [max]="20"
        />
        <app-nullable-input
          [field]="form.business.shipping"
          label="Envíos"
          [rows]="3"
          [max]="1000"
          hint="Zonas, costos o plazos. Vacío: el asistente no habla de envíos."
        />
        <div class="grid gap-4 sm:grid-cols-2">
          <app-nullable-input
            [field]="form.business.website"
            label="Sitio web"
            type="url"
            placeholder="https://…"
          />
          <app-nullable-input [field]="form.business.email" label="Email de contacto" type="email" />
        </div>
      </div>

      <div class="card flex flex-col gap-4 p-5">
        <h2 class="text-lg font-semibold text-text">Sucursales</h2>
        @for (branch of form.business.branches; track $index; let i = $index) {
          <div class="flex flex-col gap-3 rounded-md border border-border p-4">
            <div class="flex items-center justify-between gap-2">
              <p class="font-semibold text-text">Sucursal {{ i + 1 }}</p>
              <app-row-actions
                [list]="form.business.branches"
                [index]="i"
                [count]="form.business.branches.length"
                [name]="'sucursal ' + (i + 1)"
              />
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <app-text-input [field]="branch.name" label="Nombre" [max]="100" />
              <app-text-input [field]="branch.address" label="Dirección" [max]="200" />
              <app-nullable-input
                [text]="model().business.branches[i]?.phone"
                (valueChange)="setBranch(i, 'phone', $event)"
                label="Teléfono (opcional)"
                type="tel"
                placeholder="+5493511234567"
                hint="Con código de país: +54 9 y el número."
              />
              <app-nullable-input
                [text]="model().business.branches[i]?.notes"
                (valueChange)="setBranch(i, 'notes', $event)"
                label="Notas (opcional)"
                [max]="300"
              />
            </div>
            <app-weekly-hours [hours]="branch.hours" label="Horario de la sucursal" />
          </div>
        }
        @if (form.business.branches.length < 20) {
          <button type="button" class="btn btn-secondary btn-sm self-start" (click)="addBranch()">
            <app-icon [icon]="addIcon" [size]="16" /> Agregar sucursal
          </button>
        }
      </div>
    </div>
  `,
})
export class BusinessSection {
  private readonly draft = inject(AgentDraft);
  protected readonly form = this.draft.form;
  protected readonly model = this.draft.model;
  protected readonly addIcon = Plus;

  /** Teléfono y notas son opcionales: vacío = sin la clave. */
  protected setBranch(index: number, key: 'phone' | 'notes', value: string | undefined) {
    this.form.business.branches().value.update((list) =>
      list.map((branch, i) => {
        if (i !== index) return branch;
        const next = { ...branch };
        if (value === undefined) delete next[key];
        else next[key] = value;
        return next;
      }),
    );
  }

  protected addBranch() {
    const hours = structuredClone(this.draft.model().business.service_hours);
    this.form.business.branches().value.update((list) => [...list, { name: '', address: '', hours }]);
  }
}
