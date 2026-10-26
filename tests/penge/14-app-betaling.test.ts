// Scenarie: appens betalings-endpoints (POST /api/betaling/app/<handling>)
// kaldt med en rigtig Bearer-session for TEST-brugerne: gem kort (SetupIntent)
// -> betal (destination charge, 3DS, samme PaymentIntent ved gentagelse, gemt
// kort forudfylder kun) -> webhook -> "allerede betalt" -> fuld refusion
// (sluttilstand). Desuden: uden login, fremmed bruger, fjern kort,
// udbetalingskonto (onboarding-link med app-retur) og retur-redirecten.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/betaling/app/[handling]/route";
import { GET as returGET } from "@/app/api/betaling/app/retur/route";
import { egenDatabase } from "@/lib/betaling/fremmedeTestdata";
import { FREMMED, KOEBER, type PengeBruger } from "./brugere";
import { logIndSom } from "./session";
import {
  betaling,
  forberedSaelger,
  forventet,
  fuldRefusion,
  leverBetalingsWebhooks,
  opretHandel,
  piId,
  rydOp,
  stripe,
  udenTvungen3ds,
  type TestHandel,
} from "./handel";

// klientIp() læser next/headers, som kun findes i en Next-forespørgsel.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "127.0.0.250" }),
}));

let h: TestHandel;
let konto: string;
// Bud 300 kr.: købergebyr 7 % + 5 = 26 kr., sælgergebyr 5 % + 5 = 20 kr.,
// fragt 42 kr. -> total 368 kr., gebyr 88 kr.
const X = forventet(30_000);

async function token(b: PengeBruger): Promise<string> {
  const k = await logIndSom(b.id, b.email);
  const { data } = await k.auth.getSession();
  if (!data.session) throw new Error("ingen session");
  return data.session.access_token;
}

async function kald(handling: string, krop: Record<string, unknown>, bruger: PengeBruger | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bruger) headers.authorization = `Bearer ${await token(bruger)}`;
  const req = new NextRequest(`http://localhost/api/betaling/app/${handling}`, {
    method: "POST",
    body: JSON.stringify(krop),
    headers,
  });
  const res = await POST(req, { params: Promise.resolve({ handling }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  konto = await forberedSaelger();
  h = await opretHandel({ navn: "app-betaling", budOere: 30_000 });
});

afterAll(async () => {
  if (h) await rydOp(h);
  // Køberens gemte kort fjernes altid igen (andre testfiler forventer intet kort).
  await kald("fjern-kort", {}, KOEBER).catch(() => null);
});

describe("appens betalings-endpoints", () => {
  it("uden login: 401, og en fremmed kan ikke betale andres handel", async () => {
    const a = await kald("betal", { trade_id: h.tradeId }, null);
    expect(a.status).toBe(401);
    expect(a.body.kode).toBe("ikke_logget_ind");
    const f = await kald("betal", { trade_id: h.tradeId }, FREMMED);
    expect(f.status).toBe(404);
    expect(f.body.kode).toBe("ikke_fundet");
    expect((await betaling(h.betalingId)).stripe_payment_intent_id).toBeNull();
    const u = await kald("findes-ikke", {}, KOEBER);
    expect(u.status).toBe(404);
  });

  it("gem kort: SetupIntent (on_session, kort) + kundesession til PaymentSheet, bekræft", async () => {
    const g = await kald("gem-kort", {}, KOEBER);
    expect(g.status).toBe(200);
    expect(String(g.body.clientSecret)).toMatch(/^seti_/);
    expect(String(g.body.customerId)).toMatch(/^cus_/);
    expect(g.body.customerSessionClientSecret).toBeTruthy();
    expect(String(g.body.publishableKey)).toMatch(/^pk_test_/);
    const siId = String(g.body.clientSecret).split("_secret_")[0];
    const si = await stripe().setupIntents.retrieve(siId);
    expect(si.usage).toBe("on_session");
    expect(si.payment_method_types).toEqual(["card"]);
    // Appen bekræfter i PaymentSheet - her med testkortet.
    await stripe().setupIntents.confirm(siId, { payment_method: "pm_card_visa" });
    const b = await kald("bekraeft-kort", { setup_intent_id: siId }, KOEBER);
    expect(b.status).toBe(200);
    expect((b.body.gemtKort as { sidste4: string }).sidste4).toBe("4242");
    // En fremmed kan ikke registrere køberens SetupIntent.
    const f = await kald("bekraeft-kort", { setup_intent_id: siId }, FREMMED);
    expect(f.status).toBe(409);
  });

  it("betal: destination charge, application fee, 3DS, metadata - og samme PaymentIntent igen", async () => {
    const s = await kald("betal", { trade_id: h.tradeId }, KOEBER);
    expect(s.status).toBe(200);
    // bud 300 + gebyr 26 + fragt 42 = 368 kr.
    expect(X.total).toBe(36_800);
    expect(s.body.totalOere).toBe(X.total);
    expect(String(s.body.publishableKey)).toMatch(/^pk_test_/);
    expect(String(s.body.customerId)).toMatch(/^cus_/);
    // Gemt kort: kun en kundesession (forudfylder) - ingen ephemeral key.
    expect(s.body.customerSessionClientSecret).toBeTruthy();
    expect(s.body).not.toHaveProperty("ephemeralKey");
    const id = piId(String(s.body.clientSecret));
    const pi = await stripe().paymentIntents.retrieve(id);
    expect(pi.on_behalf_of).toBe(konto);
    expect(pi.transfer_data?.destination).toBe(konto);
    // købergebyr 26 + sælgergebyr 20 + fragt 42
    expect(X.gebyr).toBe(8_800);
    expect(pi.application_fee_amount).toBe(X.gebyr);
    expect(pi.customer).toBe(s.body.customerId);
    expect(pi.setup_future_usage ?? null).toBeNull();
    expect(pi.metadata.handel_id).toBe(h.tradeId);
    if (egenDatabase()) expect(pi.metadata.bidhamr_db).toBe(egenDatabase());
    // Gentaget kald: samme PaymentIntent.
    const igen = await kald("betal", { trade_id: h.tradeId }, KOEBER);
    expect(piId(String(igen.body.clientSecret))).toBe(id);

    // Køberen betaler (PaymentSheet) - testkort, 3DS slået fra kun her.
    await udenTvungen3ds(id);
    await stripe().paymentIntents.confirm(id, {
      payment_method: "pm_card_bypassPending",
      return_url: "https://bidhamr.dk/test-betaling",
    });
    await leverBetalingsWebhooks(await stripe().paymentIntents.retrieve(id));
    expect((await betaling(h.betalingId)).status).toBe("betalt");
    const betalt = await kald("betal", { trade_id: h.tradeId }, KOEBER);
    expect(betalt.status).toBe(409);
    expect(betalt.body.kode).toBe("betalt");

    // Sluttilstand: fuld refusion (som 03).
    const r = await fuldRefusion(h);
    expect(r.resultat).toBe("refunderet");
  });

  it("fjern kort", async () => {
    const f = await kald("fjern-kort", {}, KOEBER);
    expect(f.status).toBe(200);
    const i = await kald("indstillinger", {}, KOEBER);
    expect(i.body.gemtKort).toBeNull();
  });

  it("udbetalingskonto: onboarding-link, status og Stripe-oversigt", async () => {
    const u = await kald("udbetalingskonto", {}, FREMMED);
    expect(u.status).toBe(200);
    expect(String(u.body.url)).toMatch(/^https:\/\/connect\.stripe\.com\//);
    const s = await kald("udbetalingskonto-status", {}, FREMMED);
    expect(s.status).toBe(200);
    expect((s.body.saelger as { harKonto: boolean }).harKonto).toBe(true);
    const o = await kald("stripe-oversigt", {}, FREMMED);
    expect(o.status).toBe(409);
    expect(o.body.kode).toBe("afvist");
  });

  it("retur fra Stripe sender videre til appens deep link", async () => {
    for (const [status, forventet] of [
      ["retur", "retur"],
      ["udloebet", "udloebet"],
      ["https://ond.example", "retur"],
    ]) {
      const res = await returGET(new NextRequest(`http://localhost/api/betaling/app/retur?status=${encodeURIComponent(status)}`));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`bidhamr://udbetalingskonto?status=${forventet}`);
    }
  });
});
