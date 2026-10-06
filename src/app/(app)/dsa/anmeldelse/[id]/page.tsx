import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserMedToTrin } from "@/lib/mfa";
import { erUuid, tjekDsaToken } from "@/lib/dsa/link";
import KlageFormular from "@/components/dsa/KlageFormular";
import {
  ANDRE_KLAGEMULIGHEDER,
  KLAGE_UDFALD_NAVNE,
  UDFALD_NAVNE,
  anmeldKategoriNavn,
  indholdNavn,
  nuMs,
} from "@/lib/dsa/regler";

// Status på en anmeldelse (DSA art. 16) for den, der har anmeldt, og klage
// over afgørelsen (art. 20). Adgang: indlogget som anmelderen ELLER det
// signerede link fra kvitteringen. Viser aldrig oplysninger om den anmeldte.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Din anmeldelse",
  robots: { index: false, follow: false },
};

type Anm = {
  id: string;
  sagsnummer: string;
  indhold_type: string;
  placering: string;
  kategori: string;
  status: string;
  udfald: string | null;
  svar_til_anmelder: string | null;
  anmelder_id: string | null;
  behandlet_kl: string | null;
  genaabnet_kl: string | null;
  anonymiseret_kl: string | null;
  oprettet_kl: string;
};

const dato = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default async function AnmeldelseSide({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { id } = await params;
  const { t } = await searchParams;
  if (!erUuid(id)) notFound();

  const admin = createAdminClient();
  const { data: a } = await admin
    .from("dsa_anmeldelser")
    .select(
      "id, sagsnummer, indhold_type, placering, kategori, status, udfald, svar_til_anmelder, anmelder_id, behandlet_kl, genaabnet_kl, anonymiseret_kl, oprettet_kl",
    )
    .eq("id", id)
    .maybeSingle<Anm>();
  if (!a || a.anonymiseret_kl) notFound();

  const tokenOk = tjekDsaToken("anmeldelse", id, t);
  if (!tokenOk) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await getUserMedToTrin(supabase);
    if (!user || !a.anmelder_id || user.id !== a.anmelder_id) notFound();
  }

  const { data: k } = await admin
    .from("dsa_klager")
    .select("sagsnummer, status, udfald, svar, oprettet_kl")
    .eq("anmeldelse_id", id)
    .maybeSingle<{ sagsnummer: string; status: string; udfald: string | null; svar: string | null; oprettet_kl: string }>();

  const afgjort = a.status === "afgjort";
  const kanKlage =
    afgjort &&
    a.udfald !== "indgreb" &&
    !k &&
    !!a.behandlet_kl &&
    nuMs() < new Date(a.behandlet_kl).getTime() + 182 * 24 * 3600 * 1000;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:py-12">
      <p className="text-sm text-tekst-svag">Sagsnummer {a.sagsnummer}</p>
      <h1 className="mt-1 font-serif text-[26px] leading-tight font-semibold text-tekst sm:text-[32px]">
        Din anmeldelse
      </h1>

      <section className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6" aria-label="Status">
        <dl className="space-y-3 text-[15px]">
          <div>
            <dt className="text-sm font-medium text-tekst-svag">Status</dt>
            <dd className="mt-0.5 font-semibold text-tekst">
              {afgjort ? (UDFALD_NAVNE[a.udfald ?? ""] ?? "Afgjort") : a.genaabnet_kl ? "Bliver behandlet igen" : "Bliver behandlet"}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-tekst-svag">Hvad du anmeldte</dt>
            <dd className="mt-0.5 break-words text-tekst">
              {indholdNavn(a.indhold_type)} · {anmeldKategoriNavn(a.kategori)}
              <span className="block text-sm text-tekst-svag">{a.placering}</span>
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-tekst-svag">Modtaget</dt>
            <dd className="mt-0.5 text-tekst">{dato(a.oprettet_kl)}</dd>
          </div>
          {afgjort && a.behandlet_kl && (
            <div>
              <dt className="text-sm font-medium text-tekst-svag">Afgjort</dt>
              <dd className="mt-0.5 text-tekst">{dato(a.behandlet_kl)}</dd>
            </div>
          )}
          {afgjort && a.svar_til_anmelder && (
            <div>
              <dt className="text-sm font-medium text-tekst-svag">Vores svar</dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-words text-tekst">{a.svar_til_anmelder}</dd>
            </div>
          )}
        </dl>
        {!afgjort && (
          <p className="mt-4 text-sm text-tekst-daempet">
            En medarbejder ser på din anmeldelse. Du får besked, når vi har taget stilling.
          </p>
        )}
      </section>

      {(k || kanKlage) && (
        <section className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6" aria-labelledby="klage-titel">
          <h2 id="klage-titel" className="font-serif text-[20px] leading-tight font-semibold text-tekst">
            {k ? "Din klage" : "Er du uenig i vores afgørelse?"}
          </h2>
          {k ? (
            <div className="mt-2 space-y-2 text-[15px] text-tekst-daempet">
              <p>
                Sagsnummer {k.sagsnummer} · modtaget {dato(k.oprettet_kl)}
              </p>
              {k.status === "afventer" ? (
                <p>En anden medarbejder ser på din klage. Du får svar på mail.</p>
              ) : (
                <>
                  <p className="font-semibold text-tekst">{KLAGE_UDFALD_NAVNE[k.udfald ?? ""] ?? k.udfald}</p>
                  {k.svar && <p className="whitespace-pre-wrap">{k.svar}</p>}
                </>
              )}
            </div>
          ) : (
            <>
              <p className="mb-4 mt-2 text-[15px] text-tekst-daempet">
                Du kan klage gratis inden for 6 måneder. Klagen behandles af en anden medarbejder.
              </p>
              <KlageFormular type="anmeldelse" id={a.id} token={tokenOk ? t : null} />
            </>
          )}
          <p className="mt-4 text-sm text-tekst-svag">{ANDRE_KLAGEMULIGHEDER}</p>
        </section>
      )}

      <p className="mt-6 text-sm text-tekst-svag">
        <Link href="/dsa" className="font-medium text-groen hover:underline">
          Sådan behandler vi anmeldelser og klager
        </Link>
      </p>
    </main>
  );
}
