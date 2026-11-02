import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RotateCcw, Send } from 'lucide';
import { firstValueFrom } from 'rxjs';
import { AgentConfigApi } from '../../api/agent-config-api';
import type { PlaygroundResult, PlaygroundState, PlaygroundTurn } from '../../api/generated';
import { Icon } from '../../ui/icon';
import { Score } from '../../ui/score';
import { AgentDraft } from './agent-draft';
import { DAYS, DAY_LABELS, TRIGGER_LABELS, type Day } from './config-model';

const MAX_MESSAGES = 20;

const DECISIONS: Record<string, string> = {
  replied: 'Respondió',
  asked_fields: 'Preguntó datos',
  handed_off: 'Derivó a una persona',
  none: 'No respondió',
  'error:invalid_output': 'La respuesta del modelo no fue válida: derivó',
};

const ERRORS: Record<string, string> = {
  PLAYGROUND_LIMIT: 'Llegaste al límite de pruebas de esta hora (30 turnos). Probá más tarde.',
  AI_DISABLED: 'La IA está apagada en el sistema: no se puede probar ahora.',
  MODEL_UNAVAILABLE: 'El modelo elegido no está disponible.',
  HANDED_OFF: 'El asistente ya derivó la conversación: empezá de nuevo para seguir probando.',
  BUDGET: 'No hay crédito de IA disponible para probar.',
  INVALID_CONFIG: 'Hay campos de la configuración para revisar antes de probar.',
};

interface ChatMessage {
  author: 'cliente' | 'asistente' | 'sistema';
  text: string;
  result?: PlaygroundResult;
}

function emptyState(): PlaygroundState {
  return {
    extracted: {},
    discovered: [],
    lastScore: null,
    counters: { qualificationTurns: 0, hotTurns: 0, suggestionsCount: 0, afterFieldsAsks: 0 },
    handedOff: false,
  };
}

/**
 * Probar el agente (tarea 027): un chat donde el owner o el admin escribe como un cliente, con la
 * configuración en edición (sin guardar). La API usa el mismo motor que el worker y no envía nada por
 * WhatsApp ni guarda mensajes; la conversación de prueba vive solo acá (se pierde al recargar).
 */
@Component({
  selector: 'app-playground',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Score],
  host: { class: 'card flex flex-col overflow-hidden' },
  template: `
    <div class="flex flex-wrap items-center gap-2 border-b border-border p-3">
      <label class="text-sm font-medium text-text" for="pg-when">Momento</label>
      <select
        id="pg-when"
        class="input w-auto min-w-0 flex-1"
        [value]="when()"
        (change)="when.set($any($event.target).value)"
      >
        <option value="now">Ahora</option>
        <option value="custom">Otro día y hora</option>
      </select>
      @if (when() === 'custom') {
        <select
          class="input w-auto"
          aria-label="Día"
          [value]="day()"
          (change)="day.set($any($event.target).value)"
        >
          @for (d of days; track d) {
            <option [value]="d">{{ dayLabels[d] }}</option>
          }
        </select>
        <input
          type="time"
          class="input w-32"
          aria-label="Hora"
          [value]="time()"
          (change)="time.set($any($event.target).value)"
        />
      }
    </div>

    <ol
      class="flex min-h-48 flex-1 flex-col gap-3 overflow-y-auto p-3 lg:max-h-[60vh]"
      aria-live="polite"
      data-testid="pg-messages"
    >
      @for (message of messages(); track $index) {
        @if (message.author === 'sistema') {
          <li class="self-center rounded-md bg-surface-2 px-3 py-1.5 text-center text-xs text-muted">
            {{ message.text }}
          </li>
        } @else {
          <li class="flex max-w-[85%] flex-col gap-1" [class.self-end]="message.author === 'cliente'">
            <p
              class="whitespace-pre-wrap rounded-lg px-3 py-2 text-sm"
              [class]="message.author === 'cliente' ? 'bg-primary text-on-primary' : 'bg-surface-2 text-text'"
            >
              {{ message.text }}
            </p>
            @if (message.result; as result) {
              <details class="text-xs text-muted">
                <summary class="cursor-pointer select-none">Detalle: {{ decision(result.decision) }}</summary>
                <div class="mt-2 flex flex-col gap-2 rounded-md border border-border p-2">
                  <p>
                    {{ result.detail.isOpen ? 'En horario' : 'Fuera de horario' }} ·
                    {{ result.detail.localTime }}
                  </p>
                  @if (result.detail.score !== null) {
                    <app-score [score]="result.detail.score" [level]="result.detail.tier" variant="row" />
                  }
                  @if (result.detail.breakdown; as breakdown) {
                    <ul>
                      @for (dimension of breakdown.dimensions; track dimension.key) {
                        <li>
                          {{ dimension.key }}: señal {{ dimension.signal }}/5 × peso {{ dimension.weight }}
                        </li>
                      }
                      @if (breakdown.completeness; as completeness) {
                        <li>
                          Datos obligatorios: {{ completeness.obtained.length }} de
                          {{ completeness.obtained.length + completeness.missing.length }}
                        </li>
                      }
                    </ul>
                  }
                  @if (result.detail.extracted.length) {
                    <p>
                      Datos obtenidos:
                      @for (item of result.detail.extracted; track item.key; let last = $last) {
                        {{ item.label }}: {{ item.value }}{{ last ? '' : ' · ' }}
                      }
                    </p>
                  }
                  @if (result.detail.triggers.length) {
                    <p>Disparadores: {{ triggers(result.detail.triggers) }}</p>
                  }
                  @if (result.detail.blocked) {
                    <p class="text-error">
                      Un control de salida bloqueó la respuesta ({{ result.detail.blocked }}).
                    </p>
                  }
                  @if (result.detail.handoffSummary) {
                    <p class="whitespace-pre-wrap">
                      Resumen para el vendedor: {{ result.detail.handoffSummary }}
                    </p>
                  }
                  @if (result.detail.catalog; as catalog) {
                    <p>Catálogo: consultó {{ catalog.consulted.length }}, citó {{ catalog.cited.length }}</p>
                  }
                  <p>Modelo {{ result.detail.model }} · costo USD {{ result.detail.costUsd ?? '—' }}</p>
                </div>
              </details>
            }
          </li>
        }
      } @empty {
        <li class="m-auto max-w-64 text-center text-sm text-muted">
          Escribí como si fueras un cliente. Se usa la configuración que estás editando, aunque no la hayas
          guardado. No se envía nada por WhatsApp.
        </li>
      }
      @if (sending()) {
        <li class="text-sm text-muted">El asistente está pensando…</li>
      }
    </ol>

    @if (error(); as message) {
      <p class="border-t border-border bg-error-soft px-3 py-2 text-sm text-error" role="alert">
        {{ message }}
      </p>
    }

    <form class="flex flex-col gap-2 border-t border-border p-3" (submit)="$event.preventDefault(); send()">
      <div class="flex gap-2">
        <label class="sr-only" for="pg-input">Mensaje de prueba</label>
        <textarea
          id="pg-input"
          class="input min-h-11 flex-1 resize-none py-2"
          rows="2"
          maxlength="1000"
          [value]="text()"
          (input)="text.set($any($event.target).value)"
          (keydown.enter)="onEnter($any($event))"
          [disabled]="!canSend()"
          placeholder="Escribí como un cliente…"
          data-testid="pg-input"
        ></textarea>
        <button
          type="submit"
          class="btn btn-primary"
          [disabled]="!canSend() || !text().trim()"
          aria-label="Enviar mensaje de prueba"
        >
          <app-icon [icon]="sendIcon" [size]="18" />
        </button>
      </div>
      <div class="flex items-center justify-between text-xs text-subtle">
        <span class="tabular">{{ chatCount() }}/{{ maxMessages }} mensajes{{ turnsLabel() }}</span>
        <button type="button" class="btn btn-ghost btn-sm" (click)="reset()">
          <app-icon [icon]="resetIcon" [size]="14" /> Empezar de nuevo
        </button>
      </div>
    </form>
  `,
})
export class Playground {
  private readonly draft = inject(AgentDraft);
  private readonly api = inject(AgentConfigApi);

  protected readonly days = DAYS;
  protected readonly dayLabels = DAY_LABELS;
  protected readonly maxMessages = MAX_MESSAGES;
  protected readonly sendIcon = Send;
  protected readonly resetIcon = RotateCcw;

  protected readonly messages = signal<ChatMessage[]>([]);
  private readonly state = signal<PlaygroundState>(emptyState());
  protected readonly text = signal('');
  protected readonly sending = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly when = signal<'now' | 'custom'>('now');
  protected readonly day = signal<Day>('sat');
  protected readonly time = signal('21:00');
  private readonly turns = signal<{ used: number; limit: number } | null>(null);

  protected readonly chatCount = computed(
    () => this.messages().filter((message) => message.author !== 'sistema').length,
  );
  protected readonly canSend = computed(
    () => !this.sending() && !this.state().handedOff && this.chatCount() < MAX_MESSAGES,
  );
  protected readonly turnsLabel = computed(() => {
    const turns = this.turns();
    return turns ? ` · ${turns.used}/${turns.limit} pruebas esta hora` : '';
  });

  protected decision(code: string): string {
    if (DECISIONS[code]) return DECISIONS[code];
    if (code.startsWith('blocked:')) return 'Bloqueó la respuesta y derivó';
    if (code.startsWith('error:')) return 'No se pudo responder (error del modelo)';
    return code;
  }

  protected triggers(ids: string[]): string {
    return ids.map((id) => TRIGGER_LABELS[id as keyof typeof TRIGGER_LABELS] ?? id).join(', ');
  }

  protected onEnter(event: KeyboardEvent) {
    if (event.shiftKey) return;
    event.preventDefault();
    if (this.canSend() && this.text().trim()) void this.send();
  }

  reset() {
    this.messages.set([]);
    this.state.set(emptyState());
    this.error.set(null);
    this.text.set('');
  }

  async send() {
    const text = this.text().trim();
    if (!text || !this.canSend()) return;
    if (this.draft.browserIssues().length > 0) {
      this.error.set(ERRORS['INVALID_CONFIG']!);
      return;
    }
    this.error.set(null);
    this.text.set('');
    this.messages.update((list) => [...list, { author: 'cliente', text }]);
    const history = this.messages()
      .filter((message) => message.author !== 'sistema')
      .map((message) => ({ author: message.author as 'cliente' | 'asistente', text: message.text }));
    const request: PlaygroundTurn = {
      config: this.draft.model() as unknown as Record<string, unknown>,
      baseVersion: this.draft.version() || null,
      history,
      state: this.state(),
      ...(this.when() === 'custom' ? { simulate: { day: this.day(), time: this.time() } } : {}),
    };
    this.sending.set(true);
    try {
      const result = await firstValueFrom(this.api.playground(request));
      this.state.set(result.state);
      this.turns.set({ used: result.turnsLastHour, limit: result.turnsPerHour });
      this.messages.update((list) => [
        ...list,
        result.reply
          ? { author: 'asistente', text: result.reply, result }
          : { author: 'sistema', text: `${this.decision(result.decision)}: no le escribe nada al cliente.` },
      ]);
      if (result.state.handedOff) {
        this.messages.update((list) => [
          ...list,
          {
            author: 'sistema',
            text: 'Derivado a una persona: el asistente ya no responde en esta conversación.',
          },
        ]);
      }
    } catch (error) {
      const code =
        error instanceof HttpErrorResponse ? (error.error as { code?: string } | null)?.code : undefined;
      this.error.set((code && ERRORS[code]) || 'No pudimos probar el agente. Probá de nuevo.');
      // El mensaje no se contestó: se saca del chat para poder reintentar.
      this.messages.update((list) => list.slice(0, -1));
      this.text.set(text);
    } finally {
      this.sending.set(false);
    }
  }
}
