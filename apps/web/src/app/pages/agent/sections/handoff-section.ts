import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FormField, type FieldTree } from '@angular/forms/signals';
import { CRITICAL_TRIGGERS, PREDEFINED_TRIGGERS, type HandoffMode } from '@ventas/shared/ai';
import { Plus } from 'lucide';
import { Icon } from '../../../ui/icon';
import { AgentDraft } from '../agent-draft';
import { TRIGGER_LABELS } from '../config-model';
import { RowActions, TextInput, TextList, fieldError } from '../form-ui';

/** Modo de un disparador: derivar enseguida o primero pedir algunos datos (con un texto de introducción). */
@Component({
  selector: 'app-handoff-mode',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-2' },
  template: `
    <select
      class="input"
      [attr.aria-label]="'Qué hacer: ' + name()"
      [value]="mode()().value().type"
      (change)="setType($any($event.target).value)"
    >
      <option value="immediate">Derivar enseguida</option>
      <option value="after_fields">Primero pedir algunos datos</option>
    </select>
    @if (afterFields(); as current) {
      <fieldset class="flex flex-col gap-1">
        <legend class="text-sm font-semibold text-text">Qué datos pedir (hasta 5)</legend>
        @for (field of fields(); track field.key) {
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              class="size-4"
              [checked]="current.fields.includes(field.key)"
              (change)="toggleField(field.key, $any($event.target).checked)"
            />
            {{ field.label || field.key }}
          </label>
        } @empty {
          <p class="text-sm text-muted">Primero agregá datos en Calificación.</p>
        }
      </fieldset>
      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-semibold text-text">Texto antes de las preguntas</span>
        <input
          class="input"
          maxlength="300"
          [value]="current.intro[language()] ?? ''"
          (input)="setIntro($any($event.target).value)"
          placeholder="Antes de pasarte con un vendedor, contame…"
        />
      </label>
      @if (error(); as message) {
        <p class="text-sm font-medium text-error">{{ message }}</p>
      }
    }
  `,
})
export class HandoffModeEditor {
  readonly mode = input.required<FieldTree<HandoffMode>>();
  readonly name = input.required<string>();
  readonly fields = input.required<readonly { key: string; label: string }[]>();
  readonly language = input.required<string>();

  protected readonly afterFields = computed(() => {
    const value = this.mode()().value();
    return value.type === 'after_fields' ? value : null;
  });

  protected error() {
    const tree = this.mode() as unknown as Record<string, FieldTree<unknown>>;
    return fieldError(this.mode()) ?? fieldError(tree['fields']) ?? fieldError(tree['intro']);
  }

  protected setType(type: HandoffMode['type']) {
    this.mode()().value.set(type === 'immediate' ? { type } : { type, fields: [], intro: {} });
  }

  protected toggleField(key: string, checked: boolean) {
    const current = this.afterFields();
    if (!current) return;
    const fields = checked
      ? [...new Set([...current.fields, key])].slice(0, 5)
      : current.fields.filter((k) => k !== key);
    this.mode()().value.set({ ...current, fields });
  }

  protected setIntro(text: string) {
    const current = this.afterFields();
    if (!current) return;
    const intro = { ...current.intro };
    if (text.trim()) intro[this.language()] = text;
    else delete intro[this.language()];
    this.mode()().value.set({ ...current, intro });
    this.mode()().markAsTouched();
  }
}

/** Derivación: cuándo pasa la conversación a una persona, con qué texto y qué hacer con audios e imágenes. */
@Component({
  selector: 'app-agent-handoff-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, HandoffModeEditor, Icon, RowActions, TextInput, TextList],
  template: `
    <div class="flex flex-col gap-5">
      <div class="card flex flex-col gap-4 p-5">
        <div>
          <h2 class="text-lg font-semibold text-text">Cuándo deriva a una persona</h2>
          <p class="text-sm text-subtle">
            Después de derivar, el asistente ya no escribe más en esa conversación (salvo el texto fijo, una
            vez).
          </p>
        </div>
        @for (id of triggers; track id) {
          <div class="flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-start">
            <label class="flex flex-1 items-start gap-3">
              <input type="checkbox" class="mt-1 size-5" [formField]="form.handoff.triggers[id].enabled" />
              <span class="text-text">{{ labels[id] }}</span>
            </label>
            @if (model().handoff.triggers[id].enabled) {
              <app-handoff-mode
                class="sm:w-72"
                [mode]="form.handoff.triggers[id].mode"
                [name]="labels[id]"
                [fields]="model().qualification.fields"
                [language]="model().business.language"
              />
            }
          </div>
        }
      </div>

      <div class="card flex flex-col gap-4 p-5">
        <div>
          <h2 class="text-lg font-semibold text-text">Situaciones propias</h2>
          <p class="text-sm text-subtle">
            Otras situaciones en las que querés que derive (por ejemplo, una obra grande).
          </p>
        </div>
        @for (trigger of form.handoff.custom_triggers; track $index; let i = $index) {
          <div class="flex flex-col gap-3 rounded-md border border-border p-4">
            <div class="flex items-center justify-between">
              <p class="font-semibold text-text">Situación {{ i + 1 }}</p>
              <app-row-actions
                [list]="form.handoff.custom_triggers"
                [index]="i"
                [count]="form.handoff.custom_triggers.length"
                [name]="'situación ' + (i + 1)"
              />
            </div>
            <app-text-input [field]="trigger.description" label="Cuándo" [max]="300" />
            <app-handoff-mode
              [mode]="trigger.mode"
              [name]="'situación ' + (i + 1)"
              [fields]="model().qualification.fields"
              [language]="model().business.language"
            />
          </div>
        }
        @if (form.handoff.custom_triggers.length < 15) {
          <button type="button" class="btn btn-secondary btn-sm self-start" (click)="addCustom()">
            <app-icon [icon]="addIcon" [size]="16" /> Agregar situación
          </button>
        }
      </div>

      <div class="card flex flex-col gap-4 p-5">
        <div>
          <h2 class="text-lg font-semibold text-text">Palabras que disparan la derivación</h2>
          <p class="text-sm text-subtle">
            Para pedir una persona, preguntar por stock o querer pagar, el sistema también busca frases. Podés
            sumar las de tu negocio o sacar las que no correspondan.
          </p>
        </div>
        @for (id of critical; track id) {
          <div class="flex flex-col gap-3 rounded-md border border-border p-4">
            <p class="font-semibold text-text">{{ labels[id] }}</p>
            @if (model().handoff.keywords[id]) {
              <div class="grid gap-4 sm:grid-cols-2">
                <app-text-list
                  [items]="$any(form.handoff.keywords[id]).extra"
                  label="Frases extra"
                  [max]="30"
                />
                <app-text-list
                  [items]="$any(form.handoff.keywords[id]).exclude"
                  label="Frases a ignorar"
                  [max]="30"
                />
              </div>
            } @else {
              <button type="button" class="btn btn-ghost btn-sm self-start" (click)="addKeywords(id)">
                <app-icon [icon]="addIcon" [size]="16" /> Personalizar frases
              </button>
            }
          </div>
        }
      </div>

      <div class="card flex flex-col gap-4 p-5">
        <h2 class="text-lg font-semibold text-text">Textos fijos de derivación</h2>
        <app-text-input
          [field]="form.handoff.message_in_hours"
          label="En horario de atención"
          [rows]="2"
          [max]="500"
        />
        <app-text-input
          [field]="form.handoff.message_after_hours"
          label="Fuera de horario"
          [rows]="2"
          [max]="500"
        />
        <label class="flex items-start gap-3">
          <input type="checkbox" class="mt-1 size-5" [formField]="form.handoff.qualify_after_hours" />
          <span>
            <span class="text-text">Fuera de horario, seguir preguntando los datos</span>
            <span class="block text-sm text-subtle"
              >Así el vendedor encuentra la consulta completa al abrir.</span
            >
          </span>
        </label>
      </div>

      <div class="card flex flex-col gap-3 p-5">
        <h2 class="text-lg font-semibold text-text">Audios e imágenes</h2>
        <p class="text-sm text-subtle">El asistente todavía no escucha audios ni mira imágenes.</p>
        <select
          class="input"
          aria-label="Qué hacer con audios e imágenes"
          [value]="model().handoff.unsupported_media.mode"
          (change)="setMedia($any($event.target).value)"
        >
          <option value="handoff">Derivar a una persona</option>
          <option value="ask_text">Pedir que lo escriba</option>
        </select>
        @if (model().handoff.unsupported_media.mode === 'ask_text') {
          <app-text-input
            [field]="$any(form.handoff.unsupported_media).message"
            label="Texto para pedirlo"
            [max]="300"
          />
        }
        @if (error(form.handoff.unsupported_media); as message) {
          <p class="text-sm font-medium text-error">{{ message }}</p>
        }
      </div>
    </div>
  `,
})
export class HandoffSection {
  private readonly draft = inject(AgentDraft);
  protected readonly form = this.draft.form;
  protected readonly model = this.draft.model;
  protected readonly triggers = PREDEFINED_TRIGGERS;
  protected readonly critical = CRITICAL_TRIGGERS;
  protected readonly labels = TRIGGER_LABELS;
  protected readonly addIcon = Plus;
  protected readonly error = fieldError;

  protected addCustom() {
    this.form.handoff.custom_triggers().value.update((list) => {
      const used = list.map((trigger) => trigger.id);
      let n = 1;
      while (used.includes(`custom_situacion_${n}`)) n++;
      return [...list, { id: `custom_situacion_${n}`, description: '', mode: { type: 'immediate' } }];
    });
  }

  protected addKeywords(id: (typeof CRITICAL_TRIGGERS)[number]) {
    this.form.handoff
      .keywords()
      .value.update((keywords) => ({ ...keywords, [id]: { extra: [], exclude: [] } }));
  }

  protected setMedia(mode: 'handoff' | 'ask_text') {
    this.form.handoff
      .unsupported_media()
      .value.set(
        mode === 'handoff'
          ? { mode }
          : { mode, message: 'Por ahora no puedo escuchar audios ni ver imágenes: ¿me lo escribís?' },
      );
  }
}
