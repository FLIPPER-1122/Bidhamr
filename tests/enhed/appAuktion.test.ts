// POST /api/auktion/app/fjern-billeder og den fælles oprydning
// (src/lib/auktionBilledOprydning.ts): kun ejeren, kun egen mappe, kun
// filer, som ingen af ejerens auktioner bruger, og intet under en åben sag.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { falskKlient } from "./hjaelpere/falskSupabase";

const EJER = "11111111-1111-4111-8111-111111111111";
const FREMMED = "33333333-3333-4333-8333-333333333333";
const AUKTION = "55555555-5555-4555-8555-555555555555";
const TOKEN = "aaa.bbb.ccc";
const URL_DEL = "https://x.supabase.co/storage/v1/object/public/auktion-billeder/";

const m = vi.hoisted(() => ({
  bruger: "11111111-1111-4111-8111-111111111111" as string | null,
  ejer: "11111111-1111-4111-8111-111111111111" as string | null,
  iBrug: [] as string[],
  aabenSag: false,
  slettet: [] as string[][],
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "127.0.0.9" }) }));
vi.mock("@/lib/rateLimit", () => ({
  FOR_MANGE_FORSOEG: "For mange forsøg.",
  klientIp: async () => "127.0.0.9",
  tjekGraenser: async () => true,
}));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const k = falskKlient((q) => {
      if (q.tabel === "auctions" && q.kolonner === "id, bruger_id") {
        return { data: m.ejer ? { id: AUKTION, bruger_id: m.ejer } : null, error: null };
      }
      if (q.tabel === "auctions") return { data: [{ billeder: m.iBrug }], error: null };
      if (q.tabel === "dsa_anmeldelser") return { data: m.aabenSag ? [{ id: "x" }] : [], error: null };
      if (q.tabel === "reports") return { data: [], error: null };
      return undefined;
    }).klient;
    return {
      ...k,
      storage: {
        from: () => ({
          remove: async (stier: string[]) => {
            m.slettet.push(stier);
            return { data: null, error: null };
          },
        }),
      },
    };
  },
}));
vi.mock("@/lib/appApi", async (orig) => ({
  ...(await orig<typeof import("@/lib/appApi")>()),
  appBruger: async (token: string) => (token === TOKEN && m.bruger ? { bruger: { id: m.bruger }, supabase: {} } : null),
}));

const { POST } = await import("@/app/api/auktion/app/[handling]/route");

async function kald(krop: unknown, handling = "fjern-billeder", token: string | null = TOKEN) {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await POST(new NextRequest(`http://localhost/api/auktion/app/${handling}`, { method: "POST", body: JSON.stringify(krop), headers }), {
    params: Promise.resolve({ handling }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  m.bruger = EJER;
  m.ejer = EJER;
  m.iBrug = [];
  m.aabenSag = false;
  m.slettet = [];
});

describe("POST /api/auktion/app/fjern-billeder", () => {
  it("adgang: 401 uden login, 403 for andre end ejeren, 404 for en ukendt auktion", async () => {
    expect((await kald({ auktion_id: AUKTION, stier: [] }, "fjern-billeder", null)).status).toBe(401);
    m.bruger = FREMMED;
    const f = await kald({ auktion_id: AUKTION, stier: [`${FREMMED}/a.jpg`] });
    expect(f.status).toBe(403);
    expect(f.body.kode).toBe("ikke_ejer");
    m.bruger = EJER;
    m.ejer = null;
    expect((await kald({ auktion_id: AUKTION, stier: [] })).status).toBe(404);
    expect(m.slettet).toEqual([]);
  });

  it("ugyldig krop: 400; ukendt handling: 404", async () => {
    expect((await kald({ auktion_id: AUKTION })).status).toBe(400);
    expect((await kald({ auktion_id: AUKTION, stier: "a" })).status).toBe(400);
    expect((await kald({ auktion_id: AUKTION, stier: Array(21).fill(`${EJER}/a.jpg`) })).status).toBe(400);
    expect((await kald({ auktion_id: AUKTION, stier: [] }, "slet-alt")).status).toBe(404);
  });

  it("sletter kun egne, ubrugte filer (stier og URL'er)", async () => {
    m.iBrug = [`${URL_DEL}${EJER}/i-brug.jpg`, `${EJER}/ogsaa-i-brug.jpg`];
    const r = await kald({
      auktion_id: AUKTION,
      stier: [
        `${EJER}/gammel.jpg`,
        `${URL_DEL}${EJER}/gammel2.jpg`,
        `${EJER}/i-brug.jpg`,
        `${EJER}/ogsaa-i-brug.jpg`,
        `${FREMMED}/andens.jpg`,
        `${EJER}/../${FREMMED}/x.jpg`,
        "https://ond.example/x.jpg",
      ],
    });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(m.slettet).toEqual([[`${EJER}/gammel.jpg`, `${EJER}/gammel2.jpg`]]);
  });

  it("åben DSA-sag om auktionen: intet slettes", async () => {
    m.aabenSag = true;
    expect((await kald({ auktion_id: AUKTION, stier: [`${EJER}/gammel.jpg`] })).status).toBe(200);
    expect(m.slettet).toEqual([]);
  });
});
