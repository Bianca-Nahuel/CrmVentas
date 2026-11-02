import { BadRequestException, NotFoundException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Valida (y normaliza, con defaults y coerciones) params, query o body con un esquema zod.
 * Error → 400 VALIDATION_ERROR con la ruta de cada campo y el código del problema, nunca el valor recibido.
 * Para params de ruta (ids) conviene `notFound: true`: un id malformado es lo mismo que uno que no existe.
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(
    private readonly schema: T,
    private readonly options: { notFound?: boolean } = {},
  ) {}

  transform(value: unknown): z.output<T> {
    const parsed = this.schema.safeParse(value ?? {});
    if (parsed.success) return parsed.data;
    if (this.options.notFound) throw new NotFoundException({ code: 'NOT_FOUND' });
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
    });
  }
}
