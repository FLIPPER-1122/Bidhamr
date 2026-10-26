import { afterEach, describe, expect, it, vi } from "vitest";
import { harAdgangTilLukketApp, linkTilladtILukketUdgave } from "@/lib/lukketUdgaveRegler";
import { robotsFoerLancering, seoFoerLancering, seoIndeksering } from "@/lib/seo";

const PROD = "https://lkifkrexeldimmghnsie.supabase.co";
const TEST = "https://pjiigmzqwlfepxnjdvug.supabase.co";

afterEach(() => vi.unstubAllEnvs());

describe("den lukkede udgave før lancering", () => {
  it("staff, firmakonti og beta-testere har adgang - andre ikke", () => {
    for (const rolle of ["chef", "admin", "medarbejder", "saelger"]) {
      expect(harAdgangTilLukketApp({ rolle, kontoType: null, beta: false })).toBe(true);
    }
    expect(harAdgangTilLukketApp({ rolle: null, kontoType: "erhverv", beta: false })).toBe(true);
    expect(harAdgangTilLukketApp({ rolle: "bruger", kontoType: "privat", beta: true })).toBe(true);
    expect(harAdgangTilLukketApp({ rolle: "bruger", kontoType: "privat", beta: false })).toBe(false);
    expect(harAdgangTilLukketApp({ rolle: null, kontoType: null, beta: false })).toBe(false);
  });

  it("kun erhverv, coming soon og de lovpligtige sider må linkes til", () => {
    for (const ok of ["/erhverv", "/erhverv/formular", "/privatliv#afsnit-3", "/betingelser", "/dsa/anmeld", "/coming-soon", "mailto:a@b.dk", "#top"]) {
      expect(linkTilladtILukketUdgave(ok)).toBe(true);
    }
    for (const nej of ["/", "/cookies", "/bidhamr-beskyttelse", "/faq", "/konto/afgoerelser", "/erhvervssaelger/x", "/dsa-x"]) {
      expect(linkTilladtILukketUdgave(nej)).toBe(false);
    }
  });
});

describe("SEO før lancering", () => {
  it("kun i Vercels produktion mod produktionsdatabasen", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", PROD);
    vi.stubEnv("LANCERET", "");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(seoFoerLancering()).toBe(true);
    expect(robotsFoerLancering("/erhverv")).toEqual({ robots: { index: true, follow: true } });
    expect(robotsFoerLancering(null)).toEqual({ robots: { index: false, follow: true } });
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(seoFoerLancering()).toBe(false);
  });

  it("aldrig på test.bidhamr.dk (testdatabasen på Vercel)", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST);
    vi.stubEnv("SIMULER_FOER_LANCERING", "true");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(seoFoerLancering()).toBe(false);
  });

  it("efter lancering styrer SEO_INDEKSERING som før", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", PROD);
    vi.stubEnv("LANCERET", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SEO_INDEKSERING", "");
    expect(seoFoerLancering()).toBe(false);
    expect(seoIndeksering()).toBe(false);
    expect(robotsFoerLancering("/erhverv")).toEqual({ robots: { index: false, follow: false } });
    vi.stubEnv("SEO_INDEKSERING", "true");
    expect(seoIndeksering()).toBe(true);
    expect(robotsFoerLancering("/erhverv")).toEqual({});
  });

  it("SEO_INDEKSERING åbner ikke hele siden før lancering", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", PROD);
    vi.stubEnv("LANCERET", "");
    vi.stubEnv("SEO_INDEKSERING", "true");
    expect(seoIndeksering()).toBe(false);
  });
});
