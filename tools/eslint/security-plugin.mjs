// Reglas de seguridad propias para el panel (apps/web). Los mensajes de WhatsApp y todo lo que llega del
// servidor es contenido no confiable: nunca se inserta como HTML.

/** Plantillas de Angular: prohíbe [innerHTML], [outerHTML] y sus variantes (bind-, attr.). */
const noInnerHtmlBinding = {
  meta: {
    type: 'problem',
    docs: { description: 'Prohíbe insertar HTML desde una plantilla ([innerHTML]/[outerHTML]).' },
    messages: {
      forbidden:
        'No uses [{{name}}]: el contenido del servidor no es confiable. Mostralo como texto con {{ "{{ }}" }}.',
    },
    schema: [],
  },
  create(context) {
    const check = (node) => {
      const name = String(node.name ?? '').replace(/^attr\./i, '');
      if (/^(inner|outer)html$/i.test(name)) context.report({ node, messageId: 'forbidden', data: { name } });
    };
    return { BoundAttribute: check, TextAttribute: check };
  },
};

export const securityPlugin = { rules: { 'no-inner-html-binding': noInnerHtmlBinding } };

/** TypeScript: prohíbe bypassSecurityTrust*, asignar innerHTML/outerHTML y similares. */
export const forbiddenDomSyntax = [
  {
    selector: 'MemberExpression[property.name=/^bypassSecurityTrust/]',
    message: 'Prohibido bypassSecurityTrust*: saltea la sanitización de Angular.',
  },
  {
    selector: 'AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]',
    message: 'Prohibido asignar innerHTML/outerHTML: el contenido del servidor no es confiable.',
  },
  {
    selector: 'CallExpression[callee.property.name="insertAdjacentHTML"]',
    message: 'Prohibido insertAdjacentHTML: el contenido del servidor no es confiable.',
  },
  {
    selector:
      'CallExpression[callee.property.name="setProperty"][arguments.1.value=/^(innerHTML|outerHTML)$/]',
    message: 'Prohibido Renderer2.setProperty con innerHTML/outerHTML.',
  },
  {
    selector: 'CallExpression[callee.object.name="document"][callee.property.name=/^write(ln)?$/]',
    message: 'Prohibido document.write.',
  },
  // Las mismas propiedades con corchetes (el['innerHTML'], s['bypassSecurityTrustHtml']).
  {
    selector:
      'MemberExpression[computed=true][property.value=/^(innerHTML|outerHTML|bypassSecurityTrust.*)$/]',
    message: 'Prohibido acceder a innerHTML/outerHTML/bypassSecurityTrust* con corchetes.',
  },
  // Object.assign(el, { innerHTML }) y similares.
  {
    selector: 'Property[key.name=/^(innerHTML|outerHTML)$/], Property[key.value=/^(innerHTML|outerHTML)$/]',
    message: 'Prohibido pasar innerHTML/outerHTML en un objeto.',
  },
  // Bindings del elemento anfitrión: host: { '[innerHTML]': … } y @HostBinding('innerHTML').
  {
    selector: 'Property[key.value=/^\\[(attr\\.)?(innerHTML|outerHTML)\\]$/i]',
    message: 'Prohibido [innerHTML]/[outerHTML] en el host de un componente.',
  },
  {
    selector:
      'Decorator[expression.callee.name="HostBinding"][expression.arguments.0.value=/^(attr\\.)?(innerHTML|outerHTML)$/i]',
    message: 'Prohibido @HostBinding con innerHTML/outerHTML.',
  },
  {
    selector: 'CallExpression[callee.property.name="createContextualFragment"]',
    message: 'Prohibido createContextualFragment: interpreta HTML.',
  },
];
