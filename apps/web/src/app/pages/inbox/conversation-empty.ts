import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MessagesSquare } from 'lucide';
import { Icon } from '../../ui/icon';

/** Panel derecho de la bandeja (escritorio) cuando no hay conversación elegida. */
@Component({
  selector: 'app-conversation-empty',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'flex h-full flex-col items-center justify-center gap-3 p-6 text-center' },
  template: `
    <span class="flex size-12 items-center justify-center rounded-md bg-primary-soft text-primary-strong">
      <app-icon [icon]="icon" [size]="24" />
    </span>
    <p class="font-semibold text-text">Elegí una conversación</p>
    <p class="max-w-72 text-sm text-muted">
      Vas a ver los mensajes, el puntaje y el resumen de la derivación.
    </p>
  `,
})
export class ConversationEmpty {
  protected readonly icon = MessagesSquare;
}
