import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { AppTx, TenantContext } from '../db/tenant-context.js';
import type { channelWithMembersSchema } from './channels.contracts.js';

type ChannelWithMembers = z.infer<typeof channelWithMembersSchema>;
type MemberRef = ChannelWithMembers['sellers'][number];

/** Asignación de números a vendedores (owner y admin; el permiso lo controla el guard). */
@Injectable()
export class ChannelsService {
  async list(tx: AppTx): Promise<ChannelWithMembers[]> {
    const channels = await tx.execute<{ id: string; name: string; phone_number: string; status: string }>(sql`
      SELECT id, name, phone_number, status FROM channels ORDER BY name, id
    `);
    const sellers = await this.assignedSellers(tx);
    return channels.rows.map((row) => ({
      id: row.id,
      name: row.name,
      phoneNumber: row.phone_number,
      status: row.status as ChannelWithMembers['status'],
      sellers: sellers.get(row.id) ?? [],
    }));
  }

  /** Vendedores con membresía activa: los únicos que se pueden asignar. */
  async sellerOptions(tx: AppTx): Promise<MemberRef[]> {
    const result = await tx.execute<{ user_id: string; name: string; email: string }>(sql`
      SELECT m.user_id, u.name, u.email
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = app_tenant_id() AND m.status = 'active' AND m.role = 'seller'
      ORDER BY u.name, m.user_id
    `);
    return result.rows.map((row) => ({ userId: row.user_id, name: row.name, email: row.email }));
  }

  /**
   * Reemplaza los vendedores de un número. Cada uno tiene que tener membresía activa con rol seller en la
   * empresa activa; si alguno no cumple (o está repetido), 400 y no cambia nada.
   */
  async setMembers(
    tx: AppTx,
    context: TenantContext,
    channelId: string,
    userIds: string[],
  ): Promise<ChannelWithMembers> {
    const channel = await tx.execute(sql`SELECT 1 FROM channels WHERE id = ${channelId} FOR UPDATE`);
    if (channel.rows.length === 0) throw new NotFoundException({ code: 'NOT_FOUND' });

    const unique = [...new Set(userIds)];
    if (unique.length !== userIds.length) throw new BadRequestException({ code: 'INVALID_MEMBERS' });
    if (unique.length > 0) {
      const valid = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM memberships
        WHERE tenant_id = app_tenant_id() AND status = 'active' AND role = 'seller'
          AND user_id = ANY (${sql.param(unique)}::uuid[])
      `);
      if ((valid.rows[0]?.n ?? 0) !== unique.length)
        throw new BadRequestException({ code: 'INVALID_MEMBERS' });
    }

    // Solo cambia lo que cambió: los que siguen conservan quién y cuándo los asignó.
    await tx.execute(sql`
      DELETE FROM channel_members
      WHERE channel_id = ${channelId} AND user_id <> ALL (${sql.param(unique)}::uuid[])
    `);
    if (unique.length > 0) {
      await tx.execute(sql`
        INSERT INTO channel_members (tenant_id, channel_id, user_id, created_by)
        SELECT app_tenant_id(), ${channelId}, user_id, ${context.userId}
        FROM unnest(${sql.param(unique)}::uuid[]) AS user_id
        ON CONFLICT (channel_id, user_id) DO NOTHING
      `);
    }
    const updated = (await this.list(tx)).find((item) => item.id === channelId);
    return updated!;
  }

  private async assignedSellers(tx: AppTx): Promise<Map<string, MemberRef[]>> {
    const result = await tx.execute<{ channel_id: string; user_id: string; name: string; email: string }>(sql`
      SELECT cm.channel_id, cm.user_id, u.name, u.email
      FROM channel_members cm
      JOIN memberships m ON m.tenant_id = cm.tenant_id AND m.user_id = cm.user_id
      JOIN users u ON u.id = cm.user_id
      WHERE m.status = 'active' AND m.role = 'seller'
      ORDER BY u.name, cm.user_id
    `);
    const byChannel = new Map<string, MemberRef[]>();
    for (const row of result.rows) {
      const list = byChannel.get(row.channel_id) ?? [];
      list.push({ userId: row.user_id, name: row.name, email: row.email });
      byChannel.set(row.channel_id, list);
    }
    return byChannel;
  }
}
