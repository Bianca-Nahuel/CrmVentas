import { ChangeDetectionStrategy, Component, Injectable, inject, signal } from '@angular/core';
import { WifiOff, X } from 'lucide';
import { Icon } from './icon';

/**
 * Avisos no intrusivos (por ejemplo, sin conexión). Solo textos fijos de la interfaz: nunca el cuerpo de
 * un error del servidor ni datos personales.
 */
@Injectable({ providedIn: 'root' })
export class NotifyService {
  readonly message = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  show(message: string, durationMs = 6000) {
    this.message.set(message);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.message.set(null), durationMs);
  }

  networkError() {
    this.show('No pudimos conectar con el servidor. Revisá tu conexión y probá de nuevo.');
  }

  dismiss() {
    clearTimeout(this.timer);
    this.message.set(null);
  }
}

@Component({
  selector: 'app-toast',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    class:
      'pointer-events-none fixed inset-x-4 bottom-4 z-[1100] flex justify-center sm:inset-x-auto sm:right-6',
  },
  template: `
    <div role="status" aria-live="polite" class="contents">
      @if (notify.message(); as message) {
        <div
          class="card pointer-events-auto flex max-w-md items-start gap-3 px-4 py-3 text-sm text-text shadow-2"
        >
          <app-icon [icon]="icon" class="mt-0.5 text-warning" />
          <p class="flex-1">{{ message }}</p>
          <button
            type="button"
            class="-m-1 rounded-sm p-1 text-muted hover:text-text"
            (click)="notify.dismiss()"
            aria-label="Cerrar aviso"
          >
            <app-icon [icon]="closeIcon" [size]="16" />
          </button>
        </div>
      }
    </div>
  `,
})
export class Toast {
  protected readonly notify = inject(NotifyService);
  protected readonly icon = WifiOff;
  protected readonly closeIcon = X;
}
