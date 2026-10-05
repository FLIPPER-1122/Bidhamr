"use server";

// Server actions til /dev/fragt. Kun i udvikling OG mod testdatabasen (fail
// closed) - i produktion gør de intet. Bruger service-role, fordi siden
// simulerer fragtfirmaet.
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { erTestdatabase } from "@/lib/miljoe";
import { adapterFor } from "@/lib/fragt";
import { erPakkestoerrelse, erSporingsType } from "@/lib/fragt/types";
import { signerTestWebhook } from "@/lib/fragt/testFirma";
import {
  findForsendelse,
  koerFragtCron,
  opretUdgaaendeForsendelse,
  registrerForsendelseshaendelse,
} from "@/lib/fragt/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tilbage(besked: string): never {
  redirect(`/dev/fragt?besked=${encodeURIComponent(besked)}`);
}

async function kraevDev() {
  if (process.env.NODE_ENV === "production" || !erTestdatabase()) {
    tilbage("Kun i udvikling mod testdatabasen.");
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) tilbage("Log ind først.");
}

export async function opretTestforsendelse(formData: FormData): Promise<void> {
  await kraevDev();
  const tradeId = String(formData.get("trade_id") ?? "").trim();
  const stoerrelse = String(formData.get("pakkestoerrelse") ?? "");
  if (!UUID.test(tradeId)) tilbage("Ugyldigt handels-id.");
  if (!erPakkestoerrelse(stoerrelse)) tilbage("Vælg en pakkestørrelse.");
  const { data: t } = await createAdminClient()
    .from("trades")
    .select("seller_id")
    .eq("id", tradeId)
    .maybeSingle<{ seller_id: string }>();
  if (!t) tilbage("Handlen findes ikke.");
  // Som sælgeren (det er en testside - i appen kommer id'et fra auth).
  const r = await opretUdgaaendeForsendelse(tradeId, t.seller_id, stoerrelse);
  tilbage("fejl" in r ? `Fejl: ${r.fejl}` : "Testforsendelsen er oprettet.");
}

// "Rykker" pakken frem: indsætter hændelsen i testfirmaets sporing og
// leverer den enten som signeret webhook (samme kode som ruten) eller ved
// at hente sporingen (samme kode som cron).
export async function rykPakke(formData: FormData): Promise<void> {
  await kraevDev();
  const forsendelseId = String(formData.get("forsendelse_id") ?? "");
  const type = String(formData.get("type") ?? "");
  const via = formData.get("via") === "sporing" ? "sporing" : "webhook";
  if (!UUID.test(forsendelseId) || !erSporingsType(type)) tilbage("Ugyldigt valg.");

  const admin = createAdminClient();
  const { data: f } = await admin
    .from("forsendelser")
    .select("id, fragtfirma, sporingsnummer")
    .eq("id", forsendelseId)
    .maybeSingle<{ id: string; fragtfirma: string; sporingsnummer: string | null }>();
  if (!f || f.fragtfirma !== "test" || !f.sporingsnummer) {
    tilbage("Kun forsendelser hos testfragt kan rykkes.");
  }

  const { data: raekke, error } = await admin
    .from("fragt_test_sporing")
    .insert({ sporingsnummer: f.sporingsnummer, type, beskrivelse: `Test: ${type}` })
    .select("id, tidspunkt")
    .single<{ id: string; tidspunkt: string }>();
  if (error || !raekke) tilbage(`Fejl: ${error?.message ?? "ukendt"}`);

  const adapter = adapterFor("test");
  if (!adapter) tilbage("Testfragt er ikke tilladt her.");

  if (via === "webhook") {
    const body = JSON.stringify({
      id: raekke.id,
      sporingsnummer: f.sporingsnummer,
      type,
      tidspunkt: raekke.tidspunkt,
      beskrivelse: `Test: ${type}`,
    });
    const sig = signerTestWebhook(body);
    if (!sig) tilbage("Sæt FRAGT_TEST_WEBHOOK_SECRET (mindst 16 tegn) i .env.local - eller brug 'via sporing'.");
    const req = new Request("http://localhost/api/fragt/webhook/test", {
      method: "POST",
      headers: { "content-type": "application/json", [sig.header]: sig.vaerdi },
      body,
    });
    const res = await adapter.fortolkWebhook(req);
    if (!res.ok) tilbage(`Webhook afvist: ${res.fejl}`);
    let nye = 0;
    for (const h of res.haendelser) {
      const id = await findForsendelse("test", h);
      if (!id) continue;
      if ((await registrerForsendelseshaendelse(id, h, "webhook")).ny) nye++;
    }
    tilbage(`Webhook leveret: ${nye} ny hændelse(r).`);
  }

  const haendelser = await adapter.hentSporing(f.sporingsnummer);
  let nye = 0;
  for (const h of haendelser) {
    if ((await registrerForsendelseshaendelse(f.id, h, "sporing")).ny) nye++;
  }
  tilbage(`Sporing hentet: ${nye} ny hændelse(r).`);
}

export async function koerFragtCronNu(): Promise<void> {
  await kraevDev();
  const r = await koerFragtCron();
  tilbage(`Fragt-cron: ${JSON.stringify(r)}`);
}
