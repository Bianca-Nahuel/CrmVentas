import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';
import {
  ApiConfiguration,
  cancelChannel,
  createChannel,
  disconnectChannel,
  getChannelPairing,
  listChannels,
  reconnectChannel,
  resumeChannelSending,
  type StrictHttpResponse,
} from './generated';

const body = <T>(response: Observable<StrictHttpResponse<T>>) => response.pipe(map((r) => r.body));

/**
 * Canales (tarea 011): conectar un número por QR, reconectar, desconectar, cancelar y levantar la pausa.
 * Usa las funciones del cliente generado desde el OpenAPI de la API (npm run api:generate).
 */
@Injectable({ providedIn: 'root' })
export class ChannelsApi {
  private readonly http = inject(HttpClient);
  private readonly rootUrl = inject(ApiConfiguration).rootUrl;

  list() {
    return body(listChannels(this.http, this.rootUrl));
  }

  create(name: string) {
    return body(createChannel(this.http, this.rootUrl, { body: { name } }));
  }

  /** El QR vigente (o el estado). Nunca se guarda: se vuelve a pedir cada pocos segundos. */
  pairing(id: string) {
    return body(getChannelPairing(this.http, this.rootUrl, { id }));
  }

  reconnect(id: string) {
    return body(reconnectChannel(this.http, this.rootUrl, { id }));
  }

  disconnect(id: string) {
    return body(disconnectChannel(this.http, this.rootUrl, { id }));
  }

  cancel(id: string) {
    return body(cancelChannel(this.http, this.rootUrl, { id }));
  }

  resumeSending(id: string) {
    return body(resumeChannelSending(this.http, this.rootUrl, { id }));
  }
}
