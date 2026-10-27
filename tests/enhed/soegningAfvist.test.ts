// soegningAfvist (src/lib/auktionSoegning.ts): kun Cloudflares HTML-side
// (403) foran Supabase må regnes som "ingen resultater". Et 403 fra PostgREST
// (JSON, fx 42501) og en HTML-side med 502/504 er rigtige fejl og må ikke
// skjules.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

const { soegningAfvist } = await import("@/lib/auktionSoegning");

describe("soegningAfvist", () => {
  it("403 med HTML-svar og søgetekst = ingen resultater", () => {
    expect(soegningAfvist("' or 1=1 --", 403, "<!DOCTYPE html><html>Attention Required! | Cloudflare")).toBe(true);
    expect(soegningAfvist("x", 403, "  \n<html>")).toBe(true);
  });

  it("PostgREST-fejl (42501 m.fl.) skjules ikke", () => {
    expect(soegningAfvist("cykel", 403, "permission denied for table auctions")).toBe(false);
    expect(soegningAfvist("cykel", 403, '{"code":"42501","message":"permission denied"}')).toBe(false);
  });

  it("502/504 med HTML er en rigtig fejl", () => {
    expect(soegningAfvist("cykel", 502, "<html><title>502 Bad Gateway</title></html>")).toBe(false);
    expect(soegningAfvist("cykel", 504, "<!DOCTYPE html><html>Gateway time-out")).toBe(false);
    expect(soegningAfvist("cykel", 0, "<html>")).toBe(false);
  });

  it("uden søgetekst er det altid en fejl", () => {
    expect(soegningAfvist("", 403, "<html>")).toBe(false);
  });
});
