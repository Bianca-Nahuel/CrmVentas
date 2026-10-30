import { TestBed } from '@angular/core/testing';
import { Score } from './score';

async function render(inputs: {
  score: number | null;
  level: 'hot' | 'warm' | 'cold' | null;
  variant?: string;
}) {
  const fixture = TestBed.createComponent(Score);
  fixture.componentRef.setInput('score', inputs.score);
  fixture.componentRef.setInput('level', inputs.level);
  if (inputs.variant) fixture.componentRef.setInput('variant', inputs.variant);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('Score', () => {
  it('es un meter accesible con el valor y el nivel en texto', async () => {
    const el = await render({ score: 78, level: 'hot' });
    expect(el.getAttribute('role')).toBe('meter');
    expect(el.getAttribute('aria-valuemin')).toBe('0');
    expect(el.getAttribute('aria-valuemax')).toBe('100');
    expect(el.getAttribute('aria-valuenow')).toBe('78');
    expect(el.getAttribute('aria-valuetext')).toBe('78 de 100, caliente');
    expect(el.textContent).toContain('78');
    expect(el.textContent).toContain('Caliente');
  });

  it.each([
    ['hot', 'Caliente'],
    ['warm', 'Tibio'],
    ['cold', 'Frío'],
  ] as const)('el nivel %s se lee como texto, no solo como color', async (level, label) => {
    const el = await render({ score: 50, level });
    expect(el.textContent).toContain(label);
    expect(el.querySelector('svg')).not.toBeNull();
  });

  it('no calcula el nivel: muestra el que manda el backend aunque el número "parezca" otro', async () => {
    const el = await render({ score: 15, level: 'hot' });
    expect(el.textContent).toContain('Caliente');
  });

  it('acota el puntaje entre 0 y 100 y lo redondea', async () => {
    expect((await render({ score: 140, level: 'hot' })).getAttribute('aria-valuenow')).toBe('100');
    expect((await render({ score: -3, level: 'cold' })).getAttribute('aria-valuenow')).toBe('0');
    expect((await render({ score: 66.6, level: 'warm' })).getAttribute('aria-valuenow')).toBe('67');
  });

  it('sin puntaje: "Sin calificar", sin role meter', async () => {
    const el = await render({ score: null, level: null });
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-valuenow')).toBeNull();
    expect(el.getAttribute('aria-label')).toBe('Puntaje del lead: sin calificar');
    expect(el.textContent).toContain('—');
  });

  it('compacto: el nivel queda en title y aria-valuetext', async () => {
    const el = await render({ score: 64, level: 'warm', variant: 'compact' });
    expect(el.getAttribute('title')).toBe('64 de 100, tibio');
    expect(el.getAttribute('aria-valuetext')).toBe('64 de 100, tibio');
  });
});
