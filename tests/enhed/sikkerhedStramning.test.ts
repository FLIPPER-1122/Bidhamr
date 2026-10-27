// 20261102060000_sikkerhed_stramning: hjælpere på hjemmesiden.
import { afterEach, describe, expect, it, vi } from "vitest";
import { kortNavn, visNavn } from "@/lib/kortNavn";
import { auktionLoftTekst } from "@/lib/auktionRegler";
import { erCaptchaFejl, renCaptchaToken } from "@/lib/turnstile";
import { tjekTurnstile } from "@/lib/turnstileServer";

describe("visNavn (users.visningsnavn)", () => {
  it("viser databasens korte navn uændret og Anonym ved tomt", () => {
    expect(visNavn("Kasper K.")).toBe("Kasper K.");
    expect(visNavn("Testfirma ApS")).toBe("Testfirma ApS");
    expect(visNavn("  ")).toBe("Anonym");
    expect(visNavn(null)).toBe("Anonym");
  });
  it("kortNavn af et visningsnavn giver det samme (bagudkompatibelt)", () => {
    expect(kortNavn("Kasper K.")).toBe("Kasper K.");
  });
});

describe("auktionLoftTekst", () => {
  it("dansk tekst til BHA06 og BHA07, ellers null", () => {
    expect(auktionLoftTekst("BHA06")).toContain("30 i timen");
    expect(auktionLoftTekst("BHA07")).toContain("200 aktive auktioner");
    expect(auktionLoftTekst("BHA05")).toBeNull();
    expect(auktionLoftTekst(undefined)).toBeNull();
  });
});

describe("Turnstile", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renCaptchaToken: kun ikke-tomme strenge op til 2048 tegn", () => {
    expect(renCaptchaToken(" abc ")).toBe("abc");
    expect(renCaptchaToken("")).toBeUndefined();
    expect(renCaptchaToken(42)).toBeUndefined();
    expect(renCaptchaToken("x".repeat(2049))).toBeUndefined();
  });

  it("erCaptchaFejl genkender Supabase' captcha-fejl", () => {
    expect(erCaptchaFejl({ code: "captcha_failed" })).toBe(true);
    expect(erCaptchaFejl({ message: "captcha protection: request disallowed" })).toBe(true);
    expect(erCaptchaFejl({ code: "invalid_credentials", message: "Invalid login credentials" })).toBe(false);
    expect(erCaptchaFejl(null)).toBe(false);
  });

  it("uden TURNSTILE_SECRET_KEY springes tjekket over", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await tjekTurnstile(undefined, "1.2.3.4")).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it("med TURNSTILE_SECRET_KEY: manglende token afvises, gyldigt godkendes, fejl afvises", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "hemmelig");
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect(await tjekTurnstile(undefined, "1.2.3.4")).toBe(false);
    expect(await tjekTurnstile("tok", "1.2.3.4")).toBe(true);
    const krop = f.mock.calls[0][1].body as URLSearchParams;
    expect(krop.get("secret")).toBe("hemmelig");
    expect(krop.get("response")).toBe("tok");
    expect(krop.get("remoteip")).toBe("1.2.3.4");
    f.mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 200 }));
    expect(await tjekTurnstile("tok", "ukendt")).toBe(false);
    f.mockRejectedValueOnce(new Error("netværk"));
    expect(await tjekTurnstile("tok", null)).toBe(false);
  });
});
