import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// Foundation real-data canary guard (not a general DLP system). Scans test,
// fixture, and test-support source for values shaped like real personal data
// or live secrets. Synthetic values must use reserved/invalid forms:
//   SSN/TIN: area 000, 666, or 900-999, group 00, or serial 0000
//   Email:   reserved domains (example.test, *.example, *.invalid, ...)
//   Cards:   none in source; use obviously invalid digit strings
// Matches are reported by file, line, and rule with the value redacted.

export type CanaryFinding = {
  file: string;
  line: number;
  rule: string;
  redacted: string;
};

type Rule = {
  name: string;
  pattern: RegExp;
  isViolation?: (match: string) => boolean;
};

const consumerMailDomains =
  "gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|comcast|verizon|att";

const rules: Rule[] = [
  {
    name: "ssn-shaped value outside synthetic ranges",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    isViolation: (m) => {
      const [area, group, serial] = m.split("-");
      const a = Number(area);
      return !(
        a === 0 ||
        a === 666 ||
        a >= 900 ||
        group === "00" ||
        serial === "0000"
      );
    },
  },
  {
    name: "payment-card number (passes Luhn)",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    isViolation: (m) => passesLuhn(m.replace(/[ -]/g, "")),
  },
  {
    name: "personal email at a consumer mail provider",
    pattern: new RegExp(
      `\\b[\\w.+-]+@(?:${consumerMailDomains})\\.(?:com|net|org|co\\.uk|de|ch|me)\\b`,
      "gi",
    ),
  },
  {
    name: "private key material",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: "live cloud or service token",
    pattern:
      /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|sk_live_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
  },
];

/** Scans text and returns redacted findings. Pure; no I/O. */
export function scanForCanaries(file: string, text: string): CanaryFinding[] {
  const findings: CanaryFinding[] = [];
  const lines = text.split("\n");
  lines.forEach((content, index) => {
    for (const rule of rules) {
      for (const match of content.matchAll(rule.pattern)) {
        const value = match[0];
        if (rule.isViolation && !rule.isViolation(value)) continue;
        findings.push({
          file,
          line: index + 1,
          rule: rule.name,
          redacted: redact(value),
        });
      }
    }
  });
  return findings;
}

/** Keeps the first two characters and the length only. */
export function redact(value: string): string {
  return `${value.slice(0, 2)}…[${value.length} chars redacted]`;
}

function passesLuhn(digits: string): boolean {
  if (digits.length < 13 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Test, fixture, and test-support source files tracked or staged by Git. */
export const scanScope = [
  "tests/**/*.ts",
  "tests/**/*.tsx",
  "src/**/*.test.ts",
  "src/**/*.test.tsx",
  "scripts/**/*.test.ts",
];

function listScopedFiles(root: string): string[] {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...scanScope.map((glob) => `:(glob)${glob}`),
    ],
    { cwd: root, encoding: "utf8" },
  );
  return output.split("\n").filter(Boolean);
}

function main() {
  const root = path.resolve(import.meta.dirname, "../..");
  const files = listScopedFiles(root);
  const findings = files.flatMap((file) =>
    scanForCanaries(file, readFileSync(path.join(root, file), "utf8")),
  );
  if (findings.length > 0) {
    console.error(
      `test:data-guard found ${findings.length} forbidden value(s):`,
    );
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  ${f.rule}  ${f.redacted}`);
    }
    console.error(
      "Replace them with obviously synthetic values (see tests/fixtures).",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `test:data-guard passed (${files.length} test/fixture files scanned).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
