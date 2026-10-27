// soegningAfvist (src/lib/auktionSoegning.ts): kun Cloudflares HTML-side
// foran Supabase må regnes som "ingen resultater". Et 403 fra PostgREST
// (JSON, fx 42501) er en rigtig fejl og må ikke skjules.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

const { soegningAfvist } = await import("@/lib/auktionSoegning");

describe("soegningAfvist", () => {
  it("HTML-svar med søgetekst = ingen resultater", () => {
    expect(soegningAfvist("' or 1=1 --", "<!DOCTYPE html><html>Attention Required! | Cloudflare")).toBe(true);
    expect(soegningAfvist("x", "  \n<html>")).toBe(true);
  });

  it("PostgREST-fejl (42501 m.fl.) skjules ikke", () => {
    expect(soegningAfvist("cykel", 'permission denied for table auctions')).toBe(false);
    expect(soegningAfvist("cykel", '{"code":"42501","message":"permission denied"}')).toBe(false);
  });

  it("uden søgetekst er det altid en fejl", () => {
    expect(soegningAfvist("", "<html>")).toBe(false);
  });
});
