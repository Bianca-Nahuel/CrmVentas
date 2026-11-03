import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';
import {
  ApiConfiguration,
  getFunnel,
  listFunnelLeads,
  listStalledLeads,
  type GetFunnel$Params,
  type ListFunnelLeads$Params,
  type ListStalledLeads$Params,
  type StrictHttpResponse,
} from './generated';

const body = <T>(response: Observable<StrictHttpResponse<T>>) => response.pipe(map((r) => r.body));

/** Embudo de ventas (tarea 028): conteos por cohorte, las listas de cada etapa y los estancados. */
@Injectable({ providedIn: 'root' })
export class FunnelApi {
  private readonly http = inject(HttpClient);
  private readonly rootUrl = inject(ApiConfiguration).rootUrl;

  funnel(params: GetFunnel$Params) {
    return body(getFunnel(this.http, this.rootUrl, params));
  }

  leads(params: ListFunnelLeads$Params) {
    return body(listFunnelLeads(this.http, this.rootUrl, params));
  }

  stalled(params: ListStalledLeads$Params) {
    return body(listStalledLeads(this.http, this.rootUrl, params));
  }
}
