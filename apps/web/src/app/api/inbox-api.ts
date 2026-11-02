import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';
import {
  ApiConfiguration,
  closeConversation,
  getConversation,
  getLeadSummary,
  listChannels,
  listLeads,
  listMessages,
  listSellers,
  markConversationRead,
  reactivateAi,
  sendMessage,
  setChannelMembers,
  type CloseOutcome,
  type ListLeads$Params,
  type StrictHttpResponse,
} from './generated';

const body = <T>(response: Observable<StrictHttpResponse<T>>) => response.pipe(map((r) => r.body));

/**
 * Bandeja, leads y números (tarea 014); responder desde el panel (024). Usa las funciones del cliente generado desde el OpenAPI de la API
 * (npm run api:generate), sobre HttpClient: pasan por el interceptor de errores como el resto.
 */
@Injectable({ providedIn: 'root' })
export class InboxApi {
  private readonly http = inject(HttpClient);
  private readonly rootUrl = inject(ApiConfiguration).rootUrl;

  leads(params: ListLeads$Params) {
    return body(listLeads(this.http, this.rootUrl, params));
  }

  summary() {
    return body(getLeadSummary(this.http, this.rootUrl));
  }

  conversation(id: string) {
    return body(getConversation(this.http, this.rootUrl, { id }));
  }

  messages(id: string, before?: string) {
    return body(listMessages(this.http, this.rootUrl, { id, before, limit: 50 }));
  }

  /** Responde por WhatsApp. idempotencyKey: la misma en los reintentos de un mismo envío. */
  sendMessage(id: string, text: string, idempotencyKey: string) {
    return body(sendMessage(this.http, this.rootUrl, { id, body: { body: text, idempotencyKey } }));
  }

  markRead(id: string) {
    return body(markConversationRead(this.http, this.rootUrl, { id }));
  }

  /** Cerrar con un resultado (tarea 026). Idempotente: una ya cerrada vuelve sin cambios. */
  close(id: string, outcome: CloseOutcome, note: string) {
    return body(
      closeConversation(this.http, this.rootUrl, { id, body: { outcome, ...(note ? { note } : {}) } }),
    );
  }

  reactivateAi(id: string) {
    return body(reactivateAi(this.http, this.rootUrl, { id }));
  }

  channels() {
    return body(listChannels(this.http, this.rootUrl));
  }

  sellers() {
    return body(listSellers(this.http, this.rootUrl));
  }

  setChannelMembers(id: string, userIds: string[]) {
    return body(setChannelMembers(this.http, this.rootUrl, { id, body: { userIds } }));
  }
}
