import { describe, expect, it } from "vitest";
import { mailboxAddress } from "./mailbox-address";

const schema = mailboxAddress(["survivus.com.br", "survivusmc.com"]);

describe("mailboxAddress", () => {
  it.each([
    "contato@survivus.com.br",
    "suporte@survivusmc.com",
    "compras@survivus.com.br",
  ])("accepts %s", (address) => {
    expect(schema.parse(address)).toBe(address);
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(schema.parse("  Contato@Survivus.COM.BR ")).toBe(
      "contato@survivus.com.br",
    );
  });

  it("matches configured domains case-insensitively", () => {
    expect(
      mailboxAddress(["Survivus.com.br"]).parse("contato@survivus.com.br"),
    ).toBe("contato@survivus.com.br");
  });

  it.each([
    ["other domain", "someone@gmail.com"],
    ["subdomain of an allowed domain", "contato@mail.survivus.com.br"],
    ["allowed domain as suffix", "contato@evilsurvivus.com.br"],
    ["allowed domain as prefix", "contato@survivus.com.br.evil.com"],
    ["no @", "contato"],
    ["empty local part", "@survivus.com.br"],
    ["two @", "a@b@survivus.com.br"],
    ["empty string", ""],
  ])("rejects %s", (_case, address) => {
    expect(schema.safeParse(address).success).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(schema.safeParse(42).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });

  it("rejects everything when no domain is configured", () => {
    expect(
      mailboxAddress([]).safeParse("contato@survivus.com.br").success,
    ).toBe(false);
  });
});
