// Serverens CVR-tjek ved oprettelse af en firmakonto (cvr.ts,
// cvrTilOprettelse - bruges af opretFirmakonto). Opslaget hos cvrapi.dk
// efterlignes med en falsk fetch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cvrTilOprettelse, slaaCvrOpOffentligt } from "@/lib/erhverv/cvr";

function svar(status: number, krop: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(krop), { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe("cvrTilOprettelse", () => {
  it("ophørt CVR (testerens 12345674 har slutdato) afvises", async () => {
    svar(200, { vat: 12345674, name: "HKBW Press + Interieur", address: "Ordrup Jagtvej 4A", zipcode: "2920", city: "Charlottenlund", enddate: "29/12 - 2017" });
    expect(cvrTilOprettelse(await slaaCvrOpOffentligt("12345674"))).toBe("ikke_aktivt");
  });
  it("aktivt CVR godkendes", async () => {
    svar(200, { vat: 46836219, name: "Bidhamr ApS", address: "Ellegårdsvej 40", zipcode: "4684", city: "Holmegaard", enddate: null });
    expect(cvrTilOprettelse(await slaaCvrOpOffentligt("46836219"))).toBe("ok");
  });
  it("CVR, der ikke findes, afvises", async () => {
    svar(200, { error: "NOT_FOUND" });
    expect(cvrTilOprettelse(await slaaCvrOpOffentligt("11111111"))).toBe("ikke_fundet");
    svar(404, {});
    expect(cvrTilOprettelse(await slaaCvrOpOffentligt("11111111"))).toBe("ikke_fundet");
  });
  it("opslaget nede eller fejl: tillades (utilgaengelig)", async () => {
    svar(500, {});
    expect(cvrTilOprettelse(await slaaCvrOpOffentligt("46836219"))).toBe("utilgaengelig");
    svar(200, { error: "QUOTA_EXCEEDED" });
    expect(cvrTilOprettelse(await slaaCvrOpOffentligt("46836219"))).toBe("utilgaengelig");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("netværk"); }));
    expect(cvrTilOprettelse(await slaaCvrOpOffentligt("46836219"))).toBe("utilgaengelig");
  });
  it("ugyldigt CVR afvises uden opslag", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(cvrTilOprettelse(await slaaCvrOpOffentligt("1234"))).toBe("ugyldigt_cvr");
    expect(f).not.toHaveBeenCalled();
  });
});
