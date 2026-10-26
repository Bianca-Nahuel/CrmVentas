import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_DB, type AppDatabase } from '../../db/database.module.js';
import { withTenantTransaction } from '../../db/tenant-context.js';
import {
  WHATSAPP_PROVIDER_REGISTRY,
  type ChatTarget,
  type PresenceResult,
  type ProviderFailure,
  type SeenMessage,
  type WhatsAppProvider,
  type WhatsAppProviderRegistry,
} from '../../whatsapp/provider.js';
import { applyChannelFailure, loadSendContext, unreadInbound } from './outbound.service.js';

// Visto + "escribiendo…" antes de tener el texto: lo usa la IA mientras el modelo piensa, así la demora
// del modelo es la misma que ve el cliente, en vez de sumarse a la del envío. Las mismas reglas que un
// envío (ventana desde el último entrante, contacto bloqueado, canal caído o pausado por riesgo de
// bloqueo): si no se podría enviar, tampoco se muestra que se está escribiendo.
// Ante riesgo de bloqueo (463/475) o sesión caída corta en el acto y aplica al canal lo mismo que el
// worker de envío (pausa sin vencimiento + alerta, o desconectado): así ningún envío posterior sale.
// Nunca lanza por un error del proveedor; los logs no llevan datos personales.
@Injectable()
export class PresenceService {
  private readonly logger = new Logger('Presence');

  constructor(
    @Inject(APP_DB) private readonly database: AppDatabase,
    @Inject(WHATSAPP_PROVIDER_REGISTRY) private readonly providers: WhatsAppProviderRegistry,
  ) {}

  /** Marca vistos los entrantes y pone "escribiendo…". Devuelve desde cuándo, o null si no se pudo. */
  async startTyping(tenantId: string, conversationId: string): Promise<Date | null> {
    const ready = await this.prepare(tenantId, conversationId, true);
    if (!ready) return null;
    const { provider, target, unread } = ready;
    const seen = await this.call(ready, 'mark_seen', () =>
      provider.markSeen({ ...target, messages: unread }),
    );
    if (seen === 'stop') return null;
    const typing = await this.call(ready, 'start_typing', () => provider.startTyping(target));
    return typing === 'ok' ? new Date() : null;
  }

  /** Saca el "escribiendo…" (la IA terminó sin mandar nada). */
  async stopTyping(tenantId: string, conversationId: string): Promise<void> {
    const ready = await this.prepare(tenantId, conversationId, false);
    if (!ready) return;
    await this.call(ready, 'stop_typing', () => ready.provider.stopTyping(ready.target));
  }

  /** ok, failed (sigue: un visto que falló no frena), stop (riesgo de bloqueo o sesión caída: cortar). */
  private async call(
    ready: Prepared,
    step: string,
    fn: () => Promise<PresenceResult>,
  ): Promise<'ok' | 'failed' | 'stop'> {
    let result: PresenceResult;
    try {
      result = await fn();
    } catch {
      this.logger.warn({ msg: 'presence', conversationId: ready.conversationId, step, error: 'exception' });
      return 'failed';
    }
    if (result.ok) return 'ok';
    if (result.error === 'blocked_risk' || result.error === 'session_down') {
      await this.stopChannel(ready, step, result);
      return 'stop';
    }
    this.logger.warn({
      msg: 'presence',
      conversationId: ready.conversationId,
      step,
      error: result.error,
      code: result.code,
      result: 'presencia_fallida',
    });
    return 'failed';
  }

  private async stopChannel(ready: Prepared, step: string, failure: ProviderFailure): Promise<void> {
    await withTenantTransaction(this.database.db, { tenantId: ready.tenantId }, (tx) =>
      applyChannelFailure(tx, ready.channelId, failure),
    );
    this.logger.error({
      msg: 'presence',
      channelId: ready.channelId,
      conversationId: ready.conversationId,
      step,
      error: failure.error,
      code: failure.code,
      result: 'presencia_fallida',
      ...(failure.error === 'blocked_risk' ? { alerta: 'envios_del_canal_pausados' } : {}),
    });
  }

  private async prepare(
    tenantId: string,
    conversationId: string,
    withUnread: boolean,
  ): Promise<Prepared | null> {
    const loaded = await withTenantTransaction(this.database.db, { tenantId }, async (tx) => {
      const context = await loadSendContext(tx, conversationId);
      if (!context || context.rejectReason) return null;
      return { context, unread: withUnread ? await unreadInbound(tx, conversationId) : [] };
    });
    if (!loaded) return null;
    const provider = this.providers.get(loaded.context.provider as WhatsAppProvider['id']);
    if (!provider) return null;
    return {
      tenantId,
      conversationId,
      channelId: loaded.context.channelId,
      provider,
      target: { channelExternalId: loaded.context.channelExternalId, waId: loaded.context.contactWaId },
      unread: loaded.unread,
    };
  }
}

interface Prepared {
  tenantId: string;
  conversationId: string;
  channelId: string;
  provider: WhatsAppProvider;
  target: ChatTarget;
  unread: SeenMessage[];
}
