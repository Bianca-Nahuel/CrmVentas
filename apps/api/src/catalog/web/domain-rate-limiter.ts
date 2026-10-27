// Como mucho un pedido cada `intervalMs` por dominio, en memoria (una sola instancia de la API). Si hay
// varias instancias, cada una lleva su cuenta: queda anotado como deuda en docs/decisiones.md.
export class DomainRateLimiter {
  private readonly next = new Map<string, number>();

  constructor(
    private readonly intervalMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Espera su turno para el dominio. Los turnos se reservan al llamar, así dos pedidos no salen juntos. */
  async wait(host: string, signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, slot + this.intervalMs);
    const delay = slot - now;
    if (delay <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          // El pedido no va a salir: devuelve su turno para no empujar la cola del dominio.
          const next = this.next.get(host);
          if (next !== undefined) this.next.set(host, Math.max(this.now(), next - this.intervalMs));
          resolve();
        },
        { once: true },
      );
    });
  }
}
