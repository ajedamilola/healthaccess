import { describe, expect, it } from "vitest";
import { validateFiles } from "@/features/assistant/files";

function file(name: string, type: string, size = 1024) {
  return new File([new Uint8Array(size)], name, { type });
}

describe("assistant file validation", () => {
  it("accepts up to five images and PDFs under 10 MB each", () => {
    expect(
      validateFiles([
        file("photo.png", "image/png", 2 * 1024 * 1024),
        file("notes.pdf", "application/pdf", 9 * 1024 * 1024),
      ]),
    ).toBeNull();
  });

  it("rejects a sixth file", () => {
    const files = Array.from({ length: 6 }, (_, index) => file(`photo-${index}.png`, "image/png"));
    expect(validateFiles(files)).toBe("Choose up to 5 files.");
  });

  it("rejects a type that is not an image or PDF", () => {
    expect(validateFiles([file("notes.txt", "text/plain")])).toBe("notes.txt is not an image or PDF.");
  });

  it("rejects a file larger than 10 MB", () => {
    expect(validateFiles([file("scan.pdf", "application/pdf", 10 * 1024 * 1024 + 1)])).toBe(
      "scan.pdf is larger than 10 MB.",
    );
  });
});
