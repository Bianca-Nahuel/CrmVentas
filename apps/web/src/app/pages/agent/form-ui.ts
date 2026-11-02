import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormField, type FieldTree } from '@angular/forms/signals';
import type { WeeklyHours } from '@ventas/shared/ai';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide';
import { Icon } from '../../ui/icon';
import { DAYS, DAY_LABELS } from './config-model';

/**
 * El primer error de un campo, cuando corresponde mostrarlo: después de tocarlo o de intentar guardar, o
 * si vino del servidor. Siempre texto (los mensajes los arma el código, nunca HTML).
 */
export function fieldError(field: FieldTree<unknown> | null | undefined): string | null {
  if (!field) return null;
  const state = field();
  const errors = state.errors();
  if (errors.length === 0) return null;
  const server = errors.find((error) => error.kind === 'server');
  if (!state.touched() && !server) return null;
  return (server ?? errors[0])?.message ?? 'Revisá este campo.';
}

/** Mueve un elemento de una lista (para reordenar con botones, accesible con teclado). */
export function move<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return [...list];
  const copy = [...list];
  [copy[index], copy[target]] = [copy[target]!, copy[index]!];
  return copy;
}

/** Lista de textos cortos (medios de pago, cosas que nunca debe hacer, palabras…): agregar, editar, borrar. */
@Component({
  selector: 'app-text-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, Icon],
  host: { class: 'flex flex-col gap-1.5' },
  template: `
    <p class="text-sm font-semibold text-text">{{ label() }}</p>
    @if (hint()) {
      <p class="text-sm text-subtle">{{ hint() }}</p>
    }
    <ul class="flex flex-col gap-2">
      @for (item of items(); track $index; let i = $index) {
        <li class="flex items-start gap-2">
          <div class="flex-1">
            <input
              class="input"
              [formField]="item"
              [attr.aria-label]="label() + ' ' + (i + 1)"
              [attr.aria-invalid]="error(item) ? 'true' : null"
              [placeholder]="placeholder()"
            />
            @if (error(item); as message) {
              <p class="mt-1 text-sm font-medium text-error">{{ message }}</p>
            }
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            (click)="remove(i)"
            [attr.aria-label]="'Quitar ' + label().toLocaleLowerCase('es-AR') + ' ' + (i + 1)"
          >
            <app-icon [icon]="removeIcon" [size]="16" />
          </button>
        </li>
      }
    </ul>
    @if (items()().value().length < max()) {
      <button type="button" class="btn btn-secondary btn-sm self-start" (click)="add()">
        <app-icon [icon]="addIcon" [size]="16" /> {{ addLabel() }}
      </button>
    }
  `,
})
export class TextList {
  readonly items = input.required<FieldTree<string[]>>();
  readonly label = input.required<string>();
  readonly hint = input<string>();
  readonly placeholder = input('');
  readonly addLabel = input('Agregar');
  readonly max = input(30);
  protected readonly addIcon = Plus;
  protected readonly removeIcon = Trash2;
  protected readonly error = fieldError;

  protected add() {
    this.items()().value.update((list) => [...list, '']);
  }

  protected remove(index: number) {
    this.items()().value.update((list) => list.filter((_, i) => i !== index));
  }
}

/** Botones de una fila de lista: subir, bajar y borrar. */
@Component({
  selector: 'app-row-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'flex shrink-0 items-center gap-1' },
  template: `
    <button
      type="button"
      class="btn btn-ghost btn-sm"
      [disabled]="index() === 0"
      (click)="action('up')"
      [attr.aria-label]="'Subir ' + name()"
    >
      <app-icon [icon]="upIcon" [size]="16" />
    </button>
    <button
      type="button"
      class="btn btn-ghost btn-sm"
      [disabled]="index() === count() - 1"
      (click)="action('down')"
      [attr.aria-label]="'Bajar ' + name()"
    >
      <app-icon [icon]="downIcon" [size]="16" />
    </button>
    <button
      type="button"
      class="btn btn-ghost btn-sm"
      (click)="action('remove')"
      [attr.aria-label]="'Borrar ' + name()"
    >
      <app-icon [icon]="removeIcon" [size]="16" />
    </button>
  `,
})
export class RowActions<T> {
  readonly list = input.required<FieldTree<T[]>>();
  readonly index = input.required<number>();
  readonly count = input.required<number>();
  readonly name = input.required<string>();
  protected readonly upIcon = ArrowUp;
  protected readonly downIcon = ArrowDown;
  protected readonly removeIcon = Trash2;

  protected action(kind: 'up' | 'down' | 'remove') {
    const index = this.index();
    this.list()().value.update((items) =>
      kind === 'remove' ? items.filter((_, i) => i !== index) : move(items, index, kind === 'up' ? -1 : 1),
    );
  }
}

/** Horario semanal: hasta 3 franjas por día; sin franjas = cerrado. */
@Component({
  selector: 'app-weekly-hours',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, Icon],
  host: { class: 'flex flex-col gap-2' },
  template: `
    <p class="text-sm font-semibold text-text">{{ label() }}</p>
    <div class="flex flex-col divide-y divide-border rounded-md border border-border">
      @for (day of days; track day) {
        <div class="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
          <p class="w-28 shrink-0 pt-2 text-sm font-medium text-text">{{ dayLabels[day] }}</p>
          <div class="flex flex-1 flex-col gap-2">
            @for (range of hours()[day]; track $index; let i = $index) {
              <div class="flex flex-wrap items-center gap-2">
                <input
                  type="time"
                  class="input w-32"
                  [formField]="range.open"
                  [attr.aria-label]="dayLabels[day] + ', abre (franja ' + (i + 1) + ')'"
                />
                <span class="text-sm text-muted">a</span>
                <input
                  type="time"
                  class="input w-32"
                  [formField]="range.close"
                  [attr.aria-label]="dayLabels[day] + ', cierra (franja ' + (i + 1) + ')'"
                />
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  (click)="removeRange(day, i)"
                  [attr.aria-label]="'Quitar franja ' + (i + 1) + ' del ' + dayLabels[day]"
                >
                  <app-icon [icon]="removeIcon" [size]="16" />
                </button>
                @if (rangeError(day, i); as message) {
                  <p class="w-full text-sm font-medium text-error">{{ message }}</p>
                }
              </div>
            } @empty {
              <p class="pt-2 text-sm text-subtle">Cerrado</p>
            }
            @if (hours()[day]().value().length < 3) {
              <button type="button" class="btn btn-ghost btn-sm self-start" (click)="addRange(day)">
                <app-icon [icon]="addIcon" [size]="16" /> Agregar franja
              </button>
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class WeeklyHoursEditor {
  readonly hours = input.required<FieldTree<WeeklyHours>>();
  readonly label = input.required<string>();
  protected readonly days = DAYS;
  protected readonly dayLabels = DAY_LABELS;
  protected readonly addIcon = Plus;
  protected readonly removeIcon = Trash2;

  protected rangeError(day: (typeof DAYS)[number], index: number) {
    const range = this.hours()[day][index];
    return fieldError(range) ?? fieldError(range?.open) ?? fieldError(range?.close);
  }

  protected addRange(day: (typeof DAYS)[number]) {
    this.hours()
      [day]()
      .value.update((ranges) => [...ranges, { open: '09:00', close: '13:00' }]);
  }

  protected removeRange(day: (typeof DAYS)[number], index: number) {
    this.hours()
      [day]()
      .value.update((ranges) => ranges.filter((_, i) => i !== index));
  }
}

let nextId = 0;

/** Campo de texto (o párrafo) con etiqueta, ayuda, contador y error, enlazado con [formField]. */
@Component({
  selector: 'app-text-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField],
  host: { class: 'flex flex-col gap-1.5' },
  template: `
    <label class="text-sm font-semibold text-text" [attr.for]="id">{{ label() }}</label>
    @if (rows() > 1) {
      <textarea
        class="input min-h-24 py-2"
        [id]="id"
        [rows]="rows()"
        [formField]="field()"
        [attr.aria-describedby]="hint() ? id + '-hint' : null"
        [attr.aria-invalid]="error() ? 'true' : null"
        [placeholder]="placeholder()"
      ></textarea>
    } @else {
      <input
        class="input"
        [id]="id"
        [type]="type()"
        [formField]="field()"
        [attr.aria-describedby]="hint() ? id + '-hint' : null"
        [attr.aria-invalid]="error() ? 'true' : null"
        [placeholder]="placeholder()"
      />
    }
    <div class="flex justify-between gap-3">
      @if (hint()) {
        <p class="text-sm text-subtle" [id]="id + '-hint'">{{ hint() }}</p>
      }
      @if (max()) {
        <p class="tabular ml-auto shrink-0 text-xs text-subtle">{{ field()().value().length }}/{{ max() }}</p>
      }
    </div>
    @if (error(); as message) {
      <p class="text-sm font-medium text-error">{{ message }}</p>
    }
  `,
})
export class TextInput {
  readonly field = input.required<FieldTree<string>>();
  readonly label = input.required<string>();
  readonly hint = input<string>();
  readonly placeholder = input('');
  readonly rows = input(1);
  readonly max = input(0);
  readonly type = input<'text' | 'email' | 'url'>('text');
  protected readonly id = `ti-${++nextId}`;
  protected error() {
    return fieldError(this.field());
  }
}

/**
 * Texto que puede quedar sin valor (web, email, políticas, nombre del asistente): vacío = null (o sin la
 * clave, con optional). [formField] no acepta null, así que se enlaza a mano.
 */
@Component({
  selector: 'app-nullable-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-1.5' },
  template: `
    <label class="text-sm font-semibold text-text" [attr.for]="id">{{ label() }}</label>
    @if (rows() > 1) {
      <textarea
        class="input min-h-24 py-2"
        [id]="id"
        [rows]="rows()"
        [value]="value()"
        (input)="set($any($event.target).value)"
        (blur)="touch()"
        [attr.maxlength]="max() || null"
        [attr.aria-invalid]="error() ? 'true' : null"
        [placeholder]="placeholder()"
      ></textarea>
    } @else {
      <input
        class="input"
        [id]="id"
        [type]="type()"
        [value]="value()"
        (input)="set($any($event.target).value)"
        (blur)="touch()"
        [attr.maxlength]="max() || null"
        [attr.aria-invalid]="error() ? 'true' : null"
        [placeholder]="placeholder()"
      />
    }
    @if (hint()) {
      <p class="text-sm text-subtle">{{ hint() }}</p>
    }
    @if (error(); as message) {
      <p class="text-sm font-medium text-error">{{ message }}</p>
    }
  `,
})
export class NullableInput {
  /** El campo del formulario; sin él, text + valueChange (para claves opcionales, que pueden no existir). */
  readonly field = input<FieldTree<string | null | undefined>>();
  readonly text = input<string | null | undefined>(undefined);
  readonly valueChange = output<string | undefined>();
  readonly label = input.required<string>();
  readonly hint = input<string>();
  readonly placeholder = input('');
  readonly rows = input(1);
  readonly max = input(0);
  readonly type = input<'text' | 'email' | 'url' | 'tel'>('text');
  /** Qué queda cuando se borra: null (campos nullable) o undefined (campos opcionales). */
  readonly empty = input<null | undefined>(null);
  protected readonly id = `ni-${++nextId}`;

  protected value() {
    const field = this.field();
    return (field ? field().value() : this.text()) ?? '';
  }

  protected set(text: string) {
    const field = this.field();
    if (field) field().value.set(text.trim() === '' ? this.empty() : text);
    else this.valueChange.emit(text.trim() === '' ? undefined : text);
  }

  protected touch() {
    this.field()?.().markAsTouched();
  }

  protected error() {
    return fieldError(this.field());
  }
}

/** Número con etiqueta, ayuda y error. */
@Component({
  selector: 'app-number-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField],
  host: { class: 'flex flex-col gap-1.5' },
  template: `
    <label class="text-sm font-semibold text-text" [attr.for]="id">{{ label() }}</label>
    <input
      class="input w-32"
      type="number"
      inputmode="numeric"
      [id]="id"
      [formField]="field()"
      [attr.aria-invalid]="error() ? 'true' : null"
    />
    @if (hint()) {
      <p class="text-sm text-subtle">{{ hint() }}</p>
    }
    @if (error(); as message) {
      <p class="text-sm font-medium text-error">{{ message }}</p>
    }
  `,
})
export class NumberInput {
  readonly field = input.required<FieldTree<number>>();
  readonly label = input.required<string>();
  readonly hint = input<string>();
  protected readonly id = `nu-${++nextId}`;
  protected error() {
    return fieldError(this.field());
  }
}
