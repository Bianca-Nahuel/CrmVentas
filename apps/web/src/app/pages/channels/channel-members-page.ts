import { Dialog } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MessageCircle, UserPlus, Users, X } from 'lucide';
import { InboxApi } from '../../api/inbox-api';
import type { ChannelWithMembers, MemberRef } from '../../api/generated';
import { InboxSummary } from '../../core/inbox-summary';
import { query } from '../../core/query';
import { Icon } from '../../ui/icon';
import { NotifyService } from '../../ui/toast';
import { AssignSellersDialog, type AssignSellersData } from './assign-sellers-dialog';

const STATUS: Record<ChannelWithMembers['status'], { label: string; dot: string; pill: string }> = {
  connected: { label: 'Conectado', dot: 'bg-success', pill: 'bg-success-soft text-success' },
  pending: { label: 'Pendiente', dot: 'bg-warning', pill: 'bg-warning-soft text-warning' },
  disconnected: { label: 'Desconectado', dot: 'bg-border-strong', pill: 'bg-surface-2 text-muted' },
  banned: { label: 'Bloqueado', dot: 'bg-error', pill: 'bg-error-soft text-error' },
};

/** Iniciales para el avatar: primera letra de las dos primeras palabras del nombre. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0]!.toLocaleUpperCase('es-AR'))
    .join('');
}

/**
 * Números y vendedores (tarea 014, owner y admin): qué vendedores atienden cada número. Un seller ve solo
 * las conversaciones de sus números. Conectar y desconectar números está en Canales (tarea 011).
 */
@Component({
  selector: 'app-channel-members-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <h1 class="text-2xl sm:text-[28px] sm:leading-[34px]">Números y vendedores</h1>
    <p class="mt-1 text-muted">
      Cada vendedor ve solo las conversaciones de los números que tiene asignados.
    </p>

    <div class="mt-5 grid gap-4 lg:grid-cols-2">
      @if (channels.loadFailed() || sellers.loadFailed()) {
        <div class="card flex flex-col items-start gap-3 p-5 lg:col-span-2">
          <p class="font-semibold text-text">No pudimos cargar los números.</p>
          <button type="button" class="btn btn-secondary btn-sm" (click)="reload()">Reintentar</button>
        </div>
      } @else if (!channels.hasValue()) {
        <p class="text-muted">Cargando…</p>
      } @else {
        @for (channel of channels.value().items; track channel.id) {
          <section
            class="card flex flex-col"
            [attr.aria-labelledby]="'channel-' + channel.id"
            data-testid="channel-card"
          >
            <div class="flex items-start gap-3 p-4 sm:p-5">
              <span
                class="flex size-11 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-strong"
                aria-hidden="true"
              >
                <app-icon [icon]="channelIcon" [size]="22" />
              </span>
              <div class="min-w-0 flex-1">
                <h2 class="truncate text-base font-semibold text-text" [id]="'channel-' + channel.id">
                  {{ channel.name }}
                </h2>
                <p class="tabular text-sm text-muted">{{ channel.phoneNumber ?? 'Sin número todavía' }}</p>
              </div>
              <span
                class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
                [class]="status(channel).pill"
              >
                <span class="size-1.5 rounded-full" [class]="status(channel).dot" aria-hidden="true"></span>
                {{ status(channel).label }}
              </span>
            </div>

            <div class="flex flex-1 flex-col gap-2 border-t border-border p-4 sm:px-5">
              <p class="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-subtle uppercase">
                <app-icon [icon]="sellersIcon" [size]="14" /> Vendedores
                <span class="tabular font-normal normal-case">({{ channel.sellers.length }})</span>
              </p>
              @if (channel.sellers.length) {
                <ul class="flex flex-col gap-1" [attr.aria-label]="'Vendedores de ' + channel.name">
                  @for (seller of channel.sellers; track seller.userId) {
                    <li class="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-2">
                      <span
                        class="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-bold text-primary-strong"
                        aria-hidden="true"
                        >{{ initials(seller.name) }}</span
                      >
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm font-medium text-text">{{ seller.name }}</span>
                        <span class="block truncate text-xs text-subtle">{{ seller.email }}</span>
                      </span>
                      <button
                        type="button"
                        class="flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-error"
                        [attr.aria-label]="'Quitar a ' + seller.name + ' de ' + channel.name"
                        [attr.title]="'Quitar a ' + seller.name"
                        [disabled]="saving() === channel.id"
                        (click)="remove(channel, seller)"
                      >
                        <app-icon [icon]="removeIcon" [size]="16" />
                      </button>
                    </li>
                  }
                </ul>
              } @else {
                <div
                  class="flex items-center gap-3 rounded-md border border-dashed border-border-strong px-3 py-3"
                >
                  <app-icon [icon]="addIcon" [size]="18" class="shrink-0 text-subtle" />
                  <div class="text-sm">
                    <p class="font-medium text-text">Sin vendedores asignados.</p>
                    <p class="text-subtle">Por ahora solo el owner y los admins ven sus conversaciones.</p>
                  </div>
                </div>
              }
            </div>

            <div class="border-t border-border p-3 sm:px-5">
              <button
                type="button"
                class="btn btn-secondary btn-sm w-full sm:w-auto"
                [disabled]="saving() === channel.id || !sellers.hasValue()"
                (click)="assign(channel)"
              >
                <app-icon [icon]="addIcon" [size]="16" /> Asignar vendedores
              </button>
            </div>
          </section>
        } @empty {
          <div class="card p-5 lg:col-span-2">
            <p class="text-muted">La empresa todavía no tiene números de WhatsApp.</p>
          </div>
        }
      }
    </div>
  `,
})
export class ChannelMembersPage {
  private readonly api = inject(InboxApi);
  private readonly dialog = inject(Dialog);
  private readonly notify = inject(NotifyService);
  private readonly summary = inject(InboxSummary);

  protected readonly channels = query(
    () => null,
    () => this.api.channels(),
  );
  protected readonly sellers = query(
    () => null,
    () => this.api.sellers(),
  );
  protected readonly saving = signal<string | null>(null);
  private readonly sellerOptions = computed(() =>
    this.sellers.hasValue() ? this.sellers.value().items : [],
  );

  protected readonly addIcon = UserPlus;
  protected readonly removeIcon = X;
  protected readonly channelIcon = MessageCircle;
  protected readonly sellersIcon = Users;
  protected readonly initials = initials;
  protected readonly status = (channel: ChannelWithMembers) => STATUS[channel.status];

  protected reload() {
    this.channels.reload();
    this.sellers.reload();
  }

  protected assign(channel: ChannelWithMembers) {
    const ref = this.dialog.open<string[], AssignSellersData>(AssignSellersDialog, {
      data: { channel, sellers: this.sellerOptions() },
      ariaLabelledBy: 'assign-title',
      hasBackdrop: true,
      backdropClass: 'app-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    ref.closed.subscribe((userIds) => {
      if (userIds) this.save(channel, userIds);
    });
  }

  protected remove(channel: ChannelWithMembers, seller: MemberRef) {
    this.save(
      channel,
      channel.sellers.filter((item) => item.userId !== seller.userId).map((item) => item.userId),
    );
  }

  private save(channel: ChannelWithMembers, userIds: string[]) {
    this.saving.set(channel.id);
    this.api.setChannelMembers(channel.id, userIds).subscribe({
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
}
