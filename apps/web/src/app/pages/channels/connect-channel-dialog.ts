import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CircleCheck, Clock, LoaderCircle, RotateCw, TriangleAlert } from 'lucide';
import { filter } from 'rxjs';
import { ChannelsApi } from '../../api/channels-api';
import type { ChannelPairing, ChannelWithMembers } from '../../api/generated';
import { RealtimeService } from '../../core/realtime';
import { Icon } from '../../ui/icon';
import { disconnectExplanation } from './channel-state';

export interface ConnectChannelData {
  /** Canal ya creado (ver su QR o reconectarlo). null: empieza por el nombre y el riesgo. */
  channel: ChannelWithMembers | null;
}

/** Cada cuánto se pide el QR mientras se espera el escaneo (WAHA lo cambia cada 20 s). */
export const PAIRING_POLL_MS = 5_000;
export const CHANNEL_NAME_MAX = 100;
const NO_PAIRING = { qr: null, phoneNumber: null, disconnectReason: null, numberInUse: null };

const CREATE_ERRORS: Record<string, string> = {
  CHANNEL_LIMIT: 'La empresa llegó al máximo de números. Desconectá o cancelá uno que no uses.',
  PAIRING_NOT_SUPPORTED: 'Esta conexión no se puede vincular con un QR.',
};

function errorCode(error: unknown): string | null {
  if (!(error instanceof HttpErrorResponse)) return null;
  const code = (error.error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * Alta de un número (tarea 011): el nombre, después el QR con las instrucciones y el
 * estado en vivo. El QR se pide cada PAIRING_POLL_MS mientras la pestaña está visible y, además, apenas
 * llega un channel.updated de este canal por el tiempo real. Vive solo en una señal: se borra al cerrar.
 * Devuelve true si algo cambió (para recargar la lista).
 */
@Component({
  selector: 'app-connect-channel-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Sin app-field: lo usa solo el login y así no pasa al chunk inicial compartido.
  imports: [Icon],
  host: {
    class:
      'card flex h-dvh w-screen flex-col overflow-y-auto rounded-none p-5 shadow-3 sm:h-auto sm:max-h-[92dvh] sm:w-[min(92vw,620px)] sm:rounded-lg sm:p-6',
  },
  template: `
    @if (step() === 'form') {
      <p class="text-sm font-semibold text-subtle">Paso 1 de 2</p>
      <h2 class="mt-1 text-xl font-semibold text-text" id="connect-title">Conectar un número</h2>
      <p class="mt-1 text-muted">Ponele un nombre para reconocerlo en la bandeja.</p>

      <form class="mt-5 flex flex-1 flex-col gap-5" (submit)="$event.preventDefault(); create()">
        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-semibold text-text" for="channel-name">Nombre del canal</label>
          <input
            class="input"
            id="channel-name"
            aria-describedby="channel-name-hint"
            [maxLength]="nameMax"
            autocomplete="off"
            [value]="name()"
            (input)="name.set($any($event.target).value)"
            data-testid="channel-name"
          />
          <p class="text-sm text-subtle" id="channel-name-hint">Por ejemplo: Ventas Centro</p>
        </div>

        @if (error()) {
          <p class="flex items-center gap-2 text-sm font-medium text-error" role="alert">
            <app-icon [icon]="warningIcon" [size]="16" /> {{ error() }}
          </p>
        }

        <div class="mt-auto flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <button type="button" class="btn btn-secondary" (click)="close()">Cancelar</button>
          <button
            type="submit"
            class="btn btn-primary"
            [disabled]="!canCreate()"
            data-testid="create-channel"
          >
            @if (busy()) {
              <app-icon [icon]="loadingIcon" [size]="16" />
            }
            Continuar
          </button>
        </div>
      </form>
    } @else {
      <p class="text-sm font-semibold text-subtle">{{ data.channel ? channelName() : 'Paso 2 de 2' }}</p>
      <h2 class="mt-1 text-xl font-semibold text-text" id="connect-title">Escaneá el código QR</h2>

      <div class="mt-5 flex flex-1 flex-col gap-5 sm:flex-row">
        <div
          class="mx-auto flex size-64 shrink-0 items-center justify-center rounded-md border border-border bg-qr-surface p-2 sm:mx-0"
          data-testid="qr-box"
        >
          @switch (state()) {
            @case ('qr') {
              <img
                [src]="pairing()!.qr"
                alt="Código QR para vincular el número con WhatsApp"
                class="size-full"
                data-testid="qr-image"
              />
            }
            @case ('connected') {
              <app-icon [icon]="okIcon" [size]="72" class="text-success" />
            }
            @case ('expired') {
              <app-icon [icon]="clockIcon" [size]="56" class="text-warning" />
            }
            @case ('rejected') {
              <app-icon [icon]="warningIcon" [size]="56" class="text-error" />
            }
            @default {
              <app-icon [icon]="loadingIcon" [size]="40" class="text-primary" />
            }
          }
        </div>

        <div class="flex min-w-0 flex-1 flex-col gap-4">
          <ol class="flex flex-col gap-3 text-text">
            @for (instruction of instructions; track $index) {
              <li class="flex gap-3">
                <span
                  class="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary-strong"
                  aria-hidden="true"
                  >{{ $index + 1 }}</span
                >
                <span class="pt-1"
                  ><span class="sr-only">Paso {{ $index + 1 }}: </span>{{ instruction }}</span
                >
              </li>
            }
          </ol>

          <div aria-live="polite" data-testid="pairing-status">
            @switch (state()) {
              @case ('connected') {
                <p class="flex items-center gap-2 rounded-md bg-success-soft p-3 font-semibold text-success">
                  <app-icon [icon]="okIcon" [size]="18" />
                  <span
                    >¡Conectado! <span class="tabular">{{ pairing()?.phoneNumber }}</span></span
                  >
                </p>
              }
              @case ('expired') {
                <div class="flex flex-col items-start gap-3 rounded-md bg-warning-soft p-3">
                  <p class="flex items-center gap-2 font-semibold text-warning">
                    <app-icon [icon]="clockIcon" [size]="18" /> El código QR venció.
                  </p>
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    [disabled]="busy()"
                    (click)="renew()"
                    data-testid="renew-qr"
                  >
                    <app-icon [icon]="renewIcon" [size]="16" /> Generar QR nuevo
                  </button>
                </div>
              }
              @case ('rejected') {
                <div class="flex flex-col items-start gap-3 rounded-md bg-error-soft p-3">
                  <p class="flex items-start gap-2 font-semibold text-error">
                    <app-icon [icon]="warningIcon" [size]="18" class="mt-0.5 shrink-0" />
                    <span>No se conectó. {{ rejection() }}</span>
                  </p>
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    [disabled]="busy()"
                    (click)="renew()"
                    data-testid="renew-qr"
                  >
                    <app-icon [icon]="renewIcon" [size]="16" /> Generar QR nuevo
                  </button>
                </div>
              }
              @case ('qr') {
                <p class="flex items-center gap-2 text-muted">
                  <app-icon [icon]="loadingIcon" [size]="16" class="text-primary" />
                  Esperando el escaneo… El código se renueva solo.
                </p>
              }
              @case ('unavailable') {
                <p class="flex items-center gap-2 text-muted">
                  <app-icon [icon]="warningIcon" [size]="16" class="text-warning" />
                  No pudimos traer el código. Reintentando…
                </p>
              }
              @default {
                <p class="flex items-center gap-2 text-muted">
                  <app-icon [icon]="loadingIcon" [size]="16" class="text-primary" />
                  Preparando el código…
                </p>
              }
            }
          </div>
          @if (error()) {
            <p class="flex items-center gap-2 text-sm font-medium text-error" role="alert">
              <app-icon [icon]="warningIcon" [size]="16" /> {{ error() }}
            </p>
          }
        </div>
      </div>

      <div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        @if (state() === 'connected') {
          <button type="button" class="btn btn-primary" (click)="close()" data-testid="pairing-done">
            Listo
          </button>
        } @else {
          @if (state() !== 'expired' && state() !== 'rejected') {
            <p class="text-sm text-subtle sm:flex-1">Podés cerrar: el número queda esperando el escaneo.</p>
          }
          <button type="button" class="btn btn-secondary" (click)="close()">Cerrar</button>
        }
      </div>
    }
  `,
})
export class ConnectChannelDialog {
  protected readonly data = inject<ConnectChannelData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<boolean>>(DialogRef);
  private readonly api = inject(ChannelsApi);
  private readonly document = inject(DOCUMENT);

  protected readonly step = signal<'form' | 'pairing'>(this.data.channel ? 'pairing' : 'form');
  protected readonly name = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly pairing = signal<ChannelPairing | null>(null);
  protected readonly state = computed(() => this.pairing()?.state ?? 'starting');
  /** Escaneo rechazado: el mismo texto que la lista de canales. */
  protected readonly rejection = computed(() => {
    const pairing = this.pairing();
    return pairing?.state === 'rejected'
      ? disconnectExplanation({ ...pairing, status: 'disconnected' })
      : null;
  });
  protected readonly channelName = signal(this.data.channel?.name ?? '');
  protected readonly canCreate = computed(() => this.name().trim().length > 0 && !this.busy());
  private channelId: string | null = this.data.channel?.id ?? null;
  private changed = false;
  private inFlight = false;
  private fetchAgain = false;

  protected readonly nameMax = CHANNEL_NAME_MAX;
  protected readonly instructions = [
    'Abrí WhatsApp en el teléfono del número que querés conectar.',
    'Tocá Más opciones (⋮) o Configuración, y entrá a Dispositivos vinculados.',
    'Tocá Vincular un dispositivo y apuntá la cámara a este código.',
  ];
  protected readonly warningIcon = TriangleAlert;
  protected readonly loadingIcon = LoaderCircle;
  protected readonly okIcon = CircleCheck;
  protected readonly clockIcon = Clock;
  protected readonly renewIcon = RotateCw;

  constructor() {
    const timer = setInterval(() => this.poll(), PAIRING_POLL_MS);
    const updates = inject(RealtimeService)
      .events$.pipe(filter((event) => event.type === 'channel.updated' && event.channelId === this.channelId))
      .subscribe(() => this.fetch());
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      updates.unsubscribe();
      // El QR no queda en memoria después de cerrar.
      this.pairing.set(null);
    });
    if (this.channelId) this.fetch();
  }

  protected create() {
    if (!this.canCreate()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.create(this.name().trim()).subscribe({
      next: (channel) => {
        this.busy.set(false);
        this.changed = true;
        this.channelId = channel.id;
        this.channelName.set(channel.name);
        this.step.set('pairing');
        this.fetch();
      },
      error: (cause: unknown) => {
        this.busy.set(false);
        const code = errorCode(cause);
        this.error.set(
          (code && CREATE_ERRORS[code]) ?? 'No pudimos comunicarnos con WhatsApp. Probá de nuevo en un rato.',
        );
      },
    });
  }

  /** QR nuevo (venció): misma sesión del canal, sin perder el historial. */
  protected renew() {
    if (!this.channelId) return;
    this.busy.set(true);
    this.error.set(null);
    this.pairing.set(null);
    this.api.reconnect(this.channelId).subscribe({
      next: () => {
        this.busy.set(false);
        this.changed = true;
        this.fetch();
      },
      error: () => {
        this.busy.set(false);
        this.pairing.set({ ...NO_PAIRING, state: 'expired' });
        this.error.set('No pudimos generar un QR nuevo. Probá de nuevo en un rato.');
      },
    });
  }

  protected close() {
    this.ref.close(this.changed);
  }

  private poll() {
    if (this.step() !== 'pairing' || this.document.visibilityState !== 'visible') return;
    if (['connected', 'expired', 'rejected'].includes(this.state())) return;
    this.fetch();
  }

  private fetch() {
    if (!this.channelId) return;
    // Un aviso que llega con un pedido en curso no se pierde: se pide otra vez al terminar.
    if (this.inFlight) {
      this.fetchAgain = true;
      return;
    }
    this.inFlight = true;
    const done = () => {
      this.inFlight = false;
      if (this.fetchAgain) {
        this.fetchAgain = false;
        this.fetch();
      }
    };
    this.api.pairing(this.channelId).subscribe({
      next: (pairing) => {
        if (pairing.state === 'connected') this.changed = true;
        this.pairing.set(pairing);
        done();
      },
      error: () => {
        this.pairing.set({ ...NO_PAIRING, state: 'unavailable' });
        done();
      },
    });
  }
}
