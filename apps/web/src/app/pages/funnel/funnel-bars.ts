import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { ArrowDown } from 'lucide';
import type { FunnelBlock, FunnelStage } from '../../api/generated';
import { Icon } from '../../ui/icon';
import { percentLabel } from '../performance/performance-format';
import { STAGE_META } from './funnel-format';

let nextId = 0;

export interface StagePick {
  stage: FunnelStage;
  dropped: boolean;
}

/**
 * Las etapas del embudo como barras horizontales (tarea 028): cantidad y porcentaje sobre "escribió" y, entre
 * cada barra, la conversión, los que se perdieron y los que siguen en curso. Cada etapa tiene su ícono y su
 * nombre (no depende del color) y la misma información está en una tabla ("Ver como tabla"). En el celular,
 * la misma lista se apila: número y porcentaje a la derecha.
 */
@Component({
  selector: 'app-funnel-bars',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-lg font-semibold text-text" [id]="titleId">Recorrido de los leads</h2>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        [attr.aria-expanded]="showTable()"
        [attr.aria-controls]="tableId"
        (click)="showTable.set(!showTable())"
      >
        {{ showTable() ? 'Ver barras' : 'Ver como tabla' }}
      </button>
    </div>

    @if (!showTable()) {
      <ol class="mt-3 flex flex-col" [attr.aria-labelledby]="titleId" data-testid="funnel-bars">
        @for (item of block().stages; track item.stage; let last = $last) {
          <li>
            <button
              type="button"
              class="group flex w-full flex-col gap-1.5 rounded-md px-2 py-2 text-left hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
              [class.bg-primary-soft]="isSelected(item.stage, false)"
              [disabled]="!canList()"
              [attr.aria-pressed]="canList() ? isSelected(item.stage, false) : null"
              [attr.data-testid]="'stage-' + item.stage"
              (click)="pick.emit({ stage: item.stage, dropped: false })"
            >
              <span class="flex items-center justify-between gap-3">
                <span class="flex min-w-0 items-center gap-2 font-semibold text-text">
                  <app-icon [icon]="meta[item.stage].icon" [size]="18" class="text-primary-strong" />
                  <span class="truncate">{{ meta[item.stage].label }}</span>
                </span>
                <span class="tabular shrink-0 text-text">
                  <span class="font-semibold">{{ item.count }}</span>
                  <span class="ml-1.5 text-sm text-muted">{{ percent(item.pctOfWritten) }}</span>
                </span>
              </span>
              <span class="block h-3 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                <span
                  class="block h-full rounded-full bg-primary"
                  [style.width.%]="item.pctOfWritten ?? 0"
                ></span>
              </span>
            </button>
            @if (!last) {
              <p
                class="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 pl-8 text-sm text-muted"
                [attr.data-testid]="'between-' + item.stage"
              >
                <app-icon [icon]="downIcon" [size]="14" />
                <span>{{ percent(item.conversionToNext) }} pasan</span>
                <span aria-hidden="true">·</span>
                @if (canList() && (item.lostBeforeNext ?? 0) > 0) {
                  <button
                    type="button"
                    class="font-semibold text-error underline-offset-2 hover:underline"
                    [class.underline]="isSelected(item.stage, true)"
                    [attr.aria-pressed]="isSelected(item.stage, true)"
                    [attr.data-testid]="'lost-' + item.stage"
                    (click)="pick.emit({ stage: item.stage, dropped: true })"
                  >
                    {{ item.lostBeforeNext }} {{ item.lostBeforeNext === 1 ? 'se perdió' : 'se perdieron' }}
                  </button>
                } @else {
                  <span
                    >{{ item.lostBeforeNext }}
                    {{ item.lostBeforeNext === 1 ? 'se perdió' : 'se perdieron' }}</span
                  >
                }
                @if ((item.openBeforeNext ?? 0) > 0) {
                  <span aria-hidden="true">·</span>
                  <span>{{ item.openBeforeNext }} en curso</span>
                }
              </p>
            }
          </li>
        }
      </ol>
    }

    <div [id]="tableId" [class.sr-only]="!showTable()" class="mt-3 overflow-x-auto">
      <table class="w-full text-left text-sm">
        <caption class="sr-only">
          Etapas del embudo: cantidad, porcentaje sobre las que escribieron y paso a la etapa siguiente
        </caption>
        <thead>
          <tr class="border-b border-border">
            <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">Etapa</th>
            <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">Cantidad</th>
            <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">Sobre "escribió"</th>
            <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">Pasan a la siguiente</th>
            <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">Se perdieron</th>
            <th scope="col" class="py-1.5 pr-3 font-semibold text-muted">En curso</th>
          </tr>
        </thead>
        <tbody>
          @for (item of block().stages; track item.stage) {
            <tr class="border-b border-border last:border-0">
              <th scope="row" class="py-1.5 pr-3 font-semibold text-text">
                {{ meta[item.stage].label }}
                <span class="block text-xs font-normal text-subtle">{{ meta[item.stage].description }}</span>
              </th>
              <td class="tabular py-1.5 pr-3">{{ item.count }}</td>
              <td class="tabular py-1.5 pr-3">{{ percent(item.pctOfWritten) }}</td>
              <td class="tabular py-1.5 pr-3">
                {{ item.conversionToNext === null ? '—' : percent(item.conversionToNext) }}
              </td>
              <td class="tabular py-1.5 pr-3">{{ item.lostBeforeNext ?? '—' }}</td>
              <td class="tabular py-1.5 pr-3">{{ item.openBeforeNext ?? '—' }}</td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class FunnelBars {
  readonly block = input.required<FunnelBlock>();
  /** Con listas (lead.read): cada etapa y cada pérdida abre sus leads. */
  readonly canList = input(false);
  readonly selected = input<StagePick | null>(null);
  readonly pick = output<StagePick>();

  protected readonly showTable = signal(false);
  protected readonly meta = STAGE_META;
  protected readonly downIcon = ArrowDown;
  protected readonly percent = percentLabel;
  protected readonly titleId = `funnel-title-${++nextId}`;
  protected readonly tableId = `funnel-table-${nextId}`;

  protected isSelected(stage: FunnelStage, dropped: boolean): boolean {
    const selected = this.selected();
    return selected !== null && selected.stage === stage && selected.dropped === dropped;
  }
}
