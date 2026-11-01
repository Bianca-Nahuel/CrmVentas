import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RealtimeService, type RealtimeStatus } from '../core/realtime';

interface StatusView {
  label: string;
  dot: string;
  pulse?: boolean;
  /** Ofrece "Reintentar" (conecta ya y las pantallas vuelven a consultar). */
  retry?: boolean;
}

const VIEWS: Partial<Record<RealtimeStatus, StatusView>> = {
  connecting: { label: 'Conectando…', dot: 'bg-subtle', pulse: true },
  live: { label: 'En vivo', dot: 'bg-success' },
  reconnecting: { label: 'Reconectando…', dot: 'bg-warning', pulse: true },
  offline: { label: 'Sin conexión', dot: 'bg-error', retry: true },
  fallback: { label: 'Sin tiempo real', dot: 'bg-error', retry: true },
};

/**
 * Indicador discreto del tiempo real (tarea 025). `nav`: al pie de la barra lateral, con el texto siempre.
 * `compact`: en la barra de arriba del celular; conectado muestra solo el punto (con el texto para lectores
 * de pantalla) y, si no, el punto y el texto. Nunca solo el color: siempre hay texto (visible o sr-only).
 * Los lectores de pantalla oyen solo los cortes y la vuelta, no cada reconexión de rutina.
 */
@Component({
  selector: 'app-live-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @if (view(); as v) {
      <span
        class="inline-flex min-w-0 items-center gap-2 text-sm"
        [class]="variant() === 'nav' ? 'px-3 py-2 text-muted' : 'text-muted'"
        data-testid="live-indicator"
        [attr.data-status]="status()"
        [attr.title]="v.label"
      >
        <span class="relative flex size-2.5 shrink-0" aria-hidden="true">
          @if (v.pulse) {
            <span class="live-pulse absolute inset-0 rounded-full" [class]="v.dot"></span>
          }
          <span class="relative size-2.5 rounded-full" [class]="v.dot"></span>
        </span>
        <span [class]="variant() === 'compact' && status() === 'live' ? 'sr-only' : 'truncate'">{{
          v.label
        }}</span>
        @if (v.retry) {
          <button
            type="button"
            class="shrink-0 font-semibold text-primary hover:underline"
            data-testid="live-retry"
            (click)="retry()"
          >
            Reintentar
          </button>
        }
      </span>
    }
    <span class="sr-only" role="status" aria-live="polite">{{ announcement() }}</span>
  `,
  styles: `
    .live-pulse {
      animation: live-pulse 1.4s ease-out infinite;
    }
    @keyframes live-pulse {
      from {
        transform: scale(1);
        opacity: 0.7;
      }
      to {
        transform: scale(2.4);
        opacity: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .live-pulse {
        animation: none;
      }
    }
  `,
})
export class LiveIndicator {
  private readonly realtime = inject(RealtimeService);
  readonly variant = input<'nav' | 'compact'>('nav');
  protected readonly status = this.realtime.status;
  protected readonly view = computed(() => VIEWS[this.status()] ?? null);
  protected readonly announcement = signal('');

  constructor() {
    let lost = false;
    effect(() => {
      const status = this.status();
      untracked(() => {
        if (status === 'offline' || status === 'fallback') {
          lost = true;
          this.announcement.set(`Tiempo real: ${VIEWS[status]!.label.toLowerCase()}`);
        } else if (status === 'live' && lost) {
          lost = false;
          this.announcement.set('Tiempo real conectado de nuevo');
        }
      });
    });
  }

  protected retry() {
    this.realtime.retryNow();
  }
}
