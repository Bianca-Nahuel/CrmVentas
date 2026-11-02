import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';
import {
  ApiConfiguration,
  applyCatalogImport,
  getCatalogProduct,
  listCatalogImportRows,
  listCatalogImports,
  listCatalogProducts,
  rePreviewCatalogImport,
  refreshCatalogProduct,
  revertCatalogImport,
  testCatalogExtractor,
  uploadCatalogImport,
  type ListCatalogImportRows$Params,
  type ListCatalogProducts$Params,
  type RePreviewImport,
  type StrictHttpResponse,
} from './generated';

const body = <T>(response: Observable<StrictHttpResponse<T>>) => response.pipe(map((r) => r.body));

/** Catálogo (tarea 027): importar el Excel, ver los productos y probar el extractor. */
@Injectable({ providedIn: 'root' })
export class CatalogApi {
  private readonly http = inject(HttpClient);
  private readonly rootUrl = inject(ApiConfiguration).rootUrl;

  upload(file: File) {
    return body(uploadCatalogImport(this.http, this.rootUrl, { body: { file } }));
  }

  rePreview(id: string, mapping: RePreviewImport['mapping']) {
    return body(rePreviewCatalogImport(this.http, this.rootUrl, { id, body: { mapping } }));
  }

  rows(params: ListCatalogImportRows$Params) {
    return body(listCatalogImportRows(this.http, this.rootUrl, params));
  }

  apply(id: string) {
    return body(applyCatalogImport(this.http, this.rootUrl, { id }));
  }

  revert() {
    return body(revertCatalogImport(this.http, this.rootUrl));
  }

  imports() {
    return body(listCatalogImports(this.http, this.rootUrl));
  }

  products(params: ListCatalogProducts$Params) {
    return body(listCatalogProducts(this.http, this.rootUrl, params));
  }

  product(sku: string) {
    return body(getCatalogProduct(this.http, this.rootUrl, { sku }));
  }

  refresh(sku: string) {
    return body(refreshCatalogProduct(this.http, this.rootUrl, { sku }));
  }

  /** catalog: la sección en edición (sin guardar); sin ella, la vigente. */
  testExtractor(url: string, catalog?: unknown) {
    return body(
      testCatalogExtractor(this.http, this.rootUrl, {
        body: catalog === undefined ? { url } : { url, catalog },
      }),
    );
  }
}
