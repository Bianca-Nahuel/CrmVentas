import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';
import {
  ApiConfiguration,
  getAgentConfig,
  getAgentConfigVersion,
  listAgentConfigVersions,
  listAgentModels,
  playgroundTurn,
  restoreAgentConfigVersion,
  saveAgentConfig,
  type PlaygroundTurn,
  type SaveAgentConfig,
  type StrictHttpResponse,
} from './generated';

const body = <T>(response: Observable<StrictHttpResponse<T>>) => response.pipe(map((r) => r.body));

/** Configuración del agente (tarea 027): versiones, modelos y el playground. */
@Injectable({ providedIn: 'root' })
export class AgentConfigApi {
  private readonly http = inject(HttpClient);
  private readonly rootUrl = inject(ApiConfiguration).rootUrl;

  current() {
    return body(getAgentConfig(this.http, this.rootUrl));
  }

  save(request: SaveAgentConfig) {
    return body(saveAgentConfig(this.http, this.rootUrl, { body: request }));
  }

  versions() {
    return body(listAgentConfigVersions(this.http, this.rootUrl));
  }

  version(version: number) {
    return body(getAgentConfigVersion(this.http, this.rootUrl, { version }));
  }

  restore(version: number, expectedVersion: number, confirmTransparency?: boolean) {
    return body(
      restoreAgentConfigVersion(this.http, this.rootUrl, {
        version,
        body: confirmTransparency ? { expectedVersion, confirmTransparency } : { expectedVersion },
      }),
    );
  }

  models() {
    return body(listAgentModels(this.http, this.rootUrl));
  }

  playground(request: PlaygroundTurn) {
    return body(playgroundTurn(this.http, this.rootUrl, { body: request }));
  }
}
