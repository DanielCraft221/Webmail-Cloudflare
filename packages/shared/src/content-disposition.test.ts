import { describe, expect, it } from "vitest";
import { contentDisposition } from "./content-disposition.ts";

// Same cases as the Worker's copy (apps/mail-core/test/api.test.ts), plus the Etapa 6 ones.
describe("contentDisposition", () => {
  it.each([
    [null, `attachment; filename="anexo"; filename*=UTF-8''anexo`],
    ["...", `attachment; filename="anexo"; filename*=UTF-8''anexo`],
    [
      "../../etc/passwd",
      `attachment; filename="_.._etc_passwd"; filename*=UTF-8''_.._etc_passwd`,
    ],
    [
      'a"b\r\nContent-Type: text/html.txt',
      `attachment; filename="a_bContent-Type: text_html.txt"; filename*=UTF-8''a%22bContent-Type%3A%20text_html.txt`,
    ],
    [
      "relatório ação.pdf",
      `attachment; filename="relat_rio a__o.pdf"; filename*=UTF-8''relat%C3%B3rio%20a%C3%A7%C3%A3o.pdf`,
    ],
    [
      "a\\b/c.txt",
      `attachment; filename="a_b_c.txt"; filename*=UTF-8''a_b_c.txt`,
    ],
    [
      "fatura\u202Efdp.exe",
      `attachment; filename="faturafdp.exe"; filename*=UTF-8''faturafdp.exe`,
    ],
    [
      "it's (1)*.txt",
      `attachment; filename="it's (1)*.txt"; filename*=UTF-8''it%27s%20%281%29%2A.txt`,
    ],
    ["\ud800x.txt", `attachment; filename="x.txt"; filename*=UTF-8''x.txt`],
  ])("%j", (name, expected) => {
    expect(contentDisposition(name, "anexo")).toBe(expected);
  });

  // Trojan Source controls, built from code points so this file stays free of literal bidi characters.
  it.each([
    "202A",
    "202B",
    "202C",
    "202D",
    "202E",
    "2066",
    "2067",
    "2068",
    "2069",
  ])("removes bidi control U+%s", (hex) => {
    const name = `fatura${String.fromCodePoint(Number.parseInt(hex, 16))}fdp.exe`;
    expect(contentDisposition(name, "anexo")).toBe(
      `attachment; filename="faturafdp.exe"; filename*=UTF-8''faturafdp.exe`,
    );
  });

  it("caps the name at 200 characters without splitting one", () => {
    const header = contentDisposition("😀".repeat(300), "anexo");
    const encoded = header.split("UTF-8''")[1] ?? "";
    expect(decodeURIComponent(encoded)).toBe("😀".repeat(200));
  });
});
