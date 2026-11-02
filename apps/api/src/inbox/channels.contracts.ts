// Contratos HTTP de los canales: "Números y vendedores" (tarea 014) y la conexión por QR (tarea 011).
// Ver inbox.contracts.ts.
import { z } from 'zod';
import type { ApiRoute } from '../http/api-route.js';

const uuid = z.uuid();
const isoDate = z.iso.datetime({ offset: true });

const memberRefSchema = z
  .object({ userId: uuid, name: z.string(), email: z.string() })
  .meta({ id: 'MemberRef' });

// Mismos valores que el CHECK de channels.disconnect_reason (0019).
export const CHANNEL_DISCONNECT_REASONS = [
  'logged_out',
  'phone_mismatch',
  'number_in_use',
  'pairing_expired',
  'session_failed',
] as const;
const disconnectReasonSchema = z.enum(CHANNEL_DISCONNECT_REASONS).meta({ id: 'ChannelDisconnectReason' });
// Con number_in_use: si el número está en otro canal de esta empresa (se dice cuál) o en otra cuenta (no se
// dice cuál).
const numberInUseSchema = z
  .object({ scope: z.enum(['same_tenant', 'other_tenant']), channelName: z.string().nullable() })
  .nullable();

export const channelWithMembersSchema = z
  .object({
    id: uuid,
    name: z.string(),
    // Sale del escaneo del QR: null mientras el canal nunca se conectó.
    phoneNumber: z.string().nullable(),
    status: z.enum(['pending', 'connected', 'disconnected', 'banned']),
    connectedAt: isoDate.nullable(),
    disconnectedAt: isoDate.nullable(),
    disconnectReason: disconnectReasonSchema.nullable(),
    numberInUse: numberInUseSchema,
    // Envíos frenados (riesgo de bloqueo, errores 463/475). until null: sin vencimiento, hasta levantarla.
    sendingPause: z.object({ until: isoDate.nullable(), blockedRisk: z.boolean() }).nullable(),
    // Solo vendedores con la membresía activa.
    sellers: z.array(memberRefSchema),
  })
  .meta({ id: 'ChannelWithMembers' });

export const channelListSchema = z
  .object({ items: z.array(channelWithMembersSchema) })
  .meta({ id: 'ChannelList' });

export const channelParamsSchema = z.object({ id: uuid }).strict();

export const CHANNEL_MAX_SELLERS = 50;
export const setChannelMembersSchema = z
  .object({ userIds: z.array(uuid).max(CHANNEL_MAX_SELLERS) })
  .strict()
  .meta({ id: 'SetChannelMembers' });

export const sellerOptionsSchema = z
  .object({ items: z.array(memberRefSchema) })
  .meta({ id: 'SellerOptions' });

// Alta: solo el nombre. provider, external_id, el número y quién conectó (risk_accepted_*) los pone el
// sistema; cualquier otro campo da 400 (strict). Los riesgos de la conexión no oficial se acuerdan con la
// empresa fuera del panel (decisión #101).
export const CHANNEL_NAME_MAX = 100;
export const createChannelBodySchema = z
  .object({
    name: z.string().trim().min(1).max(CHANNEL_NAME_MAX),
  })
  .strict()
  .meta({ id: 'CreateChannel' });
export type CreateChannelBody = z.infer<typeof createChannelBodySchema>;

/**
 * Vinculación por QR. qr: el código vigente (PNG en data URL), que cambia cada pocos segundos: el panel lo
 * vuelve a pedir y nunca lo guarda. connected: con el número del canal. expired: hace falta un QR nuevo
 * (reconectar). rejected: el escaneo se rechazó (otro teléfono o un número en uso), con el motivo y el número
 * del canal. starting/unavailable: volver a preguntar en unos segundos.
 */
export const channelPairingSchema = z
  .object({
    state: z.enum(['qr', 'starting', 'connected', 'expired', 'rejected', 'unavailable']),
    qr: z.string().nullable(),
    phoneNumber: z.string().nullable(),
    disconnectReason: disconnectReasonSchema.nullable(),
    numberInUse: numberInUseSchema,
  })
  .meta({ id: 'ChannelPairing' });
export type ChannelPairing = z.infer<typeof channelPairingSchema>;

export const channelRoutes: ApiRoute[] = [
  {
    method: 'get',
    path: '/channels',
    operationId: 'listChannels',
    summary: 'Números de la empresa con su estado y sus vendedores asignados',
    response: channelListSchema,
  },
  {
    method: 'post',
    path: '/channels',
    operationId: 'createChannel',
    summary: 'Da de alta un número (conexión no oficial): queda esperando el escaneo del QR',
    body: createChannelBodySchema,
    response: channelWithMembersSchema,
    conflict: true,
  },
  {
    method: 'delete',
    path: '/channels/{id}',
    operationId: 'cancelChannel',
    summary: 'Cancela el alta de un número que nunca se conectó',
    params: channelParamsSchema,
    conflict: true,
  },
  {
    method: 'get',
    path: '/channels/{id}/pairing',
    operationId: 'getChannelPairing',
    summary: 'QR vigente para vincular el número (no se cachea)',
    params: channelParamsSchema,
    response: channelPairingSchema,
  },
  {
    method: 'post',
    path: '/channels/{id}/reconnect',
    operationId: 'reconnectChannel',
    summary: 'Pide un QR nuevo para volver a vincular el número (mismo canal, mismo historial)',
    params: channelParamsSchema,
    response: channelWithMembersSchema,
    conflict: true,
  },
  {
    method: 'post',
    path: '/channels/{id}/disconnect',
    operationId: 'disconnectChannel',
    summary: 'Desvincula el número del sistema',
    params: channelParamsSchema,
    response: channelWithMembersSchema,
    conflict: true,
  },
  {
    method: 'post',
    path: '/channels/{id}/resume-sending',
    operationId: 'resumeChannelSending',
    summary: 'Levanta la pausa de envíos del número (no toca la sesión)',
    params: channelParamsSchema,
    response: channelWithMembersSchema,
    conflict: true,
  },
  {
    method: 'put',
    path: '/channels/{id}/members',
    operationId: 'setChannelMembers',
    summary: 'Reemplaza los vendedores asignados a un número',
    params: channelParamsSchema,
    body: setChannelMembersSchema,
    response: channelWithMembersSchema,
  },
  {
    method: 'get',
    path: '/members/sellers',
    operationId: 'listSellers',
    summary: 'Vendedores activos de la empresa (para asignar números)',
    response: sellerOptionsSchema,
  },
];
