import { Dialog } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CirclePause, MessageCircle, Plus, QrCode, RotateCw, Unplug, Users, X } from 'lucide';
import { switchMap, filter, type Observable } from 'rxjs';
import { ChannelsApi } from '../../api/channels-api';
import type { ChannelWithMembers } from '../../api/generated';
import { AuthService } from '../../core/auth/auth.service';
import { can } from '../../core/nav';
import { pollWhileNoRealtime } from '../../core/poll';
import { query } from '../../core/query';
import { onInboxChanges } from '../../core/realtime';
import { ConfirmService } from '../../ui/confirm-dialog';
import { Icon } from '../../ui/icon';
import { NotifyService } from '../../ui/toast';
import { channelStatus, disconnectExplanation, neverConnected, shortDate } from './channel-state';
import { ConnectChannelDialog, type ConnectChannelData } from './connect-channel-dialog';

/**
 * Canales (tarea 011, owner y admin): los números de WhatsApp de la empresa, su estado en vivo (tiempo real
 * de la 025) y las acciones según el estado: conectar uno nuevo por QR, ver el QR, reconectar, desconectar,
 * cancelar un alta y levantar la pausa de envíos. Los botones se ocultan según el rol; decide la API.
 */
@Component({
  selector: 'app-channels-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink],
  template: `
    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 class="text-2xl sm:text-[28px] sm:leading-[34px]">Canales</h1>
        <p class="mt-1 text-muted">Los números de WhatsApp de la empresa y su conexión.</p>
      </div>
      @if (canConnect()) {
        <button
          type="button"
          class="btn btn-primary w-full sm:w-auto"
          (click)="connectNew()"
          data-testid="connect-new"
        >
          <app-icon [icon]="addIcon" [size]="18" /> Conectar un número
        </button>
      }
    </div>

    <div class="mt-5">
      @if (channels.loadFailed()) {
        <div class="card flex flex-col items-start gap-3 p-5">
          <p class="font-semibold text-text">No pudimos cargar los canales.</p>
          <button type="button" class="btn btn-secondary btn-sm" (click)="channels.reload()">
            Reintentar
          </button>
        </div>
      } @else if (!channels.hasValue()) {
        <p class="text-muted">Cargando…</p>
      } @else {
        <ul class="card" aria-label="Números de WhatsApp">
          @for (channel of channels.value().items; track channel.id) {
            <li
              class="flex flex-col gap-3 border-t border-border p-4 first:border-t-0 sm:p-5 lg:flex-row lg:items-center lg:gap-5"
              [attr.aria-labelledby]="'channel-' + channel.id"
              data-testid="channel-row"
              [attr.data-channel-id]="channel.id"
            >
              <div class="flex min-w-0 flex-1 items-start gap-3">
                <span
                  class="flex size-11 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-strong"
                  aria-hidden="true"
                >
                  <app-icon [icon]="channelIcon" [size]="22" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h2 class="truncate text-base font-semibold text-text" [id]="'channel-' + channel.id">
                      {{ channel.name }}
                    </h2>
                    <span
                      class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
                      [class]="status(channel).pill"
                      data-testid="channel-status"
                    >
                      <app-icon [icon]="status(channel).icon" [size]="14" />
                      {{ status(channel).label }}
                    </span>
                  </div>
                  <p class="tabular mt-0.5 text-sm text-muted" data-testid="channel-phone">
                    {{ channel.phoneNumber ?? 'Sin número todavía' }}
                    @if (channel.status === 'connected' && channel.connectedAt) {
                      <span class="text-subtle"> · conectado desde el {{ when(channel.connectedAt) }}</span>
                    }
                  </p>
                  @if (explanation(channel); as text) {
                    <p class="mt-1 text-sm text-text" data-testid="channel-reason">{{ text }}</p>
                  }
                  @if (channel.sendingPause; as pause) {
                    <p
                      class="mt-2 flex items-start gap-2 rounded-md bg-warning-soft p-2.5 text-sm text-text"
                      data-testid="channel-paused"
                    >
                      <app-icon [icon]="pauseIcon" [size]="16" class="mt-0.5 shrink-0 text-warning" />
                      <span>
                        <span class="font-semibold">Envíos pausados.</span>
                        {{
                          pause.blockedRisk
                            ? 'WhatsApp avisó riesgo de bloqueo: el sistema dejó de responder por este número.'
                            : 'El sistema dejó de responder por este número.'
                        }}
                        {{ pause.until ? 'Se reanudan solos el ' + when(pause.until) + '.' : '' }}
                      </span>
                    </p>
                  }
                </div>
              </div>

              <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap lg:shrink-0 lg:justify-end">
                @if (channel.status === 'connected' && canAssign()) {
                  <a routerLink="/numeros" class="btn btn-ghost btn-sm">
                    <app-icon [icon]="sellersIcon" [size]="16" />
                    {{ channel.sellers.length === 1 ? '1 vendedor' : channel.sellers.length + ' vendedores' }}
                  </a>
                }
                @if (channel.sendingPause && canConnect()) {
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm"
                    [disabled]="busy() === channel.id"
                    (click)="resume(channel)"
                    data-testid="resume-sending"
                  >
                    <app-icon [icon]="resumeIcon" [size]="16" /> Levantar pausa
                  </button>
                }
                @if (channel.status === 'pending' && !channel.phoneNumber && canConnect()) {
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    (click)="showQr(channel)"
                    data-testid="show-qr"
                  >
                    <app-icon [icon]="qrIcon" [size]="16" /> Ver QR
                  </button>
                }
                @if (channel.status === 'disconnected' && canConnect()) {
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    [disabled]="busy() === channel.id"
                    (click)="reconnect(channel)"
                    data-testid="reconnect"
                  >
                    <app-icon [icon]="resumeIcon" [size]="16" /> Reconectar
                  </button>
                }
                @if (canDisconnect() && channel.status !== 'banned') {
                  @if (neverConnected(channel)) {
                    <button
                      type="button"
                      class="btn btn-secondary btn-sm"
                      [disabled]="busy() === channel.id"
                      (click)="cancel(channel)"
                      data-testid="cancel-channel"
                    >
                      <app-icon [icon]="cancelIcon" [size]="16" /> Cancelar
                    </button>
                  } @else if (channel.status !== 'disconnected') {
                    <button
                      type="button"
                      class="btn btn-secondary btn-sm"
                      [disabled]="busy() === channel.id"
                      (click)="disconnect(channel)"
                      data-testid="disconnect"
                    >
                      <app-icon [icon]="disconnectIcon" [size]="16" /> Desconectar
                    </button>
                  }
                }
              </div>
            </li>
          } @empty {
            <li class="flex flex-col items-start gap-2 p-5">
              <p class="font-semibold text-text">Todavía no hay números conectados.</p>
              <p class="text-muted">Conectá el WhatsApp de ventas para que el sistema empiece a responder.</p>
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class ChannelsPage {
  private readonly api = inject(ChannelsApi);
  private readonly dialog = inject(Dialog);
  private readonly confirm = inject(ConfirmService);
  private readonly notify = inject(NotifyService);
  private readonly auth = inject(AuthService);

  protected readonly channels = query(
    () => null,
    () => this.api.list(),
  );
  protected readonly busy = signal<string | null>(null);
  protected readonly canConnect = computed(() => can(this.auth.role(), { channel: ['connect'] }));
  protected readonly canDisconnect = computed(() => can(this.auth.role(), { channel: ['disconnect'] }));
  protected readonly canAssign = computed(() => can(this.auth.role(), { channel: ['assign'] }));

  protected readonly status = channelStatus;
  protected readonly explanation = disconnectExplanation;
  protected readonly neverConnected = neverConnected;
  protected readonly when = shortDate;
  protected readonly addIcon = Plus;
  protected readonly channelIcon = MessageCircle;
  protected readonly pauseIcon = CirclePause;
  protected readonly resumeIcon = RotateCw;
  protected readonly qrIcon = QrCode;
  protected readonly disconnectIcon = Unplug;
  protected readonly cancelIcon = X;
  protected readonly sellersIcon = Users;

  constructor() {
    // El estado llega por el tiempo real (channel.updated); sin tiempo real, el respaldo de cada 30 s.
    onInboxChanges((changes) => {
      if (changes.resync || changes.channels.size > 0) this.channels.reload();
    });
    pollWhileNoRealtime(() => this.channels.reload());
  }

  protected connectNew() {
    this.openPairing(null);
  }

  protected showQr(channel: ChannelWithMembers) {
    this.openPairing(channel);
  }

  /** QR nuevo para el mismo canal (mismo historial) y el diálogo para escanearlo. */
  protected reconnect(channel: ChannelWithMembers) {
    this.run(channel, this.api.reconnect(channel.id), {
      error: 'No pudimos pedir un QR nuevo. Probá de nuevo en un rato.',
      then: (updated) => this.openPairing(updated),
    });
  }

  protected disconnect(channel: ChannelWithMembers) {
    this.confirm
      .ask({
        title: `¿Desconectar ${channel.name}?`,
        message:
          'El sistema deja de recibir y responder los mensajes de este número. El historial queda guardado y podés reconectarlo con un QR nuevo.',
        confirmLabel: 'Desconectar',
      })
      .pipe(filter(Boolean))
      .subscribe(() =>
        this.run(channel, this.api.disconnect(channel.id), {
          success: `${channel.name} quedó desconectado.`,
          error: 'No pudimos desconectar el número. Probá de nuevo en un rato.',
        }),
      );
  }

  protected cancel(channel: ChannelWithMembers) {
    this.confirm
      .ask({
        title: `¿Cancelar ${channel.name}?`,
        message: 'El número nunca se conectó: se borra de la lista y el QR deja de servir.',
        confirmLabel: 'Cancelar el alta',
        cancelLabel: 'Volver',
      })
      .pipe(
        filter(Boolean),
        switchMap(() => {
          this.busy.set(channel.id);
          return this.api.cancel(channel.id);
        }),
      )
      .subscribe({
        next: () => {
          this.busy.set(null);
          this.channels.update((list) =>
            list ? { items: list.items.filter((item) => item.id !== channel.id) } : list,
          );
          this.notify.success(`Se canceló el alta de ${channel.name}.`);
        },
        error: () => {
          this.busy.set(null);
          this.channels.reload();
          this.notify.show('No pudimos cancelar el alta. Probá de nuevo.');
        },
      });
  }

  protected resume(channel: ChannelWithMembers) {
    this.confirm
      .ask({
        title: `¿Levantar la pausa de ${channel.name}?`,
        message:
          'El sistema vuelve a responder por este número. Si WhatsApp avisó riesgo de bloqueo, esperá un tiempo antes de levantarla: seguir enviando puede hacer que bloqueen el número.',
        confirmLabel: 'Levantar pausa',
      })
      .pipe(filter(Boolean))
      .subscribe(() =>
        this.run(channel, this.api.resumeSending(channel.id), {
          success: `Se levantó la pausa de ${channel.name}.`,
          error: 'No pudimos levantar la pausa. Probá de nuevo.',
        }),
      );
  }

  private openPairing(channel: ChannelWithMembers | null) {
    const ref = this.dialog.open<boolean, ConnectChannelData>(ConnectChannelDialog, {
      data: { channel },
      ariaLabelledBy: 'connect-title',
      hasBackdrop: true,
      backdropClass: 'app-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      // En el celular ocupa toda la pantalla.
      maxWidth: '100vw',
    });
    ref.closed.subscribe(() => this.channels.reload());
  }

  private run(
    channel: ChannelWithMembers,
    request: Observable<ChannelWithMembers>,
    messages: { success?: string; error: string; then?: (updated: ChannelWithMembers) => void },
  ) {
    this.busy.set(channel.id);
    request.subscribe({
      next: (updated) => {
        this.busy.set(null);
        this.channels.update((list) =>
          list ? { items: list.items.map((item) => (item.id === updated.id ? updated : item)) } : list,
        );
        if (messages.success) this.notify.success(messages.success);
        messages.then?.(updated);
      },
      error: () => {
        this.busy.set(null);
        this.channels.reload();
        this.notify.show(messages.error);
      },
    });
  }
}
