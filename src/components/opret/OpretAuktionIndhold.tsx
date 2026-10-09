import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { hentKontoType } from "@/lib/supabase/bruger";
import OpretAuktionForm from "@/components/OpretAuktionForm";
import UdbetalingskontoKraeves from "@/components/betaling/UdbetalingskontoKraeves";
import { FIRMA_OVERSIGT, FIRMA_OVERSIGT_EKSTRA } from "@/lib/tekster/erhverv";
import { naesteLedigeTekst } from "@/lib/erhverv/visning";
import type { Ugekvote } from "@/lib/erhverv/regler";

// Indholdet af "Opret auktion" - fælles for /opret-auktion (private) og
// /firma/auktioner/ny (firma-dashboardet), så tjek og formular ikke kopieres.
//
// Man skal have en udbetalingskonto for at sælge (ROADMAP-BESLUTNINGER,
// "Udbetalingskonto og advarsler fra admin"). Kravet er, at kontoen er
// oprettet og oplysningerne sendt ind hos Stripe – Stripe må gerne stadig
// behandle den. Databasen håndhæver det samme (auctions_kraev_udbetalingskonto).
export default async function OpretAuktionIndhold({ brugerId, stripe }: { brugerId: string; stripe?: string }) {
  const supabase = await createClient();

  // Firmakonto? Så gælder ugekvote og abonnement (databasen håndhæver det
  // også, BHE02/BHE03) - vis det her, før firmaet udfylder hele formularen.
  const [kontoType, { data: kvoteData }, { data: profil }] = await Promise.all([
    hentKontoType(brugerId),
    supabase.rpc("firma_ugekvote"),
    // RLS: brugeren kan kun læse sin egen betalingsprofil.
    supabase
      .from("betalingsprofiler")
      // "*": connect_frakoblet_kl findes først efter 20261003060000_connect_status.sql.
      .select("*")
      .eq("user_id", brugerId)
      .maybeSingle<{
        stripe_account_id: string | null;
        connect_detaljer_indsendt: boolean;
        connect_overfoersler_aktiv: boolean;
        connect_frakoblet_kl?: string | null;
        connect_spaerret_aarsag?: string | null;
        connect_betalingsmetoder?: Record<string, string> | null;
        saelger_frosset_kl?: string | null;
      }>(),
  ]);
  const erFirma = kontoType === "erhverv";
  const kvote = erFirma ? ((kvoteData as Ugekvote | null) ?? null) : null;
  const firmaSpaerret = erFirma && (!kvote || !kvote.aktivt_abonnement || kvote.brugt >= kvote.max);

  const harKonto = !!profil?.stripe_account_id;
  // En lukket/frakoblet udbetalingskonto kan ikke bruges (samme regel som
  // har_udbetalingskonto i databasen).
  const frakoblet = !!profil?.connect_frakoblet_kl;
  // Stripe har afvist kontoen (disabled_reason rejected.*): den kan aldrig
  // modtage penge, så der kan ikke sælges (samme regel i databasen).
  const afvist = !!profil?.connect_spaerret_aarsag?.startsWith("rejected.");
  // Frosset (kontoen blev ikke godkendt i tide - 20261011020000, BHU02).
  const frosset = !!profil?.saelger_frosset_kl;
  // Databasen kræver også, at kortbetaling er anmodet på kontoen
  // (har_udbetalingskonto, 20261011050000) - ellers skal opsætningen
  // fortsættes hos Stripe.
  const kortAnmodet = !!profil?.connect_betalingsmetoder && "card_payments" in profil.connect_betalingsmetoder;
  const kanSaelge = harKonto && !!profil?.connect_detaljer_indsendt && kortAnmodet && !frakoblet && !afvist && !frosset;
  const aktiv = kanSaelge && !!profil?.connect_overfoersler_aktiv;

  if (firmaSpaerret) {
    return (
      <div className="rounded-[14px] border border-advarsel-kant bg-advarsel-bg p-5 text-advarsel-tekst">
        <p className="text-[18px] font-semibold">
          {!kvote || !kvote.aktivt_abonnement
            ? FIRMA_OVERSIGT_EKSTRA.kanIkkeOpretteIkkeAktiv
            : FIRMA_OVERSIGT.auktioner.alleBrugt(naesteLedigeTekst(kvote))}
        </p>
        <Link href="/firma" className="btn btn-sekundaer btn-stor mt-4 text-[17px]">
          {FIRMA_OVERSIGT.titel}
        </Link>
      </div>
    );
  }
  if (frakoblet) {
    return (
      <p className="rounded-lg border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
        Din udbetalingskonto hos vores betalingspartner Stripe er lukket, så du kan ikke sætte
        varer til salg lige nu. Skriv til support@bidhamr.dk, så hjælper vi dig.
      </p>
    );
  }
  if (frosset) {
    return (
      <p className="rounded-lg border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
        Din udbetalingskonto er ikke godkendt af vores betalingspartner Stripe, så du kan ikke sætte
        varer til salg lige nu. Gør opsætningen færdig under{" "}
        <Link href="/konto#udbetaling" className="font-medium underline">
          Min konto
        </Link>
        . Du kan sætte varer til salg igen, når Stripe har godkendt kontoen.
      </p>
    );
  }
  if (afvist) {
    return (
      <p className="rounded-lg border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
        Vores betalingspartner Stripe har afvist din udbetalingskonto, så du kan ikke sætte
        varer til salg. Skriv til support@bidhamr.dk, hvis du har spørgsmål.
      </p>
    );
  }
  if (kanSaelge && stripe !== "retur") {
    return (
      <>
        {!aktiv && (
          <p className="mb-6 rounded-lg border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
            Stripe behandler din udbetalingskonto. Du kan godt sætte varer til salg imens.
          </p>
        )}
        <OpretAuktionForm brugerId={brugerId} erFirma={erFirma} />
      </>
    );
  }
  return (
    <UdbetalingskontoKraeves
      harKonto={harKonto}
      erRetur={stripe === "retur"}
      erFejl={stripe === "fejl"}
      erFirma={erFirma}
    />
  );
}
