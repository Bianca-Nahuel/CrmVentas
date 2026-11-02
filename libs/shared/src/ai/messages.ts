// Mensajes de validación en lenguaje de negocio (tarea 027), los mismos en la API y en el panel: los errores
// de la configuración se muestran en cada campo y la persona que los lee no es técnica. Los mensajes propios
// de los schemas (los que ya traen texto) no se tocan.
import { z } from 'zod';

const fieldWord = (origin: unknown) => (origin === 'array' || origin === 'set' ? 'elementos' : 'caracteres');

export function useBusinessMessages(): void {
  z.config({
    customError: (issue) => {
      switch (issue.code) {
        case 'too_small':
          if (issue.origin === 'string' && Number(issue.minimum) <= 1) return 'Completá este campo.';
          if (issue.origin === 'number' || issue.origin === 'int') {
            return issue.inclusive
              ? `Tiene que ser ${String(issue.minimum)} o más.`
              : `Tiene que ser mayor que ${String(issue.minimum)}.`;
          }
          return `Tiene que tener al menos ${String(issue.minimum)} ${fieldWord(issue.origin)}.`;
        case 'too_big':
          if (issue.origin === 'number' || issue.origin === 'int') {
            return `Tiene que ser ${String(issue.maximum)} o menos.`;
          }
          return `Como mucho ${String(issue.maximum)} ${fieldWord(issue.origin)}.`;
        case 'invalid_format':
          if (issue.format === 'email') return 'Escribí un email válido (nombre@empresa.com).';
          if (issue.format === 'url') return 'Escribí una dirección web completa (https://…).';
          return undefined;
        case 'invalid_type':
          return issue.input === undefined || issue.input === null
            ? 'Completá este campo.'
            : 'Valor no válido.';
        case 'unrecognized_keys':
          return 'Hay datos que no corresponden en esta sección.';
        default:
          return undefined;
      }
    },
  });
}
