// Scenarie: udbetalingen til sælgerens bank fejler (testbankkonto, der ikke
// findes - payout.failed). Pengene står igen på sælgerens Stripe-konto,
// sælgeren "venter på bank", og der udbetales ikke igen, før bankkontoen er
// rettet. Når sælgeren har rettet den, sendes pengene igen - én gang.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { udbetalVentende } from "@/lib/betaling/udbetaling";
import {
  admin,
  betal,
  betaling,
  forberedSaelger,
  koeberGodkender,
  opretHandel,
  rydOp,
  saelgerUdbetaling,
  saldo,
  sendWebhook,
  stripe,
  ventPaa,
  ventPaaPayout,
  type TestHandel,
} from "./handel";
import { SAELGER_BANK_FEJLER } from "./brugere";

let h: TestHandel;
let konto: string;
let foersteUdbetaling: string;

beforeAll(async () => {
  konto = await forberedSaelger(SAELGER_BANK_FEJLER);
  h = await opretHandel({ navn: "payout-fejlet", budOere: 5_000, saelger: SAELGER_BANK_FEJLER });
});

afterAll(async () => {
  if (h) await rydOp(h);
});

describe("payout.failed", () => {
  it("udbetalingen sendes og fejler hos banken", async () => {
    await betal(h);
    expect(await koeberGodkender(h)).toEqual({ ok: true });
    const b = await betaling(h.betalingId);
    foersteUdbetaling = b.saelger_udbetaling_id!;
    const u = await saelgerUdbetaling(foersteUdbetaling);
    const p = await ventPaaPayout(konto, u.stripe_payout_id!, 240_000);
    expect(p.status).toBe("failed");
    expect((await sendWebhook("payout.failed", p as unknown as { id: string }, { konto })).status).toBe(200);
    expect((await saelgerUdbetaling(foersteUdbetaling)).status).toBe("failed");
    const efter = await betaling(h.betalingId);
    // Betalingen er frigjort igen (pengene er tilbage på kontoen).
    expect(efter.saelger_udbetaling_id).toBeNull();
    const { data: profil } = await admin()
      .from("betalingsprofiler")
      .select("connect_udbetaling_fejlet_kl")
      .eq("user_id", SAELGER_BANK_FEJLER.id)
      .single<{ connect_udbetaling_fejlet_kl: string | null }>();
    expect(profil?.connect_udbetaling_fejlet_kl).toBeTruthy();
    const s = await ventPaa(() => saldo(konto), (x) => x.tilgaengelig >= 4_750, 120_000);
    expect(s.tilgaengelig).toBeGreaterThanOrEqual(4_750);
  });

  it("samme event igen og cron'en: ingen ny udbetaling til den fejlede bank", async () => {
    const u = await saelgerUdbetaling(foersteUdbetaling);
    const p = await stripe().payouts.retrieve(u.stripe_payout_id!, undefined, { stripeAccount: konto });
    expect((await sendWebhook("payout.failed", p as unknown as { id: string }, { konto })).status).toBe(200);
    await udbetalVentende(SAELGER_BANK_FEJLER.id);
    expect((await betaling(h.betalingId)).saelger_udbetaling_id).toBeNull();
    const payouts = await stripe().payouts.list({ limit: 100 }, { stripeAccount: konto });
    expect(payouts.data.length).toBe(1);
  });

  it("sælgeren retter bankkontoen: pengene sendes igen, én gang", async () => {
    const ny = await stripe().accounts.createExternalAccount(konto, {
      external_account: {
        object: "bank_account",
        country: "DK",
        currency: "dkk",
        account_number: "DK5000400440116243",
      },
      default_for_currency: true,
    });
    expect((await sendWebhook("account.external_account.created", ny as unknown as { id: string }, { konto })).status).toBe(200);
    const b = await ventPaa(
      () => betaling(h.betalingId),
      (x) => !!x.saelger_udbetaling_id,
      30_000,
    );
    expect(b.saelger_udbetaling_id).toBeTruthy();
    expect(b.saelger_udbetaling_id).not.toBe(foersteUdbetaling);
    const u = await saelgerUdbetaling(b.saelger_udbetaling_id!);
    const p = await ventPaaPayout(konto, u.stripe_payout_id!);
    expect(p.status).toBe("paid");
    expect((await sendWebhook("payout.paid", p as unknown as { id: string }, { konto })).status).toBe(200);
    expect((await saelgerUdbetaling(u.id)).status).toBe("paid");
    const payouts = await stripe().payouts.list({ limit: 100 }, { stripeAccount: konto });
    expect(payouts.data.filter((x) => x.status === "paid").length).toBe(1);
  });
});
