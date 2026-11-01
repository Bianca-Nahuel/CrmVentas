import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { TenantConfigService } from '../ai/config/tenant-config.service.js';
import type { AppTx, TenantContext } from '../db/tenant-context.js';
import { publishConversationEvent } from '../realtime/publish.js';
import { ConversationScope, scopeCondition, type Scope } from './conversation-scope.js';
import { SEND_REJECT_REASON } from '../messaging/outbound/outbound.service.js';
import type {
  ConversationDetail,
  LeadList,
  LeadListQuery,
  LeadRow,
  MessageDto,
  ReplyBlockedReason,
} from './inbox.contracts.js';

const PREVIEW_CHARS = 160;
// Solo dígitos y separadores de teléfono, con al menos 4 dígitos: se busca por número.
const PHONE_QUERY = /^[\d\s+\-()]+$/;
const PHONE_MIN_DIGITS = 4;

/**
 * timestamptz como texto ISO 8601 con zona y microsegundos (to_json). tx.execute devuelve los timestamptz
 * como texto crudo de Postgres; así el formato es estable y el cursor de mensajes no pierde precisión.
 */
const iso = (column: SQL) => sql`to_json(${column}) #>> '{}'`;

// Expresiones compartidas por la lista y el resumen (sobre conversations c).
const STATE = sql`CASE WHEN c.handed_off_at IS NOT NULL THEN 'handed_off'
  WHEN c.ai_paused_until > now() THEN 'ai_paused' ELSE 'open' END`;
// Derivada sin respuesta de una persona del equipo desde la derivación.
const PENDING = sql`(c.handed_off_at IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM messages um WHERE um.conversation_id = c.id AND um.sender_type = 'user'
    AND um.sent_at >= c.handed_off_at) AND NOT EXISTS (
  SELECT 1 FROM outbound_messages uo WHERE uo.conversation_id = c.id AND uo.sender_type = 'user'
    AND uo.status IN ('queued', 'sending') AND uo.created_at >= c.handed_off_at))`;

// Bandeja (sort=priority, decisión #82):
//   1. arriba, las que ya atendió una persona y esperan respuesta (el cliente le contestó a alguien del equipo);
//   2. después, un puntaje que pesa por igual el calor del lead (lead_score / 100) y cuánto hace que el cliente
//      espera respuesta (horas / 24, con tope en 1). Sin espera, solo cuenta el calor.
// "Respuesta" es un mensaje de la IA o de una persona: los textos fijos automáticos (app) no cuentan.
const HEAT_WEIGHT = 0.5;
const WAIT_WEIGHT = 0.5;
const WAIT_CAP_SECONDS = 24 * 60 * 60;

// ORDER BY de texto fijo (sort y dir son enums ya validados): nada del input llega como SQL. Se aplica sobre
// la consulta base de la lista (leadBase), que expone las columnas calculadas con el alias c.
const DEFAULT_ORDER = 'c.pending DESC, c.lead_score DESC NULLS LAST, c.last_message_at DESC, c.id DESC';
const PRIORITY_ORDER = `c.human_waiting DESC,
  (${HEAT_WEIGHT} * COALESCE(c.lead_score, 0) / 100.0
   + ${WAIT_WEIGHT} * LEAST(GREATEST(COALESCE(EXTRACT(EPOCH FROM now() - c.waiting_since), 0), 0)
       / ${WAIT_CAP_SECONDS}.0, 1)) DESC,
  c.last_message_at DESC, c.id DESC`;
const ORDER_BY: Record<LeadListQuery['sort'], Record<LeadListQuery['dir'], string>> = {
  default: { desc: DEFAULT_ORDER, asc: DEFAULT_ORDER },
  priority: { desc: PRIORITY_ORDER, asc: PRIORITY_ORDER },
  score: {
    desc: 'c.lead_score DESC NULLS LAST, c.last_message_at DESC, c.id DESC',
    asc: 'c.lead_score ASC NULLS LAST, c.last_message_at DESC, c.id DESC',
  },
  last_message: {
    desc: 'c.last_message_at DESC, c.id DESC',
    asc: 'c.last_message_at ASC, c.id ASC',
  },
};

type LeadSqlRow = {
  id: string;
  display_name: string | null;
  profile_name: string | null;
  wa_id: string;
  channel_id: string;
  channel_name: string;
  channel_phone: string;
  lead_score: number | null;
  lead_tier: LeadRow['tier'];
  state: LeadRow['state'];
  pending: boolean;
  waiting_since: string | null;
  unread: boolean;
  last_message_at: string;
  lm_type: MessageDto['type'] | null;
  lm_sender_type: MessageDto['senderType'] | null;
  lm_preview: string | null;
  lm_sent_at: string | null;
};

/** Escapa los comodines de LIKE (con ESCAPE '\'). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Cursor opaco de mensajes: (sent_at, id) del más viejo de la página. */
export function encodeCursor(sentAt: string, id: string): string {
  return Buffer.from(`${sentAt}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { sentAt: string; id: string } | null {
  const [sentAt, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !sentAt || !id) return null;
  // ISO 8601 completo (lo que arma encodeCursor): Date.parse aceptaría "1", que Postgres rechaza (500).
  if (!ISO_TIMESTAMP.test(sentAt) || !UUID.test(id)) return null;
  return { sentAt, id };
}

@Injectable()
export class InboxService {
  constructor(
    private readonly scopes: ConversationScope,
    private readonly configs: TenantConfigService,
  ) {}

  async listLeads(tx: AppTx, context: TenantContext, query: LeadListQuery): Promise<LeadList> {
    const scope = await this.scopes.resolve(tx, context);
    const empty = { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    if (!scope.all && scope.channelIds.length === 0) return { ...empty, noChannels: true };

    const base = leadBase(this.leadFilters(scope, query), context.userId);
    const attention =
      query.attention === 'unanswered'
        ? sql`c.waiting_since IS NOT NULL`
        : query.attention === 'unread'
          ? sql`c.unread`
          : sql`true`;
    const count = await tx.execute<{ total: number }>(sql`
      WITH base AS (${base}) SELECT count(*)::int AS total FROM base c WHERE ${attention}
    `);
    const total = count.rows[0]?.total ?? 0;

    const result = await tx.execute<LeadSqlRow>(sql`
      WITH base AS (${base})
      SELECT c.id, c.display_name, c.profile_name, c.wa_id,
             ch.id AS channel_id, ch.name AS channel_name, ch.phone_number AS channel_phone,
             c.lead_score, c.lead_tier, ${STATE} AS state, c.pending, c.unread,
             ${iso(sql`c.waiting_since`)} AS waiting_since,
             ${iso(sql`c.last_message_at`)} AS last_message_at,
             lm.type AS lm_type, lm.sender_type AS lm_sender_type,
             left(lm.body, ${PREVIEW_CHARS}) AS lm_preview, ${iso(sql`lm.sent_at`)} AS lm_sent_at
      FROM base c
      JOIN channels ch ON ch.id = c.channel_id
      LEFT JOIN LATERAL (
        SELECT m.type, m.sender_type, m.body, m.sent_at FROM messages m
        WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC, m.id DESC LIMIT 1
      ) lm ON true
      WHERE ${attention}
      ORDER BY ${sql.raw(ORDER_BY[query.sort][query.dir])}
      LIMIT ${query.pageSize} OFFSET ${query.page * query.pageSize}
    `);
    return { ...empty, total, items: result.rows.map(toLeadRow), noChannels: false };
  }

  /** Marca la conversación como vista hasta ahora para el usuario del request ("sin ver" es por persona). */
  async markRead(tx: AppTx, context: TenantContext, id: string): Promise<void> {
    const channelId = await this.assertVisible(tx, context, id);
    await tx.execute(sql`
      INSERT INTO conversation_reads (tenant_id, conversation_id, user_id, last_read_at)
      VALUES (app_tenant_id(), ${id}, ${context.userId}, now())
      ON CONFLICT (conversation_id, user_id)
      DO UPDATE SET last_read_at = GREATEST(conversation_reads.last_read_at, EXCLUDED.last_read_at)
    `);
    // Solo a los streams de este usuario (sus otras pestañas): "sin ver" es por persona.
    await publishConversationEvent(tx, 'conversation.read', {
      tenantId: context.tenantId,
      channelId,
      conversationId: id,
      userId: context.userId,
    });
  }

  async summary(tx: AppTx, context: TenantContext) {
    const scope = await this.scopes.resolve(tx, context);
    const channels = await tx.execute<{ id: string; name: string; phone_number: string }>(sql`
      SELECT ch.id, ch.name, ch.phone_number FROM channels ch
      WHERE ${scopeCondition(scope, sql`ch.id`)} ORDER BY ch.name, ch.id
    `);
    const pending = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM conversations c
      WHERE c.status <> 'archived' AND ${scopeCondition(scope, sql`c.channel_id`)} AND ${PENDING}
    `);
    return {
      pendingHandoffs: pending.rows[0]?.n ?? 0,
      channels: channels.rows.map((row) => ({ id: row.id, name: row.name, phoneNumber: row.phone_number })),
    };
  }

  async getConversation(tx: AppTx, context: TenantContext, id: string): Promise<ConversationDetail> {
    const scope = await this.scopes.resolve(tx, context);
    const result = await tx.execute<{
      id: string;
      display_name: string | null;
      profile_name: string | null;
      wa_id: string;
      channel_id: string;
      channel_name: string;
      channel_phone: string;
      lead_score: number | null;
      lead_tier: ConversationDetail['tier'];
      score_breakdown: unknown;
      extracted_data: Record<string, unknown> | null;
      handed_off_at: string | null;
      handoff_reason: string | null;
      handoff_summary: string | null;
      ai_paused_until: string | null;
      paused: boolean;
      last_message_at: string;
      reactivated_at: string | null;
      reactivated_by: string | null;
      reply_reason: ReplyBlockedReason | null;
      sending_paused_until: string | null;
    }>(sql`
      SELECT c.id, ct.display_name, ct.profile_name, ct.wa_id,
             ${SEND_REJECT_REASON} AS reply_reason,
             CASE WHEN ch.sending_paused_until > now() AND ch.sending_paused_until <> 'infinity'
               THEN ${iso(sql`ch.sending_paused_until`)} END AS sending_paused_until,
             ch.id AS channel_id, ch.name AS channel_name, ch.phone_number AS channel_phone,
             c.lead_score, c.lead_tier, c.score_breakdown, c.extracted_data,
             ${iso(sql`c.handed_off_at`)} AS handed_off_at, c.handoff_reason, c.handoff_summary,
             ${iso(sql`c.ai_paused_until`)} AS ai_paused_until,
             COALESCE(c.ai_paused_until > now(), false) AS paused,
             ${iso(sql`c.last_message_at`)} AS last_message_at,
             ${iso(sql`ev.created_at`)} AS reactivated_at, u.name AS reactivated_by
      FROM conversations c
      JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
      JOIN channels ch ON ch.tenant_id = c.tenant_id AND ch.id = c.channel_id
      LEFT JOIN LATERAL (
        SELECT e.created_at, e.user_id FROM conversation_events e
        WHERE e.conversation_id = c.id AND e.type = 'ai_reactivated'
        ORDER BY e.created_at DESC LIMIT 1
      ) ev ON true
      LEFT JOIN users u ON u.id = ev.user_id
      WHERE c.id = ${id} AND ${scopeCondition(scope, sql`c.channel_id`)}
    `);
    const row = result.rows[0];
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND' });

    const labels = await this.fieldLabels(tx);
    return {
      id: row.id,
      contact: { name: row.display_name ?? row.profile_name, waId: row.wa_id },
      channel: { id: row.channel_id, name: row.channel_name, phoneNumber: row.channel_phone },
      score: row.lead_score,
      tier: row.lead_tier,
      scoreBreakdown: toBreakdown(row.score_breakdown),
      extractedData: Object.entries(row.extracted_data ?? {})
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => ({
          key,
          label: labels.get(key) ?? null,
          value: typeof value === 'object' ? JSON.stringify(value) : String(value),
        })),
      handoff: row.handed_off_at
        ? { at: row.handed_off_at, reason: row.handoff_reason!, summary: row.handoff_summary }
        : null,
      ai: {
        state: row.handed_off_at ? 'handed_off' : row.paused ? 'paused' : 'active',
        pausedUntil: row.paused ? row.ai_paused_until : null,
        lastReactivation: row.reactivated_at ? { at: row.reactivated_at, byName: row.reactivated_by } : null,
      },
      reply: {
        allowed: row.reply_reason === null,
        reason: row.reply_reason,
        pausedUntil: row.reply_reason === 'channel_paused' ? row.sending_paused_until : null,
      },
      lastMessageAt: row.last_message_at,
    };
  }

  async listMessages(
    tx: AppTx,
    context: TenantContext,
    id: string,
    query: { before?: string; limit: number },
  ): Promise<{ items: MessageDto[]; nextBefore: string | null }> {
    await this.assertVisible(tx, context, id);
    let before: SQL = sql`true`;
    if (query.before) {
      const cursor = decodeCursor(query.before);
      if (!cursor) throw new BadRequestException({ code: 'VALIDATION_ERROR', issues: [{ path: 'before' }] });
      before = sql`(i.at, i.id) < (${cursor.sentAt}::timestamptz, ${cursor.id}::uuid)`;
    }
    const result = await tx.execute<ItemSqlRow>(sql`
      ${conversationItems(id)}
      SELECT ${ITEM_COLUMNS} FROM items i
      WHERE ${before}
      ORDER BY i.at DESC, i.id DESC
      LIMIT ${query.limit + 1}
    `);
    const rows = result.rows.slice(0, query.limit);
    const oldest = rows.at(-1);
    return {
      items: rows.reverse().map(toMessageDto),
      nextBefore: result.rows.length > query.limit && oldest ? encodeCursor(oldest.sent_at, oldest.id) : null,
    };
  }

  /**
   * Un envío del outbox como mensaje de la lista (la respuesta de POST .../messages): el mensaje enviado
   * si ya salió, o la fila de la cola si todavía no.
   */
  async outboundAsMessage(tx: AppTx, conversationId: string, outboundId: string): Promise<MessageDto> {
    const result = await tx.execute<ItemSqlRow>(sql`
      ${conversationItems(conversationId)}
      SELECT ${ITEM_COLUMNS} FROM items i
      WHERE i.id = (SELECT COALESCE(o.message_id, o.id) FROM outbound_messages o WHERE o.id = ${outboundId})
    `);
    const row = result.rows[0];
    if (!row) throw new Error('No se encontró el envío recién encolado');
    return toMessageDto(row);
  }

  /**
   * Vuelve a activar la IA: borra la derivación y la pausa, reinicia los contadores de calificación y deja
   * el registro en conversation_events. Si no estaba derivada ni pausada, no hace nada (idempotente).
   */
  async reactivateAi(tx: AppTx, context: TenantContext, id: string): Promise<ConversationDetail> {
    const scope = await this.scopes.resolve(tx, context);
    const result = await tx.execute<{
      channel_id: string;
      handed_off_at: string | null;
      handoff_reason: string | null;
      ai_paused_until: string | null;
      paused: boolean;
      qualification_turns: number;
      hot_turns: number;
    }>(sql`
      SELECT c.channel_id, ${iso(sql`c.handed_off_at`)} AS handed_off_at, c.handoff_reason,
             ${iso(sql`c.ai_paused_until`)} AS ai_paused_until,
             COALESCE(c.ai_paused_until > now(), false) AS paused, c.qualification_turns, c.hot_turns
      FROM conversations c
      WHERE c.id = ${id} AND ${scopeCondition(scope, sql`c.channel_id`)}
      FOR UPDATE
    `);
    const row = result.rows[0];
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND' });

    if (row.handed_off_at || row.paused) {
      await tx.execute(sql`
        UPDATE conversations
        SET handed_off_at = NULL, handoff_reason = NULL, ai_paused_until = NULL,
            qualification_turns = 0, hot_turns = 0
        WHERE id = ${id}
      `);
      // Sin texto del cliente: fechas, código del motivo y contadores.
      const data = {
        previous_handed_off_at: row.handed_off_at,
        previous_handoff_reason: row.handoff_reason,
        previous_ai_paused_until: row.ai_paused_until,
        previous_qualification_turns: row.qualification_turns,
        previous_hot_turns: row.hot_turns,
      };
      await tx.execute(sql`
        INSERT INTO conversation_events (tenant_id, conversation_id, type, user_id, data, created_at)
        VALUES (app_tenant_id(), ${id}, 'ai_reactivated', ${context.userId}, ${JSON.stringify(data)}::jsonb,
                clock_timestamp())
      `);
      await publishConversationEvent(tx, 'conversation.updated', {
        tenantId: context.tenantId,
        channelId: row.channel_id,
        conversationId: id,
      });
    }
    return this.getConversation(tx, context, id);
  }

  /** 404 si no existe o no se ve; si se ve, su número (canal). */
  private async assertVisible(tx: AppTx, context: TenantContext, id: string): Promise<string> {
    const scope = await this.scopes.resolve(tx, context);
    const result = await tx.execute<{ channel_id: string }>(sql`
      SELECT c.channel_id FROM conversations c
      WHERE c.id = ${id} AND ${scopeCondition(scope, sql`c.channel_id`)}
    `);
    const row = result.rows[0];
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND' });
    return row.channel_id;
  }

  private leadFilters(scope: Scope, query: LeadListQuery): SQL {
    const conditions: SQL[] = [sql`c.status <> 'archived'`, scopeCondition(scope, sql`c.channel_id`)];
    if (query.channelId) conditions.push(sql`c.channel_id = ${query.channelId}`);
    if (query.status) conditions.push(sql`${STATE} = ${query.status}`);
    if (query.tier) {
      const tiers = query.tier.split(',');
      const named = tiers.filter((tier) => tier !== 'none');
      const parts: SQL[] = [];
      if (named.length > 0) parts.push(sql`c.lead_tier = ANY (${sql.param(named)}::text[])`);
      if (tiers.includes('none')) parts.push(sql`c.lead_tier IS NULL`);
      conditions.push(sql`(${sql.join(parts, sql` OR `)})`);
    }
    if (query.q) {
      const digits = query.q.replace(/\D/g, '');
      if (PHONE_QUERY.test(query.q) && digits.length >= PHONE_MIN_DIGITS) {
        conditions.push(sql`regexp_replace(ct.wa_id, '[^0-9]', '', 'g') LIKE ${`%${digits}%`}`);
      } else {
        const pattern = `%${escapeLike(query.q)}%`;
        conditions.push(
          sql`(ct.display_name ILIKE ${pattern} ESCAPE '\\' OR ct.profile_name ILIKE ${pattern} ESCAPE '\\')`,
        );
      }
    }
    return sql.join(conditions, sql` AND `);
  }

  /** Etiquetas de los campos de calificación de la config vigente (key → label). */
  private async fieldLabels(tx: AppTx): Promise<Map<string, string>> {
    const lookup = await this.configs.latest(tx);
    if (lookup.kind !== 'ok') return new Map();
    return new Map(lookup.config.qualification.fields.map((field) => [field.key, field.label]));
  }
}

/**
 * Conversaciones de la lista con las columnas que se calculan (alias c en el resto de la consulta):
 *   pending        derivada y sin respuesta de una persona desde la derivación (una del panel en cola cuenta);
 *   waiting_since  el primer mensaje del cliente que nadie respondió (IA o persona, también una respuesta
 *                  del panel en cola); NULL si no espera;
 *   human_waiting  espera respuesta y ya habló con alguien del equipo;
 *   unread         hay mensajes del cliente posteriores a lo que vio este usuario.
 */
function leadBase(where: SQL, userId: string): SQL {
  return sql`
    SELECT c.id, c.channel_id, c.lead_score, c.lead_tier, c.last_message_at, c.handed_off_at,
           c.ai_paused_until, ct.display_name, ct.profile_name, ct.wa_id,
           ${PENDING} AS pending,
           w.waiting_since,
           (w.waiting_since IS NOT NULL AND EXISTS (
             SELECT 1 FROM messages hm WHERE hm.conversation_id = c.id AND hm.sender_type = 'user'
           )) AS human_waiting,
           EXISTS (
             SELECT 1 FROM messages im
             WHERE im.conversation_id = c.id AND im.sender_type = 'contact'
               AND im.sent_at > COALESCE((
                 SELECT r.last_read_at FROM conversation_reads r
                 WHERE r.conversation_id = c.id AND r.user_id = ${userId}
               ), '-infinity')
           ) AS unread
    FROM conversations c
    JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
    LEFT JOIN LATERAL (
      SELECT min(m.sent_at) AS waiting_since FROM messages m
      WHERE m.conversation_id = c.id AND m.sender_type = 'contact'
        AND m.sent_at > GREATEST(
          COALESCE((
            SELECT max(rm.sent_at) FROM messages rm
            WHERE rm.conversation_id = c.id AND rm.sender_type IN ('ai', 'user')
          ), '-infinity'),
          -- Una respuesta del panel cuenta desde que se encola (si falla, vuelve a esperar).
          COALESCE((
            SELECT max(ro.created_at) FROM outbound_messages ro
            WHERE ro.conversation_id = c.id AND ro.sender_type = 'user' AND ro.status IN ('queued', 'sending')
          ), '-infinity'))
    ) w ON true
    WHERE ${where}
  `;
}

type ItemSqlRow = {
  id: string;
  direction: MessageDto['direction'];
  sender_type: MessageDto['senderType'];
  sent_by_name: string | null;
  type: MessageDto['type'];
  body: string | null;
  message_status: 'received' | 'sent' | 'delivered' | 'read' | 'failed' | null;
  outbox_status: 'queued' | 'sending' | 'sent' | 'failed' | 'rejected' | null;
  last_error: string | null;
  reject_reason: string | null;
  sent_at: string;
};

/**
 * CTE `items` de una conversación: los mensajes (entrantes y salientes ya enviados) y los envíos del
 * outbox que todavía no tienen mensaje (en cola, enviándose, fallidos o rechazados). Un envío que salió
 * se ve una sola vez: el worker crea el mensaje y le pone message_id al outbox en la misma transacción.
 * Las respuestas de la IA que dejó sin efecto una persona (superseded) nunca salieron y no se muestran.
 * Columnas explícitas: nunca raw, media_key, la clave de idempotencia ni el error del proveedor.
 */
function conversationItems(conversationId: string): SQL {
  return sql`
    WITH items AS (
      SELECT m.id, m.direction, m.sender_type, u.name AS sent_by_name, m.type, m.body,
             m.status AS message_status, NULL::text AS outbox_status, NULL::text AS last_error,
             NULL::text AS reject_reason, m.sent_at AS at
      FROM messages m
      LEFT JOIN users u ON u.id = m.sent_by_user_id
      WHERE m.conversation_id = ${conversationId}
      UNION ALL
      SELECT o.id, 'outbound', o.sender_type, u.name, 'text', o.body,
             NULL, o.status, o.last_error, o.reject_reason, o.created_at
      FROM outbound_messages o
      LEFT JOIN users u ON u.id = o.sent_by_user_id
      WHERE o.conversation_id = ${conversationId} AND o.message_id IS NULL
        AND o.reject_reason IS DISTINCT FROM 'superseded'
    )`;
}

const ITEM_COLUMNS = sql`i.id, i.direction, i.sender_type, i.sent_by_name, i.type, i.body, i.message_status,
  i.outbox_status, i.last_error, i.reject_reason, ${iso(sql`i.at`)} AS sent_at`;

function toMessageDto(row: ItemSqlRow): MessageDto {
  return {
    id: row.id,
    direction: row.direction,
    senderType: row.sender_type,
    sentByName: row.sender_type === 'user' ? row.sent_by_name : null,
    type: row.type,
    body: row.body,
    delivery: toDelivery(row),
    sentAt: row.sent_at,
  };
}

/** Estado que ve el panel: del outbox mientras no hay mensaje; después, de los acuses del mensaje. */
function toDelivery(row: ItemSqlRow): MessageDto['delivery'] {
  if (row.direction === 'inbound') return null;
  switch (row.outbox_status ?? row.message_status) {
    case 'queued':
      return { state: 'queued', reason: null };
    case 'sending':
      return { state: 'sending', reason: null };
    case 'delivered':
      return { state: 'delivered', reason: null };
    case 'read':
      return { state: 'read', reason: null };
    case 'failed':
      // unknown_outcome: el pedido pudo haber llegado (el panel no ofrece reintentar).
      return { state: 'failed', reason: row.last_error === 'unknown_outcome' ? 'maybe_sent' : 'not_sent' };
    case 'rejected':
      return { state: 'rejected', reason: row.reject_reason as ReplyBlockedReason };
    default:
      return { state: 'sent', reason: null };
  }
}

function toLeadRow(row: LeadSqlRow): LeadRow {
  return {
    id: row.id,
    contact: { name: row.display_name ?? row.profile_name, waId: row.wa_id },
    channel: { id: row.channel_id, name: row.channel_name, phoneNumber: row.channel_phone },
    score: row.lead_score,
    tier: row.lead_tier,
    state: row.state,
    pendingHandoff: row.pending,
    awaitingReply: row.waiting_since !== null,
    waitingSince: row.waiting_since,
    unread: row.unread,
    lastMessage:
      row.lm_type && row.lm_sender_type && row.lm_sent_at
        ? {
            type: row.lm_type,
            senderType: row.lm_sender_type,
            preview: row.lm_preview,
            sentAt: row.lm_sent_at,
          }
        : null,
    lastMessageAt: row.last_message_at,
  };
}

type Breakdown = NonNullable<ConversationDetail['scoreBreakdown']>;

/** El breakdown que guarda el worker (dimensiones como objeto) → lista para el panel. */
function toBreakdown(raw: unknown): ConversationDetail['scoreBreakdown'] {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as {
    dimensions?: Record<string, { signal?: unknown; weight?: unknown; points?: unknown }>;
    completeness?: Breakdown['completeness'];
  };
  if (!value.dimensions || typeof value.dimensions !== 'object') return null;
  return {
    dimensions: Object.entries(value.dimensions).map(([key, dimension]) => ({
      key,
      signal: Number(dimension.signal ?? 0),
      weight: Number(dimension.weight ?? 0),
      points: Number(dimension.points ?? 0),
    })),
    completeness: value.completeness ?? null,
  };
}
