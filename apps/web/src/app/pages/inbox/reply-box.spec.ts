import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { InboxApi } from '../../api/inbox-api';
import type { ConversationDetail, Message } from '../../api/generated';
import { ReplyBox } from './reply-box';

const conversation = (
  reply: ConversationDetail['reply'] = { allowed: true, reason: null, pausedUntil: null },
) =>
  ({
    id: '0190a0a0-0000-7000-8000-000000000001',
    contact: { name: 'Cliente', waId: '+5491100000000' },
    channel: { id: 'c', name: 'ventas-principal', phoneNumber: '+5491100000001' },
    score: null,
    tier: null,
    scoreBreakdown: null,
    extractedData: [],
    handoff: null,
    ai: { state: 'active', pausedUntil: null, lastReactivation: null },
    reply,
    lastMessageAt: new Date().toISOString(),
  }) as ConversationDetail;

const queued = { id: 'm1', delivery: { state: 'queued', reason: null } } as Message;

async function setup(detail = conversation()) {
  const calls: { text: string; key: string; response: Subject<Message> }[] = [];
  const api = {
    sendMessage: vi.fn((_id: string, text: string, key: string) => {
      const response = new Subject<Message>();
      calls.push({ text, key, response });
      return response;
    }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: InboxApi, useValue: api }] });
  const fixture = TestBed.createComponent(ReplyBox);
  fixture.componentRef.setInput('conversation', detail);
  const sent: Message[] = [];
  const blocked: string[] = [];
  fixture.componentInstance.sent.subscribe((m) => sent.push(m));
  fixture.componentInstance.blocked.subscribe((r) => blocked.push(r));
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const input = el.querySelector<HTMLTextAreaElement>('[data-testid="reply-input"]')!;
  const button = el.querySelector<HTMLButtonElement>('[data-testid="reply-send"]')!;
  const type = async (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  const ctrlEnter = async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await fixture.whenStable();
  };
  return { fixture, el, input, button, type, ctrlEnter, calls, sent, blocked };
}

describe('ReplyBox', () => {
  it('avisa por qué número sale y envía con Ctrl+Enter el texto sin espacios de más', async () => {
    const { el, type, ctrlEnter, calls, sent, input, fixture } = await setup();
    expect(el.textContent).toContain('Sale por WhatsApp desde ventas-principal (+5491100000001)');
    await type('  Hola, te paso el precio \n');
    await ctrlEnter();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe('Hola, te paso el precio');
    calls[0]!.response.next(queued);
    calls[0]!.response.complete();
    await fixture.whenStable();
    expect(sent).toEqual([queued]);
    expect(input.value).toBe('');
  });

  it('si sigue escribiendo mientras se envía, no pierde lo nuevo', async () => {
    const { type, ctrlEnter, calls, input, fixture } = await setup();
    await type('Hola');
    await ctrlEnter();
    await type('Hola, y otra cosa');
    calls[0]!.response.next(queued);
    calls[0]!.response.complete();
    await fixture.whenStable();
    expect(input.value).toBe('Hola, y otra cosa');
  });

  it('Enter solo no envía (es un salto de línea) y vacío no se puede enviar', async () => {
    const { input, button, type, calls, fixture } = await setup();
    expect(button.disabled).toBe(true);
    await type('   ');
    expect(button.disabled).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await fixture.whenStable();
    expect(calls).toHaveLength(0);
  });

  it('doble envío mientras está en vuelo → un solo pedido', async () => {
    const { type, ctrlEnter, button, calls } = await setup();
    await type('Hola');
    await ctrlEnter();
    await ctrlEnter();
    button.click();
    expect(calls).toHaveLength(1);
    expect(button.disabled).toBe(true);
  });

  it('reintento después de un error de red: misma clave; si cambia el texto, clave nueva', async () => {
    const { type, ctrlEnter, calls, el, fixture } = await setup();
    await type('Hola');
    await ctrlEnter();
    calls[0]!.response.error(new HttpErrorResponse({ status: 0 }));
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="reply-error"]')?.textContent).toContain('no se repite');
    await ctrlEnter();
    expect(calls[1]!.key).toBe(calls[0]!.key);
    calls[1]!.response.error(new HttpErrorResponse({ status: 502 }));
    await fixture.whenStable();
    await type('Hola, ¿cómo estás?');
    await ctrlEnter();
    expect(calls[2]!.key).not.toBe(calls[0]!.key);
  });

  it('409 con una regla de envío → explica, deshabilita, conserva el borrador y avisa para recargar', async () => {
    const { type, ctrlEnter, calls, el, input, button, blocked, fixture } = await setup();
    await type('Hola');
    await ctrlEnter();
    calls[0]!.response.error(new HttpErrorResponse({ status: 409, error: { code: 'CHANNEL_PAUSED' } }));
    await fixture.whenStable();
    expect(blocked).toEqual(['channel_paused']);
    const notice = el.querySelector('[data-testid="reply-blocked"]');
    expect(notice?.textContent).toContain('pausados por riesgo de bloqueo');
    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(input.value).toBe('Hola');
  });

  it('el detalle dice que no se puede responder → caja deshabilitada con el motivo en texto', async () => {
    const { el, input, button } = await setup(
      conversation({ allowed: false, reason: 'window_expired', pausedUntil: null }),
    );
    expect(el.querySelector('[data-testid="reply-blocked"]')?.textContent).toContain('más de 24 h');
    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(input.getAttribute('aria-describedby')).toBe(
      el.querySelector('[data-testid="reply-blocked"]')!.id,
    );
  });

  it('pasado el tope, muestra el contador y no deja enviar', async () => {
    const { el, type, button } = await setup();
    await type('a'.repeat(3600));
    expect(el.querySelector('[data-testid="reply-counter"]')?.textContent).toContain('3600 / 4096');
    expect(button.disabled).toBe(false);
    await type('a'.repeat(4097));
    expect(button.disabled).toBe(true);
  });
});
