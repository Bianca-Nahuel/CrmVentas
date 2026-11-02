import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { TitleStrategy, type RouterStateSnapshot } from '@angular/router';
import { PRODUCT_NAME } from '../brand';

/** "Leads · Panel": el título de la pestaña sale de la ruta y del nombre del producto (brand.ts). */
@Injectable()
export class PanelTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot) {
    const page = this.buildTitle(snapshot);
    this.title.setTitle(page ? `${page} · ${PRODUCT_NAME}` : PRODUCT_NAME);
  }
}
