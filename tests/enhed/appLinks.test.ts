import { describe, expect, it } from "vitest";
import { androidFingeraftryk, appleAppSiteAssociation, assetLinks } from "@/lib/appLinks";

const A = Array.from({ length: 32 }, () => "AB").join(":");
const B = Array.from({ length: 32 }, () => "0f").join(":");

describe("assetlinks.json", () => {
  it("er en tom liste uden fingeraftryk", () => {
    expect(assetLinks(undefined)).toEqual([]);
    expect(assetLinks("")).toEqual([]);
    expect(assetLinks(" , ugyldig ")).toEqual([]);
  });

  it("tager gyldige aftryk kommasepareret, store bogstaver, uden dubletter", () => {
    expect(androidFingeraftryk(` ${A} , ${B},${A}, forkert`)).toEqual([A, B.toUpperCase()]);
    const [link] = assetLinks(A);
    expect(link.target).toEqual({
      namespace: "android_app",
      package_name: "dk.bidhamr.app",
      sha256_cert_fingerprints: [A],
    });
  });
});

describe("apple-app-site-association", () => {
  it("kun auktioner og forsiden med ?ven=, undtagelser først", () => {
    const [detalje] = appleAppSiteAssociation().applinks.details;
    expect(detalje.appIDs).toEqual(["ZSNR827X8C.dk.bidhamr.app"]);
    const stier = detalje.components.map((c) => c["/"]);
    expect(stier).toEqual(["/auktion/*/*", "/auktion/*", "/"]);
    expect(detalje.components[0].exclude).toBe(true);
    expect(detalje.components[2]["?"]).toEqual({ ven: "?*" });
    expect(stier.some((s) => /admin|konto|betal|auth/.test(s))).toBe(false);
  });
});
