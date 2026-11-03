import { Dialog } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CirclePause, MessageCircle, Plus, QrCode, RotateCw, Unplug, UserPlus, Users, X } from 'lucide';
import { switchMap, filter, of, type Observable } from 'rxjs';
import { ChannelsApi } from '../../api/channels-api';
import type { ChannelWithMembers, MemberRef } from '../../api/generated';
import { InboxApi } from '../../api/inbox-api';
import { AuthService } from '../../core/auth/auth.service';
import { InboxSummary } from '../../core/inbox-summary';
import { can } from '../../core/nav';
import { pollWhileNoRealtime } from '../../core/poll';
import { query } from '../../core/query';
import { onInboxChanges } from '../../core/realtime';
import { ConfirmService } from '../../ui/confirm-dialog';
import { Icon } from '../../ui/icon';
import { NotifyService } from '../../ui/toast';
import { AssignSellersDialog, type AssignSellersData } from './assign-sellers-dialog';
import { channelStatus, disconnectExplanation, initials, neverConnected, shortDate } from './channel-state';
import { ConnectChannelDialog, type ConnectChannelData } from './connect-channel-dialog';
import { Spinner } from '../../ui/spinner';

/**
 * Números (tareas 011 y 014, owner y admin): los números de WhatsApp de la empresa, su estado en vivo
 * (tiempo real de la 025), las acciones según el estado (conectar uno nuevo por QR, ver el QR, reconectar,
 * desconectar, cancelar un alta y levantar la pausa de envíos) y los vendedores que atienden cada uno. Un
 * seller ve solo las conversaciones de sus números. Los botones se ocultan según el rol; decide la API.
 */
@Component({
  selector: 'app-channels-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Spinner],
  template: `
    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 class="text-2xl sm:text-[28px] sm:leading-[34px]">Números</h1>
        <p class="mt-1 text-muted">
          Los números de WhatsApp de la empresa, su conexión y qué vendedores los atienden. Cada vendedor ve
          solo las conversaciones de sus números.
        </p>
      </div>
      @if (canConnect()) {
        <button
          type="button"
          class="btn btn-primary w-full shrink-0 whitespace-nowrap sm:w-auto"
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
        <p class="flex items-center gap-2 text-muted" role="status"><app-spinner /> Cargando…</p>
      } @else {
        <ul class="card" aria-label="Números de WhatsApp">
          @for (channel of channels.value().items; track channel.id) {
            <li
              class="border-t border-border first:border-t-0"
              [attr.aria-labelledby]="'channel-' + channel.id"
              data-testid="channel-row"
              [attr.data-channel-id]="channel.id"
            >
              <div class="flex flex-col gap-3 p-4 sm:p-5 lg:flex-row lg:items-center lg:gap-5">
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
              </div>

              @if (canAssign()) {
                <div
                  class="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-5"
                  data-testid="channel-sellers"
                >
                  <p
                    class="flex shrink-0 items-center gap-1.5 text-xs font-semibold tracking-wide text-subtle uppercase"
                  >
                    <app-icon [icon]="sellersIcon" [size]="14" /> Vendedores
                  </p>
                  @if (channel.sellers.length) {
                    <ul
                      class="flex flex-1 flex-wrap gap-1.5"
                      [attr.aria-label]="'Vendedores de ' + channel.name"
                    >
                      @for (seller of channel.sellers; track seller.userId) {
                        <li
                          class="flex items-center gap-2 rounded-full border border-border bg-surface py-0.5 pr-0.5 pl-0.5"
                          [attr.title]="seller.email"
                        >
                          <span
                            class="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-bold text-primary-strong"
                            aria-hidden="true"
                            >{{ initials(seller.name) }}</span
                          >
                          <span class="text-sm font-medium text-text">{{ seller.name }}</span>
                          <button
                            type="button"
                            class="flex size-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-error"
                            [attr.aria-label]="'Quitar a ' + seller.name + ' de ' + channel.name"
                            [attr.title]="'Quitar a ' + seller.name"
                            [disabled]="saving() === channel.id"
                            (click)="removeSeller(channel, seller)"
                          >
                            <app-icon [icon]="removeIcon" [size]="14" />
                          </button>
                        </li>
                      }
                    </ul>
                  } @else {
                    <p class="flex-1 text-sm text-subtle">
                      Sin vendedores asignados: por ahora solo el owner y los admins ven sus conversaciones.
                    </p>
                  }
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm shrink-0"
                    [disabled]="saving() === channel.id || !sellers.hasValue()"
                    (click)="assign(channel)"
                  >
                    <app-icon [icon]="assignIcon" [size]="16" /> Asignar vendedores
                  </button>
                </div>
              }
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
  private readonly inboxApi = inject(InboxApi);
  private readonly summary = inject(InboxSummary);

  protected readonly channels = query(
    () => null,
    () => this.api.list(),
  );
  protected readonly busy = signal<string | null>(null);
  /** Número cuyos vendedores se están guardando. */
  protected readonly saving = signal<string | null>(null);
  protected readonly canConnect = computed(() => can(this.auth.role(), { channel: ['connect'] }));
  protected readonly canDisconnect = computed(() => can(this.auth.role(), { channel: ['disconnect'] }));
  protected readonly canAssign = computed(() => can(this.auth.role(), { channel: ['assign'] }));
  protected readonly sellers = query(
    () => this.canAssign(),
    (canAssign) => (canAssign ? this.inboxApi.sellers() : of({ items: [] as MemberRef[] })),
  );

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
  protected readonly assignIcon = UserPlus;
  protected readonly removeIcon = X;
  protected readonly initials = initials;

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

  protected assign(channel: ChannelWithMembers) {
    const ref = this.dialog.open<string[], AssignSellersData>(AssignSellersDialog, {
      data: { channel, sellers: this.sellers.hasValue() ? this.sellers.value().items : [] },
      ariaLabelledBy: 'assign-title',
      hasBackdrop: true,
      backdropClass: 'app-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    ref.closed.subscribe((userIds) => {
      if (userIds) this.saveSellers(channel, userIds);
    });
  }

  protected removeSeller(channel: ChannelWithMembers, seller: MemberRef) {
    this.saveSellers(
      channel,
      channel.sellers.filter((item) => item.userId !== seller.userId).map((item) => item.userId),
    );
  }

  private saveSellers(channel: ChannelWithMembers, userIds: string[]) {
    this.saving.set(channel.id);
    this.inboxApi.setChannelMembers(channel.id, userIds).subscribe({
      next: (updated) => {
        this.channels.update((list) =>
          list ? { items: list.items.map((item) => (item.id === updated.id ? updated : item)) } : list,
        );
        this.saving.set(null);
        this.summary.refresh();
        this.notify.success(`Vendedores de ${updated.name} actualizados.`);
      },
      error: () => {
        this.saving.set(null);
        this.notify.show('No pudimos guardar los vendedores. Probá de nuevo.');
      },
    });
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
