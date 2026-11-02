// Punto de entrada del panel para la configuración del agente y del catálogo (@ventas/shared/ai): los
// schemas zod, los modelos y el puntaje. Lo importan solo las secciones lazy (/agente y /catalogo), así zod
// no entra en el bundle inicial.
export * from './catalog-config.js';
export * from './messages.js';
export * from './models.js';
export * from './score.js';
export * from './tenant-config.js';
export * from './text.js';
