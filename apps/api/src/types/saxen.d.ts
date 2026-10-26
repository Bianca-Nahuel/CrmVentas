// Tipos mínimos de saxen 11 (el paquete no los trae): solo lo que usa el lector de .xlsx.
declare module 'saxen' {
  type Decode = (text: string) => string;
  export class Parser {
    constructor(options?: { proxy?: boolean });
    on(
      event: 'openTag',
      handler: (
        name: string,
        attrs: () => Record<string, string>,
        decode: Decode,
        selfClosing: boolean,
      ) => void,
    ): this;
    on(event: 'closeTag', handler: (name: string, decode: Decode, selfClosing: boolean) => void): this;
    on(event: 'text', handler: (value: string, decode: Decode) => void): this;
    on(event: 'cdata', handler: (value: string) => void): this;
    on(event: 'error', handler: (error: Error) => void): this;
    parse(xml: string): this;
  }
}
