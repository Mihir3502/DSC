import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LONG_TEXT_MAX,
  parseTemplate,
  SHORT_TEXT_MAX,
  validateSection,
  type TemplateSection,
} from "./application-template";

// Template parsing and candidate-safe draft validation (packet M2.4 §8,
// AC-M2.4-01/04). The seeded template is read from the committed migration.

const seeded = () => {
  const sql = readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../../drizzle/0007_application_draft.sql",
    ),
    "utf8",
  );
  return JSON.parse(/\$v1\$([\s\S]*)\$v1\$/.exec(sql)![1]!) as unknown;
};

const section: TemplateSection = {
  code: "sample",
  title: "Sample",
  description: "Sample section",
  fields: [
    { code: "name", label: "Name", type: "short_text", required: true },
    { code: "notes", label: "Notes", type: "long_text", required: false },
    { code: "start", label: "Start", type: "date", required: false },
    { code: "mail", label: "Email", type: "email", required: false },
    { code: "tel", label: "Phone", type: "phone", required: false },
    {
      code: "one",
      label: "One",
      type: "single_choice",
      required: false,
      options: [
        { value: "aa", label: "A" },
        { value: "bb", label: "B" },
      ],
    },
    {
      code: "many",
      label: "Many",
      type: "multi_choice",
      required: false,
      options: [
        { value: "aa", label: "A" },
        { value: "bb", label: "B" },
      ],
    },
  ],
};

describe("application template", () => {
  it("parses the seeded version 1 with exactly the approved neutral sections", () => {
    const template = parseTemplate(seeded());
    expect(template?.sections.map((s) => s.code)).toEqual([
      "availability",
      "experience",
      "education",
      "references",
    ]);
  });

  it("collects no eligibility, disclosure, identity, or medical question in version 1", () => {
    const text = JSON.stringify(
      parseTemplate(seeded())!.sections.flatMap((s) =>
        s.fields.map((f) => [f.code, f.label]),
      ),
    );
    expect(text).not.toMatch(
      /ssn|social|birth|\bage\b|gender|race|ethnic|religio|disab|medical|health|criminal|convict|arrest|citizen|immigra|eligib|salary|bank/i,
    );
  });

  it("refuses a malformed template or duplicate codes", () => {
    expect(parseTemplate({ sections: [] })).toBeNull();
    expect(parseTemplate({ sections: [section, section] })).toBeNull();
    expect(
      parseTemplate({
        sections: [
          { ...section, fields: [section.fields[0], section.fields[0]] },
        ],
      }),
    ).toBeNull();
    expect(parseTemplate({ sections: [section], extra: "field" })).toBeNull();
    expect(parseTemplate("not an object")).toBeNull();
  });
});

describe("draft validation", () => {
  it("keeps a partial draft In progress and names what is missing", () => {
    const result = validateSection(section, { notes: "TEST notes" });
    expect(result).toEqual({
      ok: true,
      answers: { notes: "TEST notes" },
      completion: "IN_PROGRESS",
      missing: ["name"],
    });
  });

  it("marks a section complete once every required answer is valid", () => {
    const result = validateSection(section, { name: "  TEST Ana  " });
    expect(result).toMatchObject({
      ok: true,
      answers: { name: "TEST Ana" },
      completion: "COMPLETE",
    });
  });

  it("drops empty values rather than storing them", () => {
    const result = validateSection(section, {
      name: "TEST",
      notes: "   ",
      start: "",
      many: [],
    });
    expect(result).toMatchObject({ ok: true, answers: { name: "TEST" } });
  });

  it("rejects unknown fields and non-object submissions as a whole", () => {
    for (const raw of [
      { name: "TEST", status: "SUBMITTED" },
      { __proto__x: "TEST" },
      { candidacyId: "x" },
      [],
      null,
      "text",
    ]) {
      expect(validateSection(section, raw)).toEqual({
        ok: false,
        rejected: true,
      });
    }
  });

  it.each([
    ["name", "x".repeat(SHORT_TEXT_MAX + 1), "TOO_LONG"],
    ["notes", "x".repeat(LONG_TEXT_MAX + 1), "TOO_LONG"],
    ["name", "TEST\u0000null", "INVALID_CHARACTERS"],
    ["name", "TEST‮bidi", "INVALID_CHARACTERS"],
    ["name", "line\nbreak", "INVALID_CHARACTERS"],
    ["name", 42, "INVALID_FORMAT"],
    ["start", "2026-02-30", "INVALID_DATE"],
    ["start", "02/03/2026", "INVALID_DATE"],
    ["start", "1800-01-01", "INVALID_DATE"],
    ["mail", "not-an-email", "INVALID_EMAIL"],
    ["tel", "<script>", "INVALID_PHONE"],
    ["one", "zz", "INVALID_CHOICE"],
    ["many", ["aa", "aa"], "INVALID_CHOICE"],
    ["many", ["zz"], "INVALID_CHOICE"],
    ["many", "aa", "INVALID_FORMAT"],
  ])("refuses %s=%j with %s and never echoes it", (field, value, problem) => {
    const result = validateSection(section, { [field]: value });
    expect(result).toEqual({ ok: false, problems: { [field]: problem } });
  });

  it("allows line breaks in long text and keeps lawful Unicode", () => {
    const result = validateSection(section, {
      name: "TEST Ríos 李",
      notes: "line one\r\nline two",
    });
    expect(result).toMatchObject({
      ok: true,
      answers: { name: "TEST Ríos 李", notes: "line one\nline two" },
    });
  });
});
