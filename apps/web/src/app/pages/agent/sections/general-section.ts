import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { AgentConfigApi } from '../../../api/agent-config-api';
import { ChannelsApi } from '../../../api/channels-api';
import { query } from '../../../core/query';
import { AgentDraft } from '../agent-draft';
import { fieldError } from '../form-ui';
import { Spinner } from '../../../ui/spinner';

/** General: si el asistente responde, en qué números y con qué modelo. */
@Component({
  selector: 'app-agent-general-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, Spinner],
  template: `
    <div class="card flex flex-col gap-5 p-5">
      <h2 class="text-lg font-semibold text-text">General</h2>

      <label class="flex items-start gap-3">
        <input type="checkbox" class="mt-1 size-5" [formField]="form.ai.enabled" data-testid="ai-enabled" />
        <span>
          <span class="font-semibold text-text">El asistente responde los mensajes</span>
          <span class="block text-sm text-subtle">
            Apagado, los mensajes llegan a la bandeja y los atiende el equipo.
          </span>
        </span>
      </label>

      <fieldset class="flex flex-col gap-2">
        <legend class="text-sm font-semibold text-text">Números donde responde</legend>
        <p class="text-sm text-subtle">Elegí en qué números de WhatsApp contesta el asistente.</p>
        @if (channels.hasValue()) {
          @for (channel of channels.value().items; track channel.id) {
            <label class="flex items-center gap-3">
              <input
                type="checkbox"
                class="size-5"
                [checked]="selectedChannels().has(channel.id)"
                (change)="toggleChannel(channel.id, $any($event.target).checked)"
              />
              <span class="text-text">{{ channel.name }}</span>
              <span class="tabular text-sm text-subtle">{{ channel.phoneNumber ?? 'sin conectar' }}</span>
            </label>
          } @empty {
            <p class="text-sm text-muted">Todavía no hay números conectados.</p>
          }
        } @else if (channels.loadFailed()) {
          <p class="text-sm text-error">No pudimos cargar los números.</p>
        } @else {
          <p class="flex items-center gap-2 text-sm text-muted" role="status"><app-spinner /> Cargando…</p>
        }
        @if (error(form.ai.channel_ids); as message) {
          <p class="text-sm font-medium text-error">{{ message }}</p>
        }
      </fieldset>

      <div class="flex flex-col gap-1.5">
        <label class="text-sm font-semibold text-text" for="agent-model">Modelo de IA</label>
        <select
          id="agent-model"
          class="input"
          [value]="draft.model().ai.model ?? ''"
          (change)="setModel($any($event.target).value)"
        >
          <option value="">El recomendado</option>
          @for (model of models.value()?.items ?? []; track model.id) {
            <option [value]="model.id">{{ model.id }}</option>
          }
        </select>
        @if (error(form.ai.model); as message) {
          <p class="text-sm font-medium text-error">{{ message }}</p>
        }
      </div>
    </div>
  `,
})
export class GeneralSection {
  protected readonly draft = inject(AgentDraft);
  protected readonly form = this.draft.form;
  protected readonly error = fieldError;
  private readonly channelsApi = inject(ChannelsApi);
  private readonly configApi = inject(AgentConfigApi);
  protected readonly channels = query(
    () => null,
    () => this.channelsApi.list(),
  );
  protected readonly models = query(
    () => null,
    () => this.configApi.models(),
  );
  protected readonly selectedChannels = computed(() => new Set(this.draft.model().ai.channel_ids));

  protected toggleChannel(id: string, checked: boolean) {
    this.form.ai
      .channel_ids()
      .value.update((ids) => (checked ? [...new Set([...ids, id])] : ids.filter((other) => other !== id)));
    this.form.ai.channel_ids().markAsTouched();
  }

  protected setModel(id: string) {
    this.draft.model.update((config) => {
      const ai = { ...config.ai };
      if (id) ai.model = id;
      else delete ai.model;
      return { ...config, ai };
    });
  }
}
