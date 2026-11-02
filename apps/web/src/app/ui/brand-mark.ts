import { ChangeDetectionStrategy, Component } from '@angular/core';
import { PRODUCT_NAME } from '../brand';

/** Marca provisoria: un monograma geométrico + el nombre del producto (marcador en brand.ts). */
@Component({
  selector: 'app-brand-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex items-center gap-2' },
  template: `
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <path
        d="M9 22V10h7.5a4.5 4.5 0 0 1 0 9H13"
        fill="none"
        stroke="var(--on-primary)"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <span class="text-lg font-extrabold tracking-tight text-text">{{ name }}</span>
  `,
})
export class BrandMark {
  protected readonly name = PRODUCT_NAME;
}
