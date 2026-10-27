// Appens pakkeskift (src/app/api/firma/skift-pakke/route.ts), rettelser 4:
//  - GET ?til=<pakke>: hvad et skift koster nu (samme regel som serveren)
//  - POST: egne fejlkoder for afviste skift op fra den gratis måned
//    (pris_aendret, rabat_venter, ret_rabat, visning_mangler -> 409) og
//    ugyldig_visning -> 400.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const BRUGER = "33333333-3333-4333-8333-333333333333";
const PRO = "7e57a000-0000-4000-8000-000000000003";
const TOKEN = "aaa.bbb.ccc";

const m = vi.hoisted(() => ({ skift: vi.fn(), velkomst: vi.fn() }));

vi.mock("@/lib/rateLimit", () => ({
  FOR_MANGE_FORSOEG: "For mange forsøg.",
  klientIp: async () => "127.0.0.9",
  tjekGraenser: async () => true,
}));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => {}) }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async (tk: string) =>
        tk === TOKEN ? { data: { user: { id: BRUGER } }, error: null } : { data: { user: null }, error: { message: "x" } },
    },
  }),
}));
vi.mock("@/lib/erhverv/pakkeskift", () => ({ skiftPakkeForBruger: m.skift }));
vi.mock("@/lib/erhverv/betaling", () => ({ velkomstSkiftForPakke: m.velkomst }));

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://eksempel.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "sb_publishable_test";

const { GET, POST } = await import("@/app/api/firma/skift-pakke/route");

function hent(til: string | null, token = TOKEN) {
  const q = til === null ? "" : `?til=${encodeURIComponent(til)}`;
  return new NextRequest(`http://localhost/api/firma/skift-pakke${q}`, {
    method: "GET",
    headers: { host: "localhost", authorization: `Bearer ${token}` },
  });
}
function send(krop: unknown) {
  return new NextRequest("http://localhost/api/firma/skift-pakke", {
    method: "POST",
    body: JSON.stringify(krop),
    headers: { "content-type": "application/json", host: "localhost", authorization: `Bearer ${TOKEN}` },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/firma/skift-pakke?til=<pakke>", () => {
  it("skift op fra den gratis måned: beløb, rabat, dato og visning", async () => {
    m.velkomst.mockResolvedValueOnce({
      status: "ok",
      pakke: { id: PRO, navn: "Pro" },
      tilbud: {
        udfald: "skift",
        visning: "intro:30",
        rabat: { slags: "intro", procent: 30, til: "31. januar 2027", maaneder: 3 },
        beloeb: { eksklOere: 139_930, inklOere: 174_913 },
        kanSkifte: true,
        tekst: "Din gratis måned slutter …",
        knap: "Ja, vælg Pro",
      },
    });
    const res = await GET(hent(PRO));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: true,
      pakke: { id: PRO, navn: "Pro" },
      velkomstSkift: true,
      udfald: "skift",
      visning: "intro:30",
      rabat: { slags: "intro", procent: 30, til: "31. januar 2027", maaneder: 3 },
      beloeb: { eksklOere: 139_930, inklOere: 174_913 },
      kanSkifte: true,
      tekst: "Din gratis måned slutter …",
      knap: "Ja, vælg Pro",
    });
    expect(m.velkomst).toHaveBeenCalledWith(BRUGER, PRO);
  });

  it("almindeligt skift: velkomstSkift false (POST kræver ingen visning)", async () => {
    m.velkomst.mockResolvedValueOnce({ status: "ok", pakke: { id: PRO, navn: "Pro" }, tilbud: null });
    const res = await GET(hent(PRO));
    expect(await res.json()).toEqual({ ok: true, pakke: { id: PRO, navn: "Pro" }, velkomstSkift: false });
  });

  it("fejl: ugyldig pakke 400, uden login 401, ikke firma 403, Stripe nede 500 (intet beløb)", async () => {
    expect((await GET(hent("ikke-en-uuid"))).status).toBe(400);
    expect((await GET(hent(null))).status).toBe(400);
    expect((await GET(hent(PRO, "x.y.z"))).status).toBe(401);
    m.velkomst.mockResolvedValueOnce({ status: "ikke_firma" });
    expect(await (await GET(hent(PRO))).json()).toMatchObject({ kode: "ikke_tilladt" });
    m.velkomst.mockResolvedValueOnce({ status: "ugyldig_pakke" });
    expect((await GET(hent(PRO))).status).toBe(400);
    m.velkomst.mockRejectedValueOnce(new Error("Stripe nede"));
    const r = await GET(hent(PRO));
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ kode: "fejl" });
  });
});

describe("POST /api/firma/skift-pakke: appens fejlkoder", () => {
  it.each([
    ["pris_aendret", 409],
    ["rabat_venter", 409],
    ["ret_rabat", 409],
    ["visning_mangler", 409],
    ["i_gang", 409],
    ["stripe_fejl", 409],
    ["ugyldig_visning", 400],
    ["ugyldig_pakke", 400],
    ["ikke_tilladt", 403],
    ["for_mange", 429],
    ["fejl", 500],
  ])("%s -> %i", async (kode, status) => {
    m.skift.mockResolvedValueOnce({ fejl: "Besked", kode });
    const res = await POST(send({ pakkeId: PRO, visning: "velkomst:50" }));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ fejl: "Besked", kode });
  });

  it("visning sendes videre uændret (også en ugyldig - serveren afviser den)", async () => {
    m.skift.mockResolvedValue({ ok: true, kode: "opgraderet", besked: "ok" });
    await POST(send({ pakkeId: PRO, visning: "intro:30" }));
    await POST(send({ pakkeId: PRO, visning: "noget" }));
    await POST(send({ pakkeId: PRO }));
    expect(m.skift.mock.calls).toEqual([
      [BRUGER, PRO, "intro:30"],
      [BRUGER, PRO, "noget"],
      [BRUGER, PRO, undefined],
    ]);
  });
});
