// Minimal test cookie jar: applies Set-Cookie headers from server commands
// and renders a Cookie request header, the way a browser would for one
// origin. Values are opaque and never logged.

export class CookieJar {
  readonly #cookies = new Map<string, string>();

  apply(setCookies: readonly string[]): this {
    for (const header of setCookies) {
      const [pair, ...attributes] = header.split(";");
      const index = pair.indexOf("=");
      if (index < 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired =
        value === "" ||
        attributes.some((a) => /^\s*max-age=0\s*$/i.test(a)) ||
        attributes.some((a) => /^\s*expires=thu, 01 jan 1970/i.test(a));
      if (expired) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    return this;
  }

  has(name: string): boolean {
    return this.#cookies.has(name);
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  set(name: string, value: string): this {
    this.#cookies.set(name, value);
    return this;
  }

  header(): string | null {
    if (this.#cookies.size === 0) return null;
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  clone(): CookieJar {
    const copy = new CookieJar();
    for (const [k, v] of this.#cookies) copy.set(k, v);
    return copy;
  }
}
