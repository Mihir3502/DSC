import "server-only";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentStorage } from "../application/ports";

// Private local directory for development and tests. NON-PRODUCTION: it is
// selected only when PROVIDER_MODE=fake, which the environment schema refuses
// in production. Files live outside the public web root, are owner-only, and
// are named only by a generated UUID, so no client value reaches a path.

const keyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class LocalDocumentStorage implements DocumentStorage {
  readonly providerCode = "LOCAL_PRIVATE";
  constructor(private readonly root: string) {}

  #path(area: "quarantine" | "approved", key: string) {
    if (!keyPattern.test(key)) throw new Error("invalid storage key");
    return path.join(this.root, area, key);
  }

  async putQuarantine(key: string, bytes: Uint8Array) {
    await mkdir(path.join(this.root, "quarantine"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(this.#path("quarantine", key), bytes, {
      flag: "wx",
      mode: 0o600,
    });
  }

  readQuarantine(key: string) {
    return readFile(this.#path("quarantine", key));
  }

  async promote(key: string) {
    await mkdir(path.join(this.root, "approved"), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await rename(this.#path("quarantine", key), this.#path("approved", key));
    } catch (error) {
      // A retry after a crash finds the file already moved.
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      await readFile(this.#path("approved", key));
    }
  }

  readApproved(key: string) {
    return readFile(this.#path("approved", key));
  }

  async discardQuarantine(key: string) {
    await rm(this.#path("quarantine", key), { force: true });
  }
}
