// Como mucho `limit` usos por clave en una ventana de `windowMs`, en memoria (una sola instancia de la API,
// igual que DomainRateLimiter). Lo usan el probador del extractor (por empresa) y "Actualizar precio" (por
// usuario) del panel (tarea 027). Con varias instancias, cada una lleva su cuenta: deuda anotada en
// docs/decisiones.md.
export class WindowLimiter {
  private readonly uses = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Cuenta un uso si hay lugar. false = se pasó del límite (no se cuenta). */
  take(key: string): boolean {
    const now = this.now();
    const recent = (this.uses.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.uses.set(key, recent);
      return false;
    }
    recent.push(now);
    this.uses.set(key, recent);
    // Sin crecer para siempre: de vez en cuando se borran las claves sin usos recientes.
    if (this.uses.size > 1_000) {
      for (const [other, times] of this.uses) {
        if (times.every((at) => now - at >= this.windowMs)) this.uses.delete(other);
      }
    }
    return true;
  }
}
