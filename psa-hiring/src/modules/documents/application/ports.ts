// Document provider ports (ARCHITECTURE §4; packet M2.5). Keys are generated
// server-side UUIDs, never a filename. A later provider replaces an adapter
// without touching commands.

export interface DocumentStorage {
  readonly providerCode: string;
  /** Stores new bytes where nothing can download them. */
  putQuarantine(key: string, bytes: Uint8Array): Promise<void>;
  readQuarantine(key: string): Promise<Uint8Array>;
  /** Moves a checked file to private storage; safe to repeat. */
  promote(key: string): Promise<void>;
  readApproved(key: string): Promise<Uint8Array>;
  /** Discards quarantined bytes that never became a kept document. */
  discardQuarantine(key: string): Promise<void>;
}

export type ScanVerdict = "CLEAN" | "MALICIOUS";

export interface MalwareScanner {
  readonly scannerCode: string;
  /** Throws when the scanner can't give a verdict. */
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}
