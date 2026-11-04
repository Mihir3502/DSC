import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createAuditRecorder } from "@/modules/audit";
import { startOwnCandidacy } from "@/modules/candidates/application/candidate-commands";
import type { CandidateActor } from "@/modules/candidates/application/candidate-runtime";
import {
  removeApplicationAttachment,
  scanVersion,
  uploadApplicationAttachment,
  type DocumentDependencies,
} from "@/modules/documents/application/attachment-commands";
import {
  openApplicationAttachment,
  queryApplicationAttachments,
} from "@/modules/documents/application/attachment-queries";
import type { MalwareScanner } from "@/modules/documents/application/ports";
import {
  documentProvidersFor,
  TestMalwareScanner,
} from "@/modules/documents/infrastructure/document-providers";
import { LocalDocumentStorage } from "@/modules/documents/infrastructure/local-document-storage";
import {
  candidateRateLimits,
  FixedWindowRateLimiter,
} from "@/modules/identity-access/infrastructure/action-rate-limiter";
import {
  createHiringCycle,
  transitionHiringCycle,
} from "@/modules/organization/application/commands/hiring-cycle-commands";
import { toZonedLocal } from "@/modules/organization/domain/zoned-time";
import { closeDatabasePool, getDatabase } from "@/shared/database";
import { createLogger } from "@/shared/logging";
import { createMemoryDestination } from "../../fixtures/canaries";
import { connect, failingKeys, verify } from "../support/audit";
import {
  activateStaff,
  createBootstrapPair,
  grant,
  headers,
  prepareAuthorizationDatabase,
  signIn,
  type AuthorizationHarness,
  type BootstrapPair,
  type StaffSession,
} from "../support/authorization";
import { waitForLockWait } from "../support/barriers";
import {
  candidateDeps,
  candidateSession,
  ckey,
  handoffFor,
  outcome,
  type CandidateSession,
} from "../support/candidates";
import { dropOwnedDatabase, type OwnedDatabase } from "../support/harness";
import {
  bootstrapActor,
  configDeps,
  createOrganizationHarness,
  done,
  key,
  provisionHierarchy,
  provisionPosition,
  reason,
  type Hierarchy,
} from "../support/organization";

// M2.5 application attachments (packet M2.5 §14–§17; AC-M2.5-01..05, X1, X2).
// Real accounts, sessions, PostgreSQL, and a private temporary directory; the
// only stand-ins are the explicit test scanners. Every file is synthetic, and
// the malware sample is the harmless standard EICAR test string.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let deps: DocumentDependencies;
let pair: BootstrapPair;
let tree: Hierarchy;
let positionId: string;
let root: string;
const staff: Record<string, StaffSession> = {};

const NAME_CANARY = "TEST-FILE-NAME-CANARY-9K3.pdf";
const pdf = (text = "TEST document") =>
  new TextEncoder().encode(`%PDF-1.7\n${text}\n`);
const EICAR = [
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}",
  "$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
].join("");
const local = (d: Date) => toZonedLocal(d, "America/New_York");

async function openCycle(branchId: string) {
  const cdeps = configDeps(h);
  const actor = bootstrapActor(pair.creator);
  const cycle = done(
    await createHiringCycle(
      {
        commandKey: key(),
        positionId,
        branchId,
        code: `C-${randomUUID().slice(0, 8)}`.toUpperCase(),
        internalLabel: "TEST internal cycle",
        opensAt: local(new Date(Date.now() - 3_600_000)),
        closesAt: local(new Date(Date.now() + 7 * 86_400_000)),
      },
      actor,
      cdeps,
    ),
  );
  const published = done(
    await transitionHiringCycle(
      "publish",
      {
        commandKey: key(),
        targetId: cycle.id,
        expectedVersion: String(cycle.version),
        reasonCode: reason,
      },
      actor,
      cdeps,
    ),
  );
  done(
    await transitionHiringCycle(
      "open",
      {
        commandKey: key(),
        targetId: cycle.id,
        expectedVersion: String(published.version),
        reasonCode: reason,
      },
      actor,
      cdeps,
    ),
  );
  const { rows } = await admin.query<{ public_reference: string }>(
    "SELECT public_reference FROM app.hiring_cycle WHERE id = $1",
    [cycle.id],
  );
  return rows[0]!.public_reference;
}

type Started = Readonly<{
  candidate: CandidateSession;
  candidacyId: string;
  internalId: string;
}>;

async function started(): Promise<Started> {
  const ref = await openCycle(tree.branch);
  const candidate = await candidateSession(h);
  const result = await startOwnCandidacy(
    {
      commandKey: ckey(),
      handoffToken: handoffFor(h, ref),
      legalFirstName: "TEST Ana",
      legalLastName: "TEST Ríos",
    },
    candidate.actor,
    deps,
  );
  if (result.kind !== "DONE") throw new Error("start failed");
  const { rows } = await admin.query<{ public_id: string }>(
    "SELECT public_id FROM app.candidacy WHERE id = $1",
    [result.targetId],
  );
  return {
    candidate,
    candidacyId: rows[0]!.public_id,
    internalId: result.targetId,
  };
}

const upload = (
  s: Started,
  over: Partial<Parameters<typeof uploadApplicationAttachment>[0]> = {},
  useDeps: DocumentDependencies = deps,
  actor: CandidateActor = s.candidate.actor,
) =>
  uploadApplicationAttachment(
    {
      commandKey: ckey(),
      candidacyId: s.candidacyId,
      category: "RESUME",
      fileName: NAME_CANARY,
      declaredType: "application/pdf",
      bytes: pdf(),
      ...over,
    },
    actor,
    useDeps,
  );

const list = async (s: Started, useDeps: DocumentDependencies = deps) => {
  const result = await queryApplicationAttachments(
    headers(s.candidate.jar),
    s.candidacyId,
    useDeps,
  );
  if (result.kind !== "OK") throw new Error("no list");
  return result.view.attachments;
};

const download = (s: Started, documentId: string, useDeps = deps) =>
  openApplicationAttachment(
    headers(s.candidate.jar),
    s.candidacyId,
    documentId,
    undefined,
    useDeps,
  );

const versionsOf = (candidacy: string) =>
  admin
    .query(
      `SELECT v.version_number, v.scan_status, v.scanner_code, d.current_version_id = v.id AS current
         FROM app.document_version v JOIN app.document d ON d.id = v.document_id
        WHERE d.candidacy_id = $1 ORDER BY v.version_number`,
      [candidacy],
    )
    .then((r) => r.rows);

const stored = (area: "quarantine" | "approved") => {
  const dir = path.join(root, area);
  return existsSync(dir) ? readdirSync(dir).length : 0;
};

const eventsOn = async (candidacy: string) => {
  const { rows } = await admin.query<{ event_name: string }>(
    `SELECT event_name FROM audit.audit_event
      WHERE target_id = $1 OR target_id IN (SELECT id FROM app.document WHERE candidacy_id = $1)
      ORDER BY chain_sequence`,
    [candidacy],
  );
  return rows.map((r) => r.event_name);
};

const withScanner = (scanner: MalwareScanner): DocumentDependencies => ({
  ...deps,
  scanner,
});

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "documents",
  ));
  h = createOrganizationHarness();
  root = mkdtempSync(path.join(tmpdir(), "psa-documents-"));
  deps = {
    ...candidateDeps(h),
    storage: new LocalDocumentStorage(root),
    scanner: new TestMalwareScanner(),
  };
  pair = await createBootstrapPair(admin);
  tree = await provisionHierarchy(configDeps(h), pair.creator, "DOC");
  ({ position: positionId } = await provisionPosition(
    configDeps(h),
    pair.creator,
    tree.org,
    "DOC-POS",
  ));
  const accounts = {
    manager: await activateStaff(h, "doc-manager"),
    hr: await activateStaff(h, "doc-hr"),
    administrator: await activateStaff(h, "doc-admin"),
  };
  await grant(
    h,
    pair,
    accounts.manager.accountId,
    "PSA_MANAGER",
    "ORGANIZATION",
    tree.org,
  );
  await grant(
    h,
    pair,
    accounts.hr.accountId,
    "HR_SPECIALIST",
    "ORGANIZATION",
    tree.org,
  );
  await grant(
    h,
    pair,
    accounts.administrator.accountId,
    "SYSTEM_ADMINISTRATOR",
    "ORGANIZATION",
    tree.org,
  );
  for (const [name, member] of Object.entries(accounts))
    staff[name] = await signIn(h, member);
}, 600_000);

afterAll(async () => {
  await admin?.end();
  await closeDatabasePool();
  restoreEnv?.();
  if (db) await dropOwnedDatabase(ctx, db.name);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("upload and scan (AC-M2.5-01/02/03)", () => {
  it("quarantines, scans, and promotes a clean file, with audit that holds no file name", async () => {
    const s = await started();
    const before = stored("approved");
    expect(await upload(s)).toEqual({ kind: "RECEIVED", status: "CLEAN" });
    expect(stored("approved")).toBe(before + 1);
    expect(await versionsOf(s.internalId)).toEqual([
      {
        version_number: 1,
        scan_status: "CLEAN",
        scanner_code: "TEST_SCANNER",
        current: true,
      },
    ]);
    expect(await eventsOn(s.internalId)).toEqual(
      expect.arrayContaining(["document.received", "document.scanned"]),
    );
    const audit = await admin.query(
      `SELECT row_to_json(e)::text AS row FROM audit.audit_event e
        WHERE e.event_name LIKE 'document.%'`,
    );
    expect(audit.rows.map((r) => r.row).join("")).not.toContain(NAME_CANARY);
    const [file] = await list(s);
    expect(file).toMatchObject({
      name: NAME_CANARY,
      category: "Resume",
      status: "Ready",
      downloadable: true,
      problem: null,
    });
    expect(Object.keys(file!).sort()).toEqual([
      "category",
      "documentId",
      "downloadable",
      "name",
      "problem",
      "size",
      "status",
      "version",
    ]);
    const { rows } = await admin.query<{
      storage_object_key: string;
      content_hash: string;
    }>(
      `SELECT v.storage_object_key, v.content_hash FROM app.document_version v
         JOIN app.document d ON d.id = v.document_id WHERE d.candidacy_id = $1`,
      [s.internalId],
    );
    const text = JSON.stringify(file);
    expect(text).not.toContain(rows[0]!.storage_object_key);
    expect(text).not.toContain(rows[0]!.content_hash);
    // The name never becomes a path: only generated keys exist on disk.
    expect(readdirSync(path.join(root, "approved")).join("")).not.toContain(
      "CANARY",
    );
  });

  it("uses only a generated storage key for a hostile file name", async () => {
    const s = await started();
    expect(
      await upload(s, { fileName: "../../../../etc/passwd‮.pdf" }),
    ).toMatchObject({ status: "CLEAN" });
    const [file] = await list(s);
    expect(file!.name).toBe("passwd.pdf");
    expect(existsSync(path.join(root, "..", "passwd.pdf"))).toBe(false);
  });

  it("rejects a disallowed or disguised file with audit, no record, and no stored bytes", async () => {
    const s = await started();
    const before = [stored("quarantine"), stored("approved")];
    for (const [over, reason] of [
      [{ fileName: "macro.docx" }, "TYPE_NOT_ALLOWED"],
      [{ fileName: "run.exe" }, "TYPE_NOT_ALLOWED"],
      [
        { bytes: new TextEncoder().encode("MZ executable") },
        "CONTENT_MISMATCH",
      ],
      [{ bytes: new Uint8Array() }, "EMPTY"],
      [{ bytes: new Uint8Array(10 * 1024 * 1024 + 1) }, "TOO_LARGE"],
    ] as const) {
      expect(await upload(s, over)).toEqual({ kind: "INVALID_FILE", reason });
    }
    expect(await list(s)).toEqual([]);
    expect([stored("quarantine"), stored("approved")]).toEqual(before);
    expect(
      (await eventsOn(s.internalId)).filter(
        (e) => e === "document.upload_rejected",
      ),
    ).toHaveLength(5);
  });

  it("rejects malware, discards its bytes, and never offers it for download", async () => {
    const s = await started();
    const before = [stored("quarantine"), stored("approved")];
    expect(
      await upload(s, {
        bytes: new TextEncoder().encode(`%PDF-1.7\n${EICAR}`),
      }),
    ).toEqual({ kind: "RECEIVED", status: "REJECTED" });
    expect([stored("quarantine"), stored("approved")]).toEqual(before);
    const [file] = await list(s);
    expect(file).toMatchObject({
      status: "Not accepted",
      problem: "NOT_ACCEPTED",
      downloadable: false,
    });
    expect(await download(s, file!.documentId)).toEqual({
      kind: "UNAVAILABLE",
    });
  });

  it("fails closed when the scanner is unavailable, keeps the file in quarantine, and finishes only once", async () => {
    const s = await started();
    const broken = withScanner({
      scannerCode: "TEST_BROKEN",
      scan: async () => {
        throw new Error("scanner offline");
      },
    });
    expect(await upload(s, {}, broken)).toEqual({
      kind: "RECEIVED",
      status: "FAILED",
    });
    const [file] = await list(s);
    expect(file).toMatchObject({ problem: "NOT_CHECKED", downloadable: false });
    expect(await download(s, file!.documentId)).toEqual({
      kind: "UNAVAILABLE",
    });
    const { rows } = await admin.query<{ id: string }>(
      `SELECT v.id FROM app.document_version v JOIN app.document d ON d.id = v.document_id
        WHERE d.candidacy_id = $1`,
      [s.internalId],
    );
    // A finished version doesn't change, even with a working scanner.
    expect(await scanVersion(rows[0]!.id, deps)).toBe("FAILED");
  });

  it("refuses safely when storage or the production provider is unavailable", async () => {
    const s = await started();
    const { storage, scanner } = documentProvidersFor({
      PROVIDER_MODE: "production",
      DOCUMENT_STORAGE_ROOT: root,
    });
    expect(storage.providerCode).toBe("UNAVAILABLE");
    await expect(scanner.scan(pdf())).rejects.toThrow();
    expect(await upload(s, {}, { ...deps, storage, scanner })).toEqual({
      kind: "REFUSED",
      reason: "UNAVAILABLE",
    });
    expect(await list(s)).toEqual([]);
    expect(
      documentProvidersFor({
        PROVIDER_MODE: "fake",
        DOCUMENT_STORAGE_ROOT: root,
      }).scanner.scannerCode,
    ).toBe("TEST_SCANNER");
  });
});

describe("versions (AC-M2.5-01)", () => {
  it("keeps the current file until a replacement is clean, and preserves every version", async () => {
    const s = await started();
    await upload(s, { bytes: pdf("TEST version one") });
    const [first] = await list(s);
    const id = first!.documentId;

    // A rejected replacement leaves the earlier file in place.
    expect(
      await upload(s, {
        documentId: id,
        bytes: new TextEncoder().encode(`%PDF-1.7\n${EICAR}`),
      }),
    ).toMatchObject({ status: "REJECTED" });
    const afterBad = await download(s, id);
    if (afterBad.kind !== "OK") throw new Error("earlier file lost");
    expect(new TextDecoder().decode(afterBad.bytes)).toContain("version one");
    expect((await list(s))[0]).toMatchObject({
      problem: "NOT_ACCEPTED",
      downloadable: true,
    });

    // A clean replacement becomes current, and history remains.
    expect(
      await upload(s, { documentId: id, bytes: pdf("TEST version three") }),
    ).toMatchObject({ status: "CLEAN" });
    const afterGood = await download(s, id);
    if (afterGood.kind !== "OK") throw new Error("no file");
    expect(new TextDecoder().decode(afterGood.bytes)).toContain(
      "version three",
    );
    expect((await versionsOf(s.internalId)).map((v) => v.scan_status)).toEqual([
      "CLEAN",
      "REJECTED",
      "CLEAN",
    ]);
    expect(await list(s)).toHaveLength(1);
  });

  it("removes a file from the application with a stale check, keeping its history", async () => {
    const s = await started();
    await upload(s);
    const [file] = await list(s);
    const remove = (expectedVersion: string, commandKey = ckey()) =>
      removeApplicationAttachment(
        {
          commandKey,
          candidacyId: s.candidacyId,
          documentId: file!.documentId,
          expectedVersion,
        },
        s.candidate.actor,
        deps,
      );
    expect(outcome((await remove("99")) as never)).toBe("STALE_VERSION");
    const k = ckey();
    expect(outcome((await remove(String(file!.version), k)) as never)).toBe(
      "REMOVED",
    );
    expect(await remove(String(file!.version), k)).toMatchObject({
      replayed: true,
    });
    expect(await list(s)).toEqual([]);
    expect(await download(s, file!.documentId)).toEqual({ kind: "NOT_FOUND" });
    expect(await versionsOf(s.internalId)).toHaveLength(1);
    expect(await eventsOn(s.internalId)).toContain("document.removed");
    expect(outcome((await remove(String(file!.version + 1))) as never)).toBe(
      "NOT_FOUND",
    );
  });
});

describe("idempotency and limits (AC-M2.5-X2)", () => {
  it("replays the same key once, rejects it with a different file, and leaves no orphan bytes", async () => {
    const s = await started();
    const k = ckey();
    expect(await upload(s, { commandKey: k })).toMatchObject({
      status: "CLEAN",
    });
    const before = [stored("quarantine"), stored("approved")];
    expect(await upload(s, { commandKey: k })).toEqual({
      kind: "RECEIVED",
      status: "CLEAN",
    });
    expect(
      await upload(s, { commandKey: k, bytes: pdf("TEST different") }),
    ).toEqual({
      kind: "REFUSED",
      reason: "COMMAND_KEY_CONFLICT",
    });
    expect([stored("quarantine"), stored("approved")]).toEqual(before);
    expect(await versionsOf(s.internalId)).toHaveLength(1);
  });

  it("enforces the attachment limit under concurrency", async () => {
    const s = await started();
    for (let n = 0; n < 9; n += 1) {
      expect(await upload(s, { bytes: pdf(`TEST ${n}`) })).toMatchObject({
        status: "CLEAN",
      });
    }
    await admin.query("BEGIN");
    await admin.query("SELECT 1 FROM app.candidacy WHERE id = $1 FOR UPDATE", [
      s.internalId,
    ]);
    const race = [
      upload(s, { bytes: pdf("TEST racer one") }),
      upload(s, { bytes: pdf("TEST racer two") }),
    ];
    const observer = await connect(db.urls.admin);
    try {
      await waitForLockWait(observer, 2);
    } finally {
      await observer.end();
    }
    await admin.query("COMMIT");
    const results = await Promise.all(race);
    expect(results.map((r) => r.kind).sort()).toEqual(["RECEIVED", "REFUSED"]);
    expect(results).toContainEqual({
      kind: "REFUSED",
      reason: "LIMIT_REACHED",
    });
    expect(await list(s)).toHaveLength(10);
    // Replacing still works at the limit.
    const [first] = await list(s);
    expect(
      await upload(s, {
        documentId: first!.documentId,
        bytes: pdf("TEST swap"),
      }),
    ).toMatchObject({ status: "CLEAN" });
  });

  it("limits uploads per account before storing anything", async () => {
    const s = await started();
    const limiter = new FixedWindowRateLimiter();
    for (
      let n = 0;
      n < candidateRateLimits.documentUploadPerAccount.limit;
      n += 1
    ) {
      limiter.consume("documentUploadPerAccount", s.candidate.accountId);
    }
    const before = stored("quarantine");
    expect(await upload(s, {}, { ...deps, limiter })).toEqual({
      kind: "REFUSED",
      reason: "RATE_LIMITED",
    });
    expect(stored("quarantine")).toBe(before);
  });

  it("rolls back the receipt and discards the bytes when the audit append fails", async () => {
    const s = await started();
    const failing: DocumentDependencies = {
      ...deps,
      events: createAuditRecorder({
        db: getDatabase(),
        logger: createLogger({ destination: createMemoryDestination() }),
        keys: failingKeys(),
      }),
    };
    const before = stored("quarantine");
    await expect(upload(s, {}, failing)).rejects.toThrow();
    expect(await list(s)).toEqual([]);
    expect(stored("quarantine")).toBe(before);
  });
});

describe("download and audit (AC-M2.5-04/05)", () => {
  it("returns the owner's exact bytes, safe type, and one audit event per download", async () => {
    const s = await started();
    const bytes = pdf("TEST exact bytes");
    await upload(s, { bytes });
    const [file] = await list(s);
    const result = await download(s, file!.documentId);
    if (result.kind !== "OK") throw new Error("no file");
    expect(Buffer.from(result.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(result.mediaType).toBe("application/pdf");
    await download(s, file!.documentId);
    expect(
      (await eventsOn(s.internalId)).filter((e) => e === "document.downloaded"),
    ).toHaveLength(2);
  });

  it("sends no bytes when the download's audit event can't be recorded", async () => {
    const s = await started();
    await upload(s);
    const [file] = await list(s);
    const failing: DocumentDependencies = {
      ...deps,
      events: createAuditRecorder({
        db: getDatabase(),
        logger: createLogger({ destination: createMemoryDestination() }),
        keys: failingKeys(),
      }),
    };
    await expect(download(s, file!.documentId, failing)).rejects.toThrow();
  });

  it("limits downloads per account", async () => {
    const s = await started();
    await upload(s);
    const [file] = await list(s);
    const limiter = new FixedWindowRateLimiter();
    for (
      let n = 0;
      n < candidateRateLimits.documentDownloadPerAccount.limit;
      n += 1
    ) {
      limiter.consume("documentDownloadPerAccount", s.candidate.accountId);
    }
    expect(await download(s, file!.documentId, { ...deps, limiter })).toEqual({
      kind: "RATE_LIMITED",
    });
  });
});

describe("authorization and nondisclosure (AC-M2.5-X1)", () => {
  it("gives another candidate and an unknown reference the same result, with no read or write", async () => {
    const owner = await started();
    await upload(owner);
    const [file] = await list(owner);
    const other = await started();
    const session = headers(other.candidate.jar);
    const events = await eventsOn(owner.internalId);
    for (const candidacy of [owner.candidacyId, "abcdefghjkmn"]) {
      expect(
        await queryApplicationAttachments(session, candidacy, deps),
      ).toEqual({ kind: "NOT_FOUND" });
      expect(
        await openApplicationAttachment(
          session,
          candidacy,
          file!.documentId,
          undefined,
          deps,
        ),
      ).toEqual({ kind: "NOT_FOUND" });
    }
    // Their own candidacy with the owner's document ID still finds nothing.
    expect(
      await openApplicationAttachment(
        session,
        other.candidacyId,
        file!.documentId,
        undefined,
        deps,
      ),
    ).toEqual({ kind: "NOT_FOUND" });
    expect(await eventsOn(owner.internalId)).toEqual(events);
    expect(await upload(owner, {}, deps, other.candidate.actor)).toMatchObject({
      kind: "REFUSED",
    });
    expect(await versionsOf(owner.internalId)).toHaveLength(1);
    // Replacing someone else's document from your own candidacy finds nothing.
    expect(await upload(other, { documentId: file!.documentId })).toEqual({
      kind: "REFUSED",
      reason: "NOT_FOUND",
    });
    expect(
      await queryApplicationAttachments(headers(), owner.candidacyId, deps),
    ).toEqual({ kind: "UNAUTHENTICATED" });
    expect(
      await openApplicationAttachment(
        headers(),
        owner.candidacyId,
        file!.documentId,
        undefined,
        deps,
      ),
    ).toEqual({ kind: "UNAUTHENTICATED" });
  });

  it("denies every staff role upload, removal, listing, and download", async () => {
    const s = await started();
    await upload(s);
    const [file] = await list(s);
    for (const name of ["manager", "hr", "administrator"]) {
      const actor: CandidateActor = {
        kind: "STAFF",
        principal: staff[name]!.principal,
      };
      expect(await upload(s, {}, deps, actor), name).toEqual({
        kind: "REFUSED",
        reason: "NOT_AUTHORIZED",
      });
      expect(
        await removeApplicationAttachment(
          {
            commandKey: ckey(),
            candidacyId: s.candidacyId,
            documentId: file!.documentId,
            expectedVersion: String(file!.version),
          },
          actor,
          deps,
        ),
        name,
      ).toEqual({ kind: "REFUSED", reason: "NOT_AUTHORIZED" });
      const session = headers(staff[name]!.jar);
      expect(
        await queryApplicationAttachments(session, s.candidacyId, deps),
        name,
      ).toEqual({ kind: "UNAUTHENTICATED" });
      expect(
        await openApplicationAttachment(
          session,
          s.candidacyId,
          file!.documentId,
          undefined,
          deps,
        ),
        name,
      ).toEqual({ kind: "UNAUTHENTICATED" });
    }
    expect(await versionsOf(s.internalId)).toHaveLength(1);
  });

  it("refuses edits once a candidacy closes, while the candidate can still download", async () => {
    const s = await started();
    await upload(s);
    const [file] = await list(s);
    await admin.query(
      "UPDATE app.candidacy SET status = 'TERMINAL', candidate_visible_status = 'CLOSED', closed_at = now(), closure_reason_code = 'NO_LONGER_INTERESTED', version = version + 1 WHERE id = $1",
      [s.internalId],
    );
    const refused = await upload(s);
    expect(refused).toMatchObject({ kind: "REFUSED" });
    const result = await queryApplicationAttachments(
      headers(s.candidate.jar),
      s.candidacyId,
      deps,
    );
    expect(result).toMatchObject({ kind: "OK", view: { editable: false } });
    expect((await download(s, file!.documentId)).kind).toBe("OK");
  });

  it("rejects malformed references, categories, and keys with no stored bytes", async () => {
    const s = await started();
    const before = stored("quarantine");
    for (const [over, expected] of [
      [{ category: "IDENTITY" }, "INVALID_INPUT"],
      [{ category: "__proto__" }, "INVALID_INPUT"],
      [{ documentId: "../../etc" }, "INVALID_INPUT"],
      [{ candidacyId: "' OR 1=1 --" }, "NOT_FOUND"],
      [{ commandKey: "not-a-key" }, "INVALID_INPUT"],
    ] as const) {
      expect(await upload(s, over), JSON.stringify(over)).toEqual({
        kind: "REFUSED",
        reason: expected,
      });
    }
    expect(stored("quarantine")).toBe(before);
  });
});

describe("database integrity (AC-M2.5-X2)", () => {
  const sqlstate = async (sql: string, params: unknown[] = []) => {
    const runtime = await connect(db.urls.app);
    try {
      await runtime.query(sql, params);
      return "ok";
    } catch (error) {
      return String((error as { code?: string }).code);
    } finally {
      await runtime.end();
    }
  };

  it("refuses deletes, evidence edits, reversed scans, and a current version that isn't clean", async () => {
    const s = await started();
    await upload(s);
    const bad = await started();
    await upload(bad, {
      bytes: new TextEncoder().encode(`%PDF-1.7\n${EICAR}`),
    });
    const { rows } = await admin.query<{ id: string; document_id: string }>(
      `SELECT v.id, v.document_id FROM app.document_version v JOIN app.document d ON d.id = v.document_id
        WHERE d.candidacy_id = $1`,
      [bad.internalId],
    );
    const version = rows[0]!;
    expect(await sqlstate("DELETE FROM app.document")).toBe("42501");
    expect(await sqlstate("DELETE FROM app.document_version")).toBe("42501");
    expect(await sqlstate("TRUNCATE app.document_version")).toBe("42501");
    for (const [sql, params, code] of [
      [
        "UPDATE app.document_version SET scan_status = 'CLEAN' WHERE id = $1",
        [version.id],
        "CN005",
      ],
      [
        "UPDATE app.document_version SET display_name = 'TEST other.pdf' WHERE id = $1",
        [version.id],
        "CN005",
      ],
      [
        "UPDATE app.document SET current_version_id = $1, version = version + 1 WHERE id = $2",
        [version.id, version.document_id],
        "CN005",
      ],
      [
        "UPDATE app.document SET category_code = 'CREDENTIAL', version = version + 1 WHERE id = $1",
        [version.document_id],
        "CN004",
      ],
      [
        "UPDATE app.document SET status = 'ARCHIVED', version = version + 1 WHERE id = $1",
        [version.document_id],
        "23514",
      ],
      [
        "UPDATE app.document SET updated_at = now() WHERE id = $1",
        [version.document_id],
        "CN005",
      ],
      [
        `INSERT INTO app.document_version (document_id, version_number, storage_provider_code, storage_object_key, display_name, media_type, size_bytes, content_hash, scan_status, uploaded_by_account_id, uploaded_at, finalized_at)
         SELECT document_id, 9, storage_provider_code, gen_random_uuid(), display_name, media_type, size_bytes, content_hash, 'CLEAN', uploaded_by_account_id, now(), now() FROM app.document_version WHERE id = $1`,
        [version.id],
        "CN005",
      ],
      [
        `INSERT INTO app.document_version (document_id, version_number, storage_provider_code, storage_object_key, display_name, media_type, size_bytes, content_hash, uploaded_by_account_id, uploaded_at)
         SELECT document_id, 9, storage_provider_code, gen_random_uuid(), display_name, 'text/html', size_bytes, content_hash, uploaded_by_account_id, now() FROM app.document_version WHERE id = $1`,
        [version.id],
        "23514",
      ],
    ] as const) {
      expect(await sqlstate(sql, [...params]), sql).toBe(code);
    }
  });

  it("keeps every audit chain verifiable", async () => {
    expect((await verify(db)).ok).toBe(true);
  });
});
