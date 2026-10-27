import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { henvisningSti, medHenvisning, renHenvisningskode } from "@/lib/henvisning/kode";
import * as kodeModul from "@/lib/henvisning/kode";
import { farligBilledSti, kanOptimeres } from "@/lib/billedUrl";

// Henvis en ven: koden fra linket, formularen og appen
// (20261102230000_henvis_en_ven.sql: 10 tegn, A-Z uden I og O, 2-9).
// Reglerne (loft, firma, selvhenvisning, dobbelt MitID, idempotens og RLS)
// testes i databasen: supabase/testscripts/20261102230000_henvis_en_ven_test.sql
// og 20261102270000_henvis_rettelser_test.sql (henviser uden MitID, låse, synk).
describe("renHenvisningskode", () => {
  it("godtager en gyldig kode, også med små bogstaver og mellemrum", () => {
    expect(renHenvisningskode("ABCDEFGHJK")).toBe("ABCDEFGHJK");
    expect(renHenvisningskode(" abcd2345xy ")).toBe("ABCD2345XY");
  });
  it("afviser alt andet", () => {
    for (const v of [
      null,
      undefined,
      123,
      "",
      "ABCDEFGHJ", // 9 tegn
      "ABCDEFGHJKL", // 11 tegn
      "ABCDEFGHIK", // I er ikke med
      "ABCDEFGHOK", // O er ikke med
      "ABCDEFGH01", // 0 og 1 er ikke med
      "ABCDE-GHJK",
      "<script>xx",
    ]) {
      expect(renHenvisningskode(v)).toBeNull();
    }
  });
  it("linket er forsiden med ?ven=", () => {
    expect(henvisningSti("ABCDEFGHJK")).toBe("/?ven=ABCDEFGHJK");
  });
});

// Ingen cookie (Filip, 27. okt. 2026): koden følger med i adressen til
// login, opret konto og "Indtast koden".
describe("medHenvisning", () => {
  it("lægger koden på login, opret konto og Indtast koden", () => {
    expect(medHenvisning("/signup", "abcdefghjk")).toBe("/signup?ven=ABCDEFGHJK");
    expect(medHenvisning("/login", "ABCDEFGHJK")).toBe("/login?ven=ABCDEFGHJK");
    expect(medHenvisning("/tjek-indbakke?fra=beta", "ABCDEFGHJK")).toBe("/tjek-indbakke?fra=beta&ven=ABCDEFGHJK");
  });
  it("bevarer redirect og #", () => {
    const href = medHenvisning("/login?redirect=/auktion/x%23spoergsmaal", "ABCDEFGHJK");
    const url = new URL(href, "https://bidhamr.dk");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("redirect")).toBe("/auktion/x#spoergsmaal");
    expect(url.searchParams.get("ven")).toBe("ABCDEFGHJK");
    expect(medHenvisning("/signup#top", "ABCDEFGHJK")).toBe("/signup?ven=ABCDEFGHJK#top");
  });
  it("rører ikke andre links, eksterne links eller en ugyldig kode", () => {
    expect(medHenvisning("/auktioner", "ABCDEFGHJK")).toBe("/auktioner");
    expect(medHenvisning("/login/andet", "ABCDEFGHJK")).toBe("/login/andet");
    expect(medHenvisning("https://evil.example/login", "ABCDEFGHJK")).toBe("https://evil.example/login");
    expect(medHenvisning("//evil.example/login", "ABCDEFGHJK")).toBe("//evil.example/login");
    expect(medHenvisning("/signup", null)).toBe("/signup");
    expect(medHenvisning("/signup", "<script>")).toBe("/signup");
  });
  it("overskriver ikke en kode, der allerede står i linket", () => {
    expect(medHenvisning("/signup?ven=BBBBBBBBBB", "ABCDEFGHJK")).toBe("/signup?ven=BBBBBBBBBB");
  });
});

describe("ingen cookie", () => {
  it("modulet har ingen cookie-konstanter", () => {
    expect(Object.keys(kodeModul).some((k) => /COOKIE/i.test(k))).toBe(false);
  });
  it("proxyen og cookie-siden nævner ikke bh_ven", () => {
    const rod = path.resolve(import.meta.dirname, "../..");
    for (const fil of ["src/proxy.ts", "src/lib/tekster/sider/cookies.ts", "src/app/actions/auth.ts"]) {
      expect(readFileSync(path.join(rod, fil), "utf8")).not.toMatch(/bh_ven|HENVISNING_COOKIE/);
    }
  });
});

// Delebilledet henter varebilledet på serveren: aldrig ud af /object/public/.
describe("farligBilledSti", () => {
  const BASE = "https://pjiigmzqwlfepxnjdvug.supabase.co/storage/v1/object/public/auktioner";
  it("godtager en almindelig sti", () => {
    expect(farligBilledSti(`${BASE}/abc/1.jpg`)).toBe(false);
    expect(kanOptimeres(`${BASE}/abc/1.jpg`)).toBe(true);
  });
  it("afviser .. og kodede punktummer", () => {
    for (const sti of ["/../sign/x.jpg", "/%2e%2e/x.jpg", "/%2E%2E/x.jpg", "/%252e%252e/x.jpg", "/.%2e/x.jpg", "/a\\b/x.jpg"]) {
      expect(farligBilledSti(`${BASE}${sti}`)).toBe(true);
    }
  });
});
