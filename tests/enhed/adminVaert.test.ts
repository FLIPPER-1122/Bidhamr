// Admin på egen host (docs/ADMIN-VAERT.md): erAdminVaert, links og valg af
// cookie (src/lib/adminVaert.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_COOKIE_LOKAL,
  ADMIN_COOKIE_PROD,
  adminAbsolutUrl,
  adminCookieNavn,
  adminCookieOptions,
  adminUrl,
  adminVaertAktiv,
  erAdminVaert,
  hovedDomaeneLukning,
  hovedsiteUrl,
  normaliserVaert,
  supabaseCookieOptions,
} from "@/lib/adminVaert";

afterEach(() => vi.unstubAllEnvs());

describe("normaliserVaert", () => {
  it.each([
    ["admin.bidhamr.dk", "admin.bidhamr.dk"],
    ["Admin.BidHamr.DK", "admin.bidhamr.dk"],
    ["admin.bidhamr.dk:443", "admin.bidhamr.dk"],
    ["admin.localhost:3000", "admin.localhost"],
    [" admin.bidhamr.dk. ", "admin.bidhamr.dk"],
    ["admin.bidhamr.dk, evil.dk", "admin.bidhamr.dk"],
    ["[::1]:3000", "[::1]"],
    ["", ""],
    [null, ""],
    [undefined, ""],
    ["admin bidhamr.dk", ""],
    ["admin.bidhamr.dk/sti", ""],
  ])("%s -> %s", (ind, ud) => {
    expect(normaliserVaert(ind as string | null | undefined)).toBe(ud);
  });
});

describe("erAdminVaert", () => {
  it("er altid false uden ADMIN_VAERT (flaget slået fra)", () => {
    vi.stubEnv("ADMIN_VAERT", "");
    expect(adminVaertAktiv()).toBe(false);
    expect(erAdminVaert("admin.bidhamr.dk")).toBe(false);
    expect(erAdminVaert("localhost:3000")).toBe(false);
  });

  it("sammenligner præcist uden port og store/små bogstaver", () => {
    vi.stubEnv("ADMIN_VAERT", "admin.bidhamr.dk");
    expect(erAdminVaert("admin.bidhamr.dk")).toBe(true);
    expect(erAdminVaert("ADMIN.bidhamr.dk:443")).toBe(true);
    expect(erAdminVaert("bidhamr.dk")).toBe(false);
    expect(erAdminVaert("www.bidhamr.dk")).toBe(false);
    expect(erAdminVaert("admin.bidhamr.dk.evil.dk")).toBe(false);
    expect(erAdminVaert("evil.dk.admin.bidhamr.dk")).toBe(false);
    expect(erAdminVaert("xadmin.bidhamr.dk")).toBe(false);
    expect(erAdminVaert(null)).toBe(false);
    expect(erAdminVaert("")).toBe(false);
  });

  it("godtager aldrig *.vercel.app i produktion", () => {
    vi.stubEnv("ADMIN_VAERT", "hamr-admin.vercel.app");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(erAdminVaert("hamr-admin.vercel.app")).toBe(false);
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "development");
    expect(erAdminVaert("hamr-admin.vercel.app")).toBe(true);
  });

  it("lokalt: admin.localhost", () => {
    vi.stubEnv("ADMIN_VAERT", "admin.localhost");
    expect(erAdminVaert("admin.localhost:3000")).toBe(true);
    expect(erAdminVaert("localhost:3000")).toBe(false);
  });
});

describe("hovedDomaeneLukning", () => {
  it.each([
    ["", "", "nej"],
    ["", "1", "nej"],
    ["", "omdiriger", "nej"],
    ["admin.bidhamr.dk", "", "nej"],
    ["admin.bidhamr.dk", "omdiriger", "omdiriger"],
    ["admin.bidhamr.dk", "OMDIRIGER", "omdiriger"],
    ["admin.bidhamr.dk", "1", "luk"],
    ["admin.bidhamr.dk", "true", "luk"],
    ["admin.bidhamr.dk", "noget andet", "nej"],
  ])("ADMIN_VAERT=%s ADMIN_LUK_HOVEDDOMAENE=%s -> %s", (vaert, luk, ud) => {
    vi.stubEnv("ADMIN_VAERT", vaert);
    vi.stubEnv("ADMIN_LUK_HOVEDDOMAENE", luk);
    expect(hovedDomaeneLukning()).toBe(ud);
  });
});

describe("links", () => {
  it("adminUrl er relativ uden NEXT_PUBLIC_ADMIN_URL og fuld med", () => {
    vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "");
    expect(adminUrl("/admin/sager")).toBe("/admin/sager");
    expect(hovedsiteUrl("/auktion/x")).toBe("/auktion/x");
    vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "https://admin.bidhamr.dk/");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://bidhamr.dk");
    expect(adminUrl("/admin/sager")).toBe("https://admin.bidhamr.dk/admin/sager");
    expect(adminUrl("admin")).toBe("https://admin.bidhamr.dk/admin");
    expect(hovedsiteUrl("/auktion/x")).toBe("https://bidhamr.dk/auktion/x");
  });

  it("adminAbsolutUrl (mails) er altid fuld", () => {
    vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://bidhamr.dk");
    expect(adminAbsolutUrl("/admin/drift")).toBe("https://bidhamr.dk/admin/drift");
    vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "https://admin.bidhamr.dk");
    expect(adminAbsolutUrl("/admin/drift")).toBe("https://admin.bidhamr.dk/admin/drift");
  });

  it("en ugyldig NEXT_PUBLIC_ADMIN_URL ignoreres", () => {
    vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "javascript:alert(1)");
    expect(adminUrl("/admin")).toBe("/admin");
  });

  it("mail-layoutets sideUrl sender /admin til admin-hosten", async () => {
    vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "https://admin.bidhamr.dk");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://bidhamr.dk");
    const { sideUrl } = await import("@/lib/mails/layout");
    expect(sideUrl("/admin/kontakt")).toBe("https://admin.bidhamr.dk/admin/kontakt");
    expect(sideUrl("/admin")).toBe("https://admin.bidhamr.dk/admin");
    expect(sideUrl("/administrator")).toBe("https://bidhamr.dk/administrator");
    expect(sideUrl("/konto")).toBe("https://bidhamr.dk/konto");
  });
});

describe("cookie", () => {
  it("__Host-bh-admin-auth i produktion, bh-admin-auth lokalt", () => {
    expect(adminCookieNavn(true)).toBe(ADMIN_COOKIE_PROD);
    expect(ADMIN_COOKIE_PROD).toBe("__Host-bh-admin-auth");
    expect(adminCookieNavn(false)).toBe(ADMIN_COOKIE_LOKAL);
    expect(ADMIN_COOKIE_LOKAL).toBe("bh-admin-auth");
  });

  it("__Host-kravene: Secure, Path=/ og INGEN Domain (host-only)", () => {
    const o = adminCookieOptions(true);
    expect(o).toMatchObject({ name: "__Host-bh-admin-auth", path: "/", secure: true, sameSite: "lax" });
    expect(o).not.toHaveProperty("domain");
    expect(adminCookieOptions(false).secure).toBe(false);
  });

  it("hovedsitet bruger Supabases standard-cookie (uændret)", () => {
    expect(supabaseCookieOptions(false)).toBeUndefined();
    expect(supabaseCookieOptions(true)?.name).toMatch(/bh-admin-auth$/);
  });
});
