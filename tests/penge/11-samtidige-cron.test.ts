// Scenarie: to betalings-cron-kørsler (og en webhook) prøver at udbetale de
// samme frigivne handler på samme tid. Der må kun komme ÉN payout hos Stripe,
// og handlerne samles i den.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { udbetalForKonto, udbetalVentende } from "@/lib/betaling/udbetaling";
import {
  admin,
  betal,
  betaling,
  forberedSaelger,
  koeberGodkenderUdenUdbetaling,
  opretHandel,
  rydOp,
  saelgerUdbetaling,
  stripe,
  afslutPayout,
  type TestHandel,
} from "./handel";

let a: TestHandel;
let b: TestHandel;
let konto: string;

beforeAll(async () => {
  konto = await forberedSaelger();
  a = await opretHandel({ navn: "samtidig-a", budOere: 4_000 });
  b = await opretHandel({ navn: "samtidig-b", budOere: 6_000 });
  await betal(a);
  await betal(b);
  await koeberGodkenderUdenUdbetaling(a);
  await koeberGodkenderUdenUdbetaling(b);
});

afterAll(async () => {
  for (const h of [a, b]) if (h) await rydOp(h);
});

describe("to samtidige cron-kørsler", () => {
  it("giver én payout med begge handler", async () => {
    const foer = await stripe().payouts.list({ limit: 100 }, { stripeAccount: konto });
    const r = await Promise.allSettled([
      udbetalVentende(a.saelger.id),
      udbetalVentende(a.saelger.id),
      udbetalForKonto(konto),
    ]);
    expect(r.every((x) => x.status === "fulfilled")).toBe(true);
    const ba = await betaling(a.betalingId);
    const bb = await betaling(b.betalingId);
    expect(ba.saelger_udbetaling_id).toBeTruthy();
    expect(ba.saelger_udbetaling_id).toBe(bb.saelger_udbetaling_id);
    const u = await saelgerUdbetaling(ba.saelger_udbetaling_id!);
    expect(u.beloeb_oere).toBe(3_800 + 5_700);
    const efter = await stripe().payouts.list({ limit: 100 }, { stripeAccount: konto });
    const nye = efter.data.filter((p) => !foer.data.some((f) => f.id === p.id));
    expect(nye.length).toBe(1);
    expect(nye[0].amount).toBe(9_500);
    const { count } = await admin()
      .from("saelger_udbetalinger")
      .select("id", { count: "exact", head: true })
      .or(`betaling_ids.cs.{${a.betalingId}},betaling_ids.cs.{${b.betalingId}}`);
    expect(count).toBe(1);
    expect(await afslutPayout(konto, u.id)).toBe("paid");
  });

  it("en kørsel bagefter laver ingen ny payout", async () => {
    const foer = await stripe().payouts.list({ limit: 100 }, { stripeAccount: konto });
    await udbetalVentende(a.saelger.id);
    const efter = await stripe().payouts.list({ limit: 100 }, { stripeAccount: konto });
    expect(efter.data.length).toBe(foer.data.length);
  });
});
