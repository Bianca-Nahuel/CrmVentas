/**
 * JSON para meter dentro de una sección delimitada del prompt (<conversacion>, <negocio>, resultados de
 * herramientas). Escapa < y > para que un texto no confiable no pueda cerrar ni abrir etiquetas.
 */
export function jsonForPrompt(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}
