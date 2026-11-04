import { describe, expect, it } from "vitest";
import {
  checkAttachment,
  displayName,
  isAttachmentCategory,
  MAX_ATTACHMENT_BYTES,
  sizeLabel,
} from "./attachment-policy";

// Attachment validation (packet M2.5 §6, §11; AC-M2.5-03).

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);

describe("attachment validation", () => {
  it("accepts PDF, JPEG, and PNG by signature and takes the type from the bytes", () => {
    expect(checkAttachment("resume.pdf", "application/pdf", pdf)).toMatchObject(
      {
        ok: true,
        mediaType: "application/pdf",
      },
    );
    expect(checkAttachment("photo.JPG", "", jpeg)).toMatchObject({
      ok: true,
      mediaType: "image/jpeg",
    });
    expect(checkAttachment("card.png", "image/png", png)).toMatchObject({
      ok: true,
      mediaType: "image/png",
    });
  });

  it.each([
    ["empty.pdf", "", new Uint8Array(), "EMPTY"],
    ["big.pdf", "", new Uint8Array(MAX_ATTACHMENT_BYTES + 1), "TOO_LARGE"],
    ["macro.docx", "", pdf, "TYPE_NOT_ALLOWED"],
    ["run.exe", "", pdf, "TYPE_NOT_ALLOWED"],
    ["page.html", "text/html", pdf, "TYPE_NOT_ALLOWED"],
    ["image.svg", "image/svg+xml", png, "TYPE_NOT_ALLOWED"],
    ["archive.zip", "", pdf, "TYPE_NOT_ALLOWED"],
    ["noextension", "", pdf, "TYPE_NOT_ALLOWED"],
    ["double.pdf.exe", "", pdf, "TYPE_NOT_ALLOWED"],
    ["fake.pdf", "application/pdf", png, "CONTENT_MISMATCH"],
    ["fake.png", "image/png", pdf, "CONTENT_MISMATCH"],
    [
      "script.pdf",
      "application/pdf",
      new TextEncoder().encode("<script>"),
      "CONTENT_MISMATCH",
    ],
    ["declared.pdf", "text/html", pdf, "CONTENT_MISMATCH"],
  ])("refuses %s", (name, type, bytes, reason) => {
    expect(checkAttachment(name, type, bytes)).toEqual({ ok: false, reason });
  });

  it("keeps a display name free of paths and unsafe characters", () => {
    const type = "application/pdf";
    expect(displayName("../../etc/passwd.pdf", type)).toBe("passwd.pdf");
    expect(displayName("C:\\Users\\TEST\\cv.pdf", type)).toBe("cv.pdf");
    expect(displayName("cv\u202Efdp.exe.pdf", type)).toBe("cvfdp.exe.pdf");
    expect(displayName("nul\u0000l.pdf", type)).toBe("null.pdf");
    expect(displayName("...hidden.pdf", type)).toBe("hidden.pdf");
    expect(displayName("/", type)).toBe("attachment.pdf");
    expect(displayName(`${"x".repeat(300)}.pdf`, type)).toHaveLength(120);
    expect(displayName(`${"x".repeat(300)}.pdf`, type).endsWith(".pdf")).toBe(
      true,
    );
    expect(displayName("Currículum 李.pdf", type)).toBe("Currículum 李.pdf");
  });

  it("allowlists categories and formats sizes", () => {
    expect(isAttachmentCategory("RESUME")).toBe(true);
    expect(isAttachmentCategory("CREDENTIAL")).toBe(true);
    for (const bad of ["IDENTITY", "TAX", "toString", "__proto__", 1, null]) {
      expect(isAttachmentCategory(bad)).toBe(false);
    }
    expect(sizeLabel(10)).toBe("1 KB");
    expect(sizeLabel(2048)).toBe("2 KB");
    expect(sizeLabel(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
