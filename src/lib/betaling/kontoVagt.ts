import "server-only";

// Vagt over sælgernes Stripe-konti (sikkerhedsnet A, 20261019010000):
//
//   - En udbetaling fra en sælgerkonto, som BidHamr ikke selv har lavet (fx en
//     Instant Payout fra Express Dashboard eller en automatisk udbetaling):
//     sælgeren fryses for nye auktioner, bud på sine auktioner og udbetalinger,
//     alle ventende handler markeres til staff, og chefen får drift-alarm.
//     En negativ udbetaling (Stripe trækker et underskud på kontoen fra
//     sælgerens bank, fx debit_negative_balances) fryser ikke - kun alarm.
//   - Udbetalingsplanen er ikke 'manual' (fx fordi "Allow accounts to manage
//     their payout schedule" har været slået til): planen sættes tilbage,
//     sælgerens udbetalinger fryses, og chefen får drift-alarm.
//
// Frysningen ophæves kun af chefen (Admin → Penge, saelger_frysning_ophaev).
// Chefen kan også selv fryse en sælger (Admin → brugeren, saelger_frys_manuelt).
// Stripes API kan ikke slå Instant Payouts fra pr. konto - det er en
// platformsindstilling (docs/GO-LIVE-STRIPE.md E1).

import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { alarmPrTilfaelde, lukTilfaelde } from "@/lib/betaling/driftTilfaelde";

export type FrysGrund = "fremmed_udbetaling" | "udbetalingsplan";

// Fryser sælgeren og markerer ventende handler (idempotent i databasen).
// Svar: true = frysningen er ny. Fejler frysningen, får chefen drift-alarm, og
// fejlen kastes videre - så webhooken svarer 500, og Stripe prøver igen.
export async function frysSaelger(o: {
  userId: string;
  grund: FrysGrund;
  frysSalg: boolean;
  tekst: string;
}): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient().rpc("saelger_frys_udbetaling", {
      p_saelger: o.userId,
      p_grund: o.grund,
      p_frys_salg: o.frysSalg,
      p_tekst: o.tekst.slice(0, 300),
    });
    if (error) throw new Error(error.message);
    return data === true;
  } catch (err) {
    console.error("frysSaelger fejlede:", o.userId, err);
    await logDriftFejl({
      kilde: "server",
      hvor: "betaling/frysning",
      fejl: `Sælgeren kunne ikke fryses (${o.grund}): ${err instanceof Error ? err.message : String(err)}. Der prøves igen (Stripe sender eventet igen) - frys sælgeren manuelt under Admin → brugeren, hvis alarmen gentager sig.`,
      brugerId: o.userId,
    });
    throw err;
  }
}

// Sætter planen tilbage til manual, fryser udbetalingerne og alarmerer.
// Bruges af kontrollerUdbetalingsplan (account.updated og før hver payout) og
// af den daglige overvågning. Kaster, hvis sælgeren ikke kunne fryses (efter
// alarmen) - webhooken svarer da 500, og Stripe prøver igen; før en payout
// stopper den udbetalingen.
export async function retPlanOgFrys(kontoId: string, userId: string, plan: string | null): Promise<void> {
  let nyPlan: string | null = null;
  let fejl: string | null = null;
  try {
    const rettet = await getStripe().accounts.update(kontoId, {
      settings: { payouts: { schedule: { interval: "manual" } } },
    });
    nyPlan = rettet.settings?.payouts?.schedule?.interval ?? null;
    await createAdminClient()
      .from("betalingsprofiler")
      .update({ connect_udbetalingsplan: nyPlan, connect_plan_ok: nyPlan === "manual" })
      .eq("user_id", userId);
  } catch (err) {
    fejl = err instanceof Error ? err.message : String(err);
  }
  const ny = await frysSaelger({
    userId,
    grund: "udbetalingsplan",
    frysSalg: false,
    tekst: `Sælgerkontoens udbetalingsplan stod til '${plan ?? "ukendt"}' (skal være manuel) - udbetalingerne er frosset, til chefen har set på kontoen`,
  });
  await logDriftFejl({
    kilde: "server",
    hvor: "connect/udbetalingsplan",
    fejl: fejl
      ? `Sælgerkonto ${kontoId} står ikke til manuel udbetaling ('${plan ?? "ukendt"}'), og den kunne ikke sættes tilbage: ${fejl}. Sælgerens udbetalinger er frosset${ny ? "" : " (var allerede frosset)"}.`
      : `Sælgerkonto ${kontoId} havde udbetalingsplan '${plan ?? "ukendt"}' - sat tilbage til '${nyPlan ?? "ukendt"}'. Sælgerens udbetalinger er frosset${ny ? "" : " (var allerede frosset)"}, til chefen har ophævet det under Admin → Penge.`,
    brugerId: userId,
  });
}

// Fremmed udbetaling (payout.created/paid/... som BidHamr ikke har lavet).
// Kaster, hvis sælgeren ikke kunne fryses (webhooken svarer 500 - Stripe
// prøver igen; frysningen er idempotent).
export async function frysVedFremmedUdbetaling(kontoId: string, userId: string, payout: Stripe.Payout): Promise<void> {
  // Negativ udbetaling: Stripe henter et underskud på sælgerens konto fra
  // banken. Ingen penge er gået ud - ingen frysning (spejlUdbetaling alarmerer).
  if (Number(payout.amount) < 0) return;
  const instant = payout.method === "instant";
  const ny = await frysSaelger({
    userId,
    grund: "fremmed_udbetaling",
    frysSalg: true,
    tekst: `Udbetaling ${payout.id}${instant ? " (Instant Payout)" : ""} fra sælgerens Stripe-konto er ikke lavet af BidHamr - sælgeren er frosset, til chefen har set på kontoen`,
  });
  // Alarmen for selve udbetalingen gives af spejlUdbetaling (én pr. payout);
  // her kun, når sælgeren lige er blevet frosset.
  if (!ny) return;
  await logDriftFejl({
    kilde: "server",
    hvor: "betaling/fremmed-udbetaling",
    fejl: `Sælgerkonto ${kontoId}: udbetaling ${payout.id} (${payout.method ?? "standard"}, status '${payout.status}') er IKKE lavet af BidHamr. Sælgeren er frosset (nye auktioner, bud og udbetalinger), og alle ventende handler er markeret til staff. Kontrollér kontoen og saldoen i Stripe, og ophæv frysningen under Admin → Penge, når det er afklaret.`,
    brugerId: userId,
  });
}

// Daglig kontrol af alle sælgerkontis udbetalingsplan (højst 100 pr. kørsel,
// de længst ukontrollerede først). Kaldes af betalingsovervågningen.
//
// Hver konto for sig: en fejl på én konto (Stripe nede, databasefejl) stopper
// ikke de andre. Kontoen får alligevel et nyt tjek-tidspunkt (så den ikke står
// først i køen hver dag og blokerer de andre) og én drift-alarm pr. konto,
// til den er tjekket uden fejl igen. Svar: antal konti, der blev rettet.
export async function kontrollerAllePlaner(): Promise<number> {
  const admin = createAdminClient();
  const graense = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { data, error } = await admin
    .from("betalingsprofiler")
    .select("user_id, stripe_account_id, connect_plan_tjekket_kl")
    .not("stripe_account_id", "is", null)
    .is("connect_frakoblet_kl", null)
    .or(`connect_plan_tjekket_kl.is.null,connect_plan_tjekket_kl.lt."${graense}"`)
    .order("connect_plan_tjekket_kl", { ascending: true, nullsFirst: true })
    .limit(100);
  if (error) {
    // Kolonnen findes ikke endnu (migrationen er ikke kørt).
    if (["42703", "PGRST204"].includes(error.code ?? "")) return 0;
    throw new Error(`kontrollerAllePlaner: ${error.message}`);
  }
  const markerTjekket = async (userId: string) => {
    const { error: e } = await admin
      .from("betalingsprofiler")
      .update({ connect_plan_tjekket_kl: new Date().toISOString() })
      .eq("user_id", userId);
    if (e) console.error("connect_plan_tjekket_kl:", userId, e.message);
  };
  let rettet = 0;
  let fejlede = 0;
  for (const p of data ?? []) {
    const konto = p.stripe_account_id as string;
    const userId = p.user_id as string;
    try {
      let plan: string | null;
      try {
        const a = await getStripe().accounts.retrieve(konto);
        plan = a.settings?.payouts?.schedule?.interval ?? null;
      } catch (err) {
        // Ingen adgang længere (frakoblet): intet at kontrollere.
        if (err instanceof Stripe.errors.StripePermissionError) {
          await markerTjekket(userId);
          continue;
        }
        throw err;
      }
      if (plan && plan !== "manual") {
        await retPlanOgFrys(konto, userId, plan);
        rettet++;
      }
      await markerTjekket(userId);
      await lukTilfaelde(`plan-kontrol-fejl:${konto}`);
    } catch (err) {
      fejlede++;
      console.error("kontrollerAllePlaner: konto fejlede:", konto, err);
      // Back-off: næste forsøg om et døgn (de andre konti kommer først til).
      await markerTjekket(userId);
      await alarmPrTilfaelde({
        noegle: `plan-kontrol-fejl:${konto}`,
        hvor: "connect/udbetalingsplan",
        fejl: `Den daglige kontrol af sælgerkonto ${konto}s udbetalingsplan fejlede: ${err instanceof Error ? err.message : String(err)}. Den prøves igen i morgen - kontrollér kontoen i Stripe, hvis alarmen kommer igen.`,
        brugerId: userId,
      });
    }
  }
  if (fejlede > 0) console.warn(`kontrollerAllePlaner: ${fejlede} konto(er) fejlede, ${rettet} rettet`);
  return rettet;
}
