import { describe, expect, it } from 'vitest';
import type { ChannelWithMembers } from '../../api/generated';
import { channelStatus, disconnectExplanation, neverConnected } from './channel-state';

const base: ChannelWithMembers = {
  id: '01a19916-cee2-7bc6-a858-93b504bd76cc',
  name: 'Ventas Centro',
  phoneNumber: '+5491100000001',
  status: 'connected',
  connectedAt: '2026-11-01T10:32:00.000-03:00',
  disconnectedAt: null,
  disconnectReason: null,
  numberInUse: null,
  sendingPause: null,
  sellers: [],
};

describe('channelStatus', () => {
  it('cada estado tiene texto (no solo color)', () => {
    expect(channelStatus(base).label).toBe('Conectado');
    expect(channelStatus({ ...base, status: 'pending', phoneNumber: null }).label).toBe(
      'Esperando el escaneo',
    );
    expect(channelStatus({ ...base, status: 'pending' }).label).toBe('Reconectando');
    expect(channelStatus({ ...base, status: 'disconnected' }).label).toBe('Desconectado');
    expect(channelStatus({ ...base, status: 'banned' }).label).toBe('Bloqueado por WhatsApp');
  });
});

describe('disconnectExplanation', () => {
  const disconnected = (patch: Partial<ChannelWithMembers>) =>
    disconnectExplanation({ ...base, status: 'disconnected', ...patch });

  it('conectado o esperando: sin explicación', () => {
    expect(disconnectExplanation(base)).toBeNull();
    expect(disconnectExplanation({ ...base, status: 'pending' })).toBeNull();
  });

  it('explica cada motivo', () => {
    expect(disconnected({ disconnectReason: 'logged_out' })).toContain('persona del equipo');
    expect(disconnected({ disconnectReason: 'phone_mismatch' })).toContain('+5491100000001');
    expect(disconnected({ disconnectReason: 'pairing_expired' })).toContain('venció');
    expect(disconnected({ disconnectReason: 'session_failed' })).toContain('cerró la sesión');
    expect(disconnected({ disconnectReason: null })).toContain('Se perdió la conexión');
  });

  it('número repetido: dice el canal si es de la empresa; si es de otra cuenta, no dice cuál', () => {
    expect(
      disconnected({
        disconnectReason: 'number_in_use',
        numberInUse: { scope: 'same_tenant', channelName: 'Sucursal Norte' },
      }),
    ).toBe('Ese número ya está conectado en el canal «Sucursal Norte».');
    expect(
      disconnected({
        disconnectReason: 'number_in_use',
        numberInUse: { scope: 'other_tenant', channelName: null },
      }),
    ).toBe('Ese número ya está conectado en otra cuenta. Escribinos para revisarlo.');
  });
});

describe('neverConnected', () => {
  it('solo sin número y sin haberse conectado nunca', () => {
    expect(neverConnected({ ...base, status: 'pending', phoneNumber: null, connectedAt: null })).toBe(true);
    expect(neverConnected({ ...base, status: 'disconnected', phoneNumber: null, connectedAt: null })).toBe(
      true,
    );
    expect(neverConnected({ ...base, status: 'disconnected' })).toBe(false);
  });
});
