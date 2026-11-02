// jsdom ships no types; only the constructor and the window are used (sanitize.ts).
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string);
    readonly window: Window & typeof globalThis;
  }
}
