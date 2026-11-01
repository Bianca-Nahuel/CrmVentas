// Contratos HTTP de "Números y vendedores" (tarea 014). Ver inbox.contracts.ts.
import { z } from 'zod';
import type { ApiRoute } from '../http/api-route.js';

const uuid = z.uuid();

const memberRefSchema = z
  .object({ userId: uuid, name: z.string(), email: z.string() })
  .meta({ id: 'MemberRef' });

export const channelWithMembersSchema = z
  .object({
    id: uuid,
    name: z.string(),
    phoneNumber: z.string(),
    status: z.enum(['pending', 'connected', 'disconnected', 'banned']),
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

export const channelRoutes: ApiRoute[] = [
  {
    method: 'get',
    path: '/channels',
    operationId: 'listChannels',
    summary: 'Números de la empresa con sus vendedores asignados',
    response: channelListSchema,
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
