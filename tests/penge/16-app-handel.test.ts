// Scenarie: appens nye endpoints kaldt med en rigtig Bearer-session for
// TEST-brugerne mod TESTdatabasen (ingen pengebevægelser):
//   - POST /api/handel/app/status: køberen og sælgeren får svar, en fremmed
//     får 403 "ikke_part", uden login 401 (JSON).
//   - send-pakke/modtaget som den forkerte part: afvist uden statusskift.
//   - POST /api/bud/app på en afsluttet auktion: databasens afvisning og
//     nøglen frigives; ugyldig krop 400.
//   - RPC'erne fra 20261025010000_app_endpoints.sql som brugeren selv:
//     auktion_budhistorik, mine_kunst_kontrol, auktion_saelger_kan_saelge,
//     handel_chat_marker_laest og antal_ulaeste_handelsbeskeder.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as handelPOST } from "@/app/api/handel/app/[handling]/route";
import { POST as budPOST } from "@/app/api/bud/app/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { FREMMED, KOEBER, SAELGER, type PengeBruger } from "./brugere";
import { logIndSom } from "./session";
import { forberedSaelger, opretHandel, rydOp, type TestHandel } from "./handel";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "127.0.0.251" }),
}));

let h: TestHandel;

async function token(b: PengeBruger): Promise<string> {
  const k = await logIndSom(b.id, b.email);
  const { data } = await k.auth.getSession();
  if (!data.session) throw new Error("ingen session");
  return data.session.access_token;
}

function req(sti: string, krop: Record<string, unknown>, tok: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (tok) headers.authorization = `Bearer ${tok}`;
  return new NextRequest(`http://localhost${sti}`, { method: "POST", body: JSON.stringify(krop), headers });
}

async function handel(handling: string, krop: Record<string, unknown>, b: PengeBruger | null) {
  const res = await handelPOST(req(`/api/handel/app/${handling}`, krop, b ? await token(b) : null), {
    params: Promise.resolve({ handling }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function tradeStatus(): Promise<string> {
  const { data } = await createAdminClient().from("trades").select("status").eq("id", h.tradeId).single<{ status: string }>();
  return data!.status;
}

beforeAll(async () => {
  await forberedSaelger();
  h = await opretHandel({ navn: "app-handel", budOere: 20_000 });
});

afterAll(async () => {
  if (h) await rydOp(h);
});

describe("POST /api/handel/app", () => {
  it("status: køber og sælger; fremmed 403; uden login 401", async () => {
    const k = await handel("status", { trade_id: h.tradeId }, KOEBER);
    expect(k.status).toBe(200);
    expect(k.body.annullering).toBeNull();
    expect(k.body.betaling).toEqual({ sidsteFejl: false });
    expect(k.body.fragt).toEqual({ labelsAktiv: expect.any(Boolean), returlabelAktiv: expect.any(Boolean) });
    const s = await handel("status", { trade_id: h.tradeId }, SAELGER);
    expect(s.status).toBe(200);
    const f = await handel("status", { trade_id: h.tradeId }, FREMMED);
    expect(f.status).toBe(403);
    expect(f.body.kode).toBe("ikke_part");
    const u = await handel("status", { trade_id: h.tradeId }, null);
    expect(u.status).toBe(401);
    expect(u.body.kode).toBe("ikke_logget_ind");
    const ukendt = await handel("status", { trade_id: randomUUID() }, KOEBER);
    expect(ukendt.status).toBe(404);
  });

  it("forkert part og forkert status: afvist, handlen er uændret", async () => {
    const s = await handel("modtaget", { trade_id: h.tradeId }, SAELGER);
    expect(s.status).toBe(403);
    expect(s.body.kode).toBe("ikke_koeber");
    const k = await handel("modtaget", { trade_id: h.tradeId }, KOEBER);
    expect(k.status).toBe(409);
    expect(k.body.kode).toBe("ikke_klar");
    const p = await handel("send-pakke", { trade_id: h.tradeId, tracking: "TEST", billeder: [] }, KOEBER);
    expect(p.status).toBe(403);
    const t = await handel("andenchance-tilbud", { trade_id: h.tradeId }, KOEBER);
    expect(t.status).toBe(403);
    expect(await tradeStatus()).toBe("afventer_betaling");
    expect((await handel("send-pakke", {}, SAELGER)).status).toBe(400);
    expect((await handel("andenchance-svar", {}, KOEBER)).status).toBe(400);
  });
});

describe("POST /api/bud/app", () => {
  it("bud på en afsluttet auktion: databasens afvisning; ugyldig krop 400", async () => {
    const tok = await token(FREMMED);
    const noegle = randomUUID();
    const res = await budPOST(req("/api/bud/app", { auktion_id: h.auktionId, beloeb_oere: 50_000, idempotens_noegle: noegle }, tok));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(409);
    expect(typeof body.fejl).toBe("string");
    expect(typeof body.kode).toBe("string");
    // Nøglen er frigivet igen.
    const { data } = await createAdminClient().from("app_bud_noegler").select("noegle").eq("bruger_id", FREMMED.id).eq("noegle", noegle);
    expect(data).toEqual([]);
    const ugyldig = await budPOST(req("/api/bud/app", { auktion_id: h.auktionId, beloeb_oere: 50_050, idempotens_noegle: randomUUID() }, tok));
    expect(ugyldig.status).toBe(400);
  });
});

describe("RPC'erne som brugeren selv", () => {
  it("auktion_budhistorik, mine_kunst_kontrol og auktion_saelger_kan_saelge", async () => {
    const saelger = await logIndSom(SAELGER.id, SAELGER.email);
    const hist = await saelger.rpc("auktion_budhistorik", { p_auktion: h.auktionId });
    expect(hist.error).toBeNull();
    expect(Array.isArray(hist.data)).toBe(true);
    const kunst = await saelger.rpc("mine_kunst_kontrol", { p_ids: [h.auktionId] });
    expect(kunst.error).toBeNull();
    expect(kunst.data).toEqual([{ auction_id: h.auktionId, kunst_kontrol: null }]);
    const fremmed = await logIndSom(FREMMED.id, FREMMED.email);
    expect((await fremmed.rpc("mine_kunst_kontrol", { p_ids: [h.auktionId] })).data).toEqual([]);
    // Testens auktion er afsluttet og synlig: sælgeren er ikke frosset.
    const kan = await fremmed.rpc("auktion_saelger_kan_saelge", { p_auktion: h.auktionId });
    expect(kan.error).toBeNull();
    expect(kan.data).toBe(true);
    // Ukendt auktion: null (intet om nogen sælger).
    expect((await fremmed.rpc("auktion_saelger_kan_saelge", { p_auktion: randomUUID() })).data).toBeNull();
  });

  it("handelschat: marker læst (kun parterne) og antal ulæste", async () => {
    const koeber = await logIndSom(KOEBER.id, KOEBER.email);
    expect((await koeber.rpc("handel_chat_marker_laest", { p_trade: h.tradeId })).data).toBe(true);
    const antal = await koeber.rpc("antal_ulaeste_handelsbeskeder");
    expect(antal.error).toBeNull();
    expect(typeof antal.data).toBe("number");
    const fremmed = await logIndSom(FREMMED.id, FREMMED.email);
    expect((await fremmed.rpc("handel_chat_marker_laest", { p_trade: h.tradeId })).data).toBe(false);
    // Kan ikke skrive direkte i tabellen.
    const direkte = await fremmed.from("handel_chat_laest").insert({ trade_id: h.tradeId, bruger_id: FREMMED.id });
    expect(direkte.error).not.toBeNull();
    // Ser kun sine egne rækker.
    const egne = await koeber.from("handel_chat_laest").select("bruger_id").eq("trade_id", h.tradeId);
    expect(egne.data).toEqual([{ bruger_id: KOEBER.id }]);
  });
});
