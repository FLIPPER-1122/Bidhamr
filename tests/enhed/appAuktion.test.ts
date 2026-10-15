// POST /api/auktion/app/fjern-billeder og den fælles oprydning
// (src/lib/auktionBilledOprydning.ts): kun ejeren; hvad der må slettes,
// afgør databasen (auktion_billeder_sletbare - testet i PGlite), og sager
// tjekkes altid for HELE brugeren, så et andet auktion_id ikke kan bruges
// til at slette bevis.
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
  rpcSvar: { data: { kode: "ok", stier: [] as string[] } as unknown, error: null as null | { message: string } },
  rpcKald: [] as { navn: string; args: unknown }[],
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
    const k = falskKlient(
      (q) => (q.tabel === "auctions" ? { data: m.ejer ? { id: AUKTION, bruger_id: m.ejer } : null, error: null } : undefined),
      (navn, args) => {
        m.rpcKald.push({ navn, args });
        return m.rpcSvar;
      },
    ).klient;
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
const { sletFjernedeBilleder } = await import("@/lib/auktionBilledOprydning");

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
  m.rpcSvar = { data: { kode: "ok", stier: [] }, error: null };
  m.rpcKald = [];
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
    expect(m.rpcKald).toEqual([]);
    expect(m.slettet).toEqual([]);
  });

  it("ugyldig krop: 400; ukendt handling: 404", async () => {
    expect((await kald({ auktion_id: AUKTION })).status).toBe(400);
    expect((await kald({ auktion_id: AUKTION, stier: "a" })).status).toBe(400);
    expect((await kald({ auktion_id: AUKTION, stier: Array(21).fill(`${EJER}/a.jpg`) })).status).toBe(400);
    expect((await kald({ auktion_id: AUKTION, stier: [] }, "slet-alt")).status).toBe(404);
  });

  it("databasen afgør for HELE brugeren (p_auktion null); kun dens stier slettes", async () => {
    m.rpcSvar = { data: { kode: "ok", stier: [`${EJER}/gammel.jpg`] }, error: null };
    const r = await kald({ auktion_id: AUKTION, stier: [`${EJER}/gammel.jpg`, `${URL_DEL}${EJER}/i-brug.jpg`] });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(m.rpcKald).toEqual([
      {
        navn: "auktion_billeder_sletbare",
        args: { p_bruger: EJER, p_stier: [`${EJER}/gammel.jpg`, `${EJER}/i-brug.jpg`] },
      },
    ]);
    expect(m.slettet).toEqual([[`${EJER}/gammel.jpg`]]);
  });

  it("åben sag om nogen af brugerens auktioner: 409 sag_aaben, intet slettes", async () => {
    m.rpcSvar = { data: { kode: "sag_aaben" }, error: null };
    const r = await kald({ auktion_id: AUKTION, stier: [`${EJER}/gammel.jpg`] });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      fejl: "Billederne kan ikke slettes lige nu, fordi BidHamr behandler en sag om en af dine auktioner.",
      kode: "sag_aaben",
    });
    expect(m.slettet).toEqual([]);
  });

  it("databasefejl: 500, intet slettes", async () => {
    m.rpcSvar = { data: null, error: { message: "boom" } };
    expect((await kald({ auktion_id: AUKTION, stier: [`${EJER}/gammel.jpg`] })).status).toBe(500);
    expect(m.slettet).toEqual([]);
  });
});

describe("hjemmesidens oprydning", () => {
  it("tjekker også hele brugeren (samme RPC som appen)", async () => {
    m.rpcSvar = { data: { kode: "ok", stier: [`${EJER}/a.jpg`] }, error: null };
    expect(await sletFjernedeBilleder(EJER, [`${URL_DEL}${EJER}/a.jpg`])).toEqual({ kode: "ok", slettet: 1 });
    expect(m.rpcKald[0]).toEqual({ navn: "auktion_billeder_sletbare", args: { p_bruger: EJER, p_stier: [`${EJER}/a.jpg`] } });
    m.rpcSvar = { data: { kode: "sag_aaben" }, error: null };
    expect(await sletFjernedeBilleder(EJER, [`${EJER}/b.jpg`])).toEqual({ kode: "sag_aaben" });
  });
});
