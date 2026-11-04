import "server-only";
import { getServerEnv } from "@/config/server-env";
import type {
  DocumentStorage,
  MalwareScanner,
  ScanVerdict,
} from "../application/ports";
import { LocalDocumentStorage } from "./local-document-storage";

// Provider selection. The test scanner and local storage exist only under
// PROVIDER_MODE=fake, which the environment schema refuses in production. No
// production provider is approved yet, so any other mode fails closed: nothing
// can be stored or marked clean.

/** The standard EICAR test string, split so this file doesn't trip a scanner. */
const EICAR = [
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}",
  "$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
].join("");

/** NON-PRODUCTION: flags only the EICAR test string; it inspects nothing else. */
export class TestMalwareScanner implements MalwareScanner {
  readonly scannerCode = "TEST_SCANNER";
  async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    return Buffer.from(bytes).includes(EICAR) ? "MALICIOUS" : "CLEAN";
  }
}

class UnavailableStorage implements DocumentStorage {
  readonly providerCode = "UNAVAILABLE";
  #refuse(): never {
    throw new Error("document storage is not configured");
  }
  putQuarantine = async () => this.#refuse();
  readQuarantine = async () => this.#refuse();
  promote = async () => this.#refuse();
  readApproved = async () => this.#refuse();
  discardQuarantine = async () => {};
}

class UnavailableScanner implements MalwareScanner {
  readonly scannerCode = "UNAVAILABLE";
  async scan(): Promise<ScanVerdict> {
    throw new Error("malware scanning is not configured");
  }
}

export function documentProvidersFor(
  env: Readonly<{ PROVIDER_MODE: string; DOCUMENT_STORAGE_ROOT: string }>,
): Readonly<{ storage: DocumentStorage; scanner: MalwareScanner }> {
  return env.PROVIDER_MODE === "fake"
    ? {
        storage: new LocalDocumentStorage(env.DOCUMENT_STORAGE_ROOT),
        scanner: new TestMalwareScanner(),
      }
    : { storage: new UnavailableStorage(), scanner: new UnavailableScanner() };
}

export const documentProviders = () => documentProvidersFor(getServerEnv());
