import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import OpretAuktionForm from "@/components/OpretAuktionForm";
import UdbetalingskontoKraeves from "@/components/betaling/UdbetalingskontoKraeves";
import Link from "next/link";
import { FIRMA_OVERSIGT, FIRMA_OVERSIGT_EKSTRA } from "@/lib/tekster/erhverv";
import { naesteLedigeTekst } from "@/lib/erhverv/visning";
import type { Ugekvote } from "@/lib/erhverv/regler";

// Man skal have en udbetalingskonto for at sælge (ROADMAP-BESLUTNINGER,
// "Udbetalingskonto og advarsler fra admin"). Kravet er, at kontoen er
// oprettet og oplysningerne sendt ind hos Stripe – Stripe må gerne stadig
// behandle den. Databasen håndhæver det samme (auctions_kraev_udbetalingskonto).
export const metadata: Metadata = { title: "Opret auktion", robots: { index: false, follow: false } };

export default async function OpretAuktionPage({
  searchParams,
}: {
  searchParams: Promise<{ stripe?: string }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect("/login");
  }

  const { stripe } = await searchParams;

  // Firmakonto? Så gælder ugekvote og abonnement (databasen håndhæver det
  // også, BHE02/BHE03) - vis det her, før firmaet udfylder hele formularen.
  const [{ data: konto }, { data: kvoteData }] = await Promise.all([
    supabase.from("users").select("konto_type").eq("id", data.user.id).maybeSingle<{ konto_type: string | null }>(),
    supabase.rpc("firma_ugekvote"),
  ]);
  const erFirma = konto?.konto_type === "erhverv";
  const kvote = erFirma ? ((kvoteData as Ugekvote | null) ?? null) : null;
  const firmaSpaerret = erFirma && (!kvote || !kvote.aktivt_abonnement || kvote.brugt >= kvote.max);

  // RLS: brugeren kan kun læse sin egen betalingsprofil.
  const { data: profil } = await supabase
    .from("betalingsprofiler")
    // "*": connect_frakoblet_kl findes først efter 20261003060000_connect_status.sql.
    .select("*")
    .eq("user_id", data.user.id)
    .maybeSingle<{
      stripe_account_id: string | null;
      connect_detaljer_indsendt: boolean;
      connect_overfoersler_aktiv: boolean;
      connect_frakoblet_kl?: string | null;
      connect_spaerret_aarsag?: string | null;
    }>();

  const harKonto = !!profil?.stripe_account_id;
  // En lukket/frakoblet udbetalingskonto kan ikke bruges (samme regel som
  // har_udbetalingskonto i databasen).
  const frakoblet = !!profil?.connect_frakoblet_kl;
  // Stripe har afvist kontoen (disabled_reason rejected.*): den kan aldrig
  // modtage penge, så der kan ikke sælges (samme regel i databasen).
  const afvist = !!profil?.connect_spaerret_aarsag?.startsWith("rejected.");
  const kanSaelge = harKonto && !!profil?.connect_detaljer_indsendt && !frakoblet && !afvist;
  const aktiv = kanSaelge && !!profil?.connect_overfoersler_aktiv;

  return (
    <main className="flex flex-1 justify-center px-4 py-8 sm:px-6 lg:py-10">
      <div className="w-full max-w-2xl">
        <h1 className="font-serif text-[26px] font-semibold text-tekst sm:text-[32px]">
          Opret auktion
        </h1>

        <div className="mt-6">
          {firmaSpaerret ? (
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
          ) : frakoblet ? (
            <p className="rounded-lg border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
              Din udbetalingskonto hos vores betalingspartner Stripe er lukket, så du kan ikke sætte
              varer til salg lige nu. Skriv til support@bidhamr.dk, så hjælper vi dig.
            </p>
          ) : afvist ? (
            <p className="rounded-lg border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
              Vores betalingspartner Stripe har afvist din udbetalingskonto, så du kan ikke sætte
              varer til salg. Skriv til support@bidhamr.dk, hvis du har spørgsmål.
            </p>
          ) : kanSaelge && stripe !== "retur" ? (
            <>
              {!aktiv && (
                <p className="mb-6 rounded-lg border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
                  Stripe behandler din udbetalingskonto. Du kan godt sætte varer til salg imens.
                </p>
              )}
              <OpretAuktionForm brugerId={data.user.id} erFirma={erFirma} />
            </>
          ) : (
            <UdbetalingskontoKraeves
              harKonto={harKonto}
              erRetur={stripe === "retur"}
              erFejl={stripe === "fejl"}
            />
          )}
        </div>
      </div>
    </main>
  );
}
