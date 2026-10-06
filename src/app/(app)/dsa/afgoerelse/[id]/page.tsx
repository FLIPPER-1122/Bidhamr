import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserMedToTrin } from "@/lib/mfa";
import { erUuid, tjekDsaToken } from "@/lib/dsa/link";
import KlageFormular from "@/components/dsa/KlageFormular";
import SaetOpIgenKnap from "@/components/dsa/SaetOpIgenKnap";
import Tidslinje, { type Trin } from "@/components/dsa/Tidslinje";
import {
  ANDRE_KLAGEMULIGHEDER,
  GRUNDLAG_NAVNE,
  HANDLING_BRUGER,
  HANDLING_KONSEKVENS,
  KLAGE_UDFALD_NAVNE,
  type DsaHandling,
  nuMs,
} from "@/lib/dsa/regler";

// Begrundelsen for et indgreb (DSA art. 17) og klage over det (art. 20).
// Adgang: indlogget som brugeren, det handler om, ELLER det signerede link fra
// mailen (virker også, når kontoen er suspenderet eller lukket). Viser aldrig
// hvem der har anmeldt, og aldrig medarbejderens navn eller interne noter.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Begrundelse for afgørelse",
  robots: { index: false, follow: false },
};

type Afg = {
  id: string;
  sagsnummer: string;
  bruger_id: string;
  indhold_type: string;
  auktion_id: string | null;
  indhold_tekst: string | null;
  handling: DsaHandling;
  regel_tekst: string;
  grundlag: string;
  fakta: string;
  automatisk_opdaget: boolean;
  automatisk_afgjort: boolean;
  anmeldelse_id: string | null;
  varighed_til: string | null;
  oprettet_kl: string;
  klage_frist_kl: string;
  ophaevet_kl: string | null;
  ophaevet_grund: string | null;
};

type Klage = {
  sagsnummer: string;
  status: string;
  udfald: string | null;
  svar: string | null;
  oprettet_kl: string;
  afgjort_kl: string | null;
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

function Raekke({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-kant py-3 first:border-t-0 sm:grid sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-sm font-medium text-tekst-svag">{titel}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap break-words text-[15px] text-tekst sm:mt-0">{children}</dd>
    </div>
  );
}

export default async function AfgoerelseSide({
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
    .from("dsa_afgoerelser")
    .select(
      "id, sagsnummer, bruger_id, indhold_type, auktion_id, indhold_tekst, handling, regel_tekst, grundlag, fakta, automatisk_opdaget, automatisk_afgjort, anmeldelse_id, varighed_til, oprettet_kl, klage_frist_kl, ophaevet_kl, ophaevet_grund",
    )
    .eq("id", id)
    .maybeSingle<Afg>();
  if (!a) notFound();

  const tokenOk = tjekDsaToken("afgoerelse", id, t);
  if (!tokenOk) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await getUserMedToTrin(supabase);
    if (!user || user.id !== a.bruger_id) notFound();
  }

  const { data: k } = await admin
    .from("dsa_klager")
    .select("sagsnummer, status, udfald, svar, oprettet_kl, afgjort_kl")
    .eq("afgoerelse_id", id)
    .maybeSingle<Klage>();

  // Auktionen: er den synlig, linker vi til den. Er den annulleret
  // (fjernet/stoppet), genåbnes den aldrig (Filip, 6. okt. 2026) - så kan
  // sælgeren sætte varen op igen: med ét klik, når afgørelsen er ophævet
  // eller den blev annulleret automatisk efter 14 dages pause
  // (kan_saette_op_igen), ellers som en ny auktion. Ikke mens den er på
  // pause, og ikke mens en klage er i gang.
  const visAuktion = !!a.auktion_id && a.indhold_type !== "profil";
  const { data: auk } = visAuktion
    ? await admin
        .from("auctions")
        .select("skjult, status")
        .eq("id", a.auktion_id)
        .maybeSingle<{ skjult: boolean; status: string }>()
    : { data: null };
  const annulleret = visAuktion && auk?.status === "annulleret";
  const klageIGang = k?.status === "afventer";
  let saetOp: string | null = null;
  let nyAuktionId: string | null = null;
  if (annulleret && !klageIGang) {
    const { data: kode } = await admin.rpc("kan_saette_op_igen", { p_auction: a.auktion_id });
    saetOp = typeof kode === "string" ? kode : null;
    if (saetOp === "allerede_genopsat") {
      const { data: g } = await admin
        .from("genopsaetninger")
        .select("ny_auction_id")
        .eq("gammel_auction_id", a.auktion_id)
        .maybeSingle<{ ny_auction_id: string }>();
      nyAuktionId = g?.ny_auction_id ?? null;
    }
  }
  const auktionSynlig = visAuktion && !!auk && !auk.skjult && !annulleret;
  const paaPause = visAuktion && !!auk && auk.skjult && auk.status === "aktiv";

  const fristOk = new Date(a.klage_frist_kl).getTime() > nuMs();
  const kanKlage = !k && !a.ophaevet_kl && fristOk;
  const hvordan = a.automatisk_afgjort
    ? "Auktionen havde været på pause i 14 dage uden at blive åbnet igen, og blev derfor annulleret automatisk efter vores regler."
    : a.automatisk_opdaget
    ? "Vores automatiske kontrol markerede indholdet. En medarbejder har vurderet det og truffet afgørelsen."
    : a.anmeldelse_id
      ? "Vi fik en anmeldelse. En medarbejder har vurderet indholdet og truffet afgørelsen."
      : "En medarbejder fandt det ved vores egen gennemgang og har truffet afgørelsen.";

  // Tidslinjen: Afgjort -> Klage -> Klage afgjort (eller Ophævet).
  const trin: Trin[] = [{ titel: "Afgjort", tid: a.oprettet_kl, tilstand: "faerdig" }];
  if (k) {
    trin.push(
      {
        titel: "Klage",
        tid: k.oprettet_kl,
        tekst: k.status === "afventer" ? "En anden medarbejder ser på din klage." : undefined,
        tilstand: k.status === "afventer" ? "aktiv" : "faerdig",
      },
      {
        titel: "Klage afgjort",
        tid: k.afgjort_kl,
        tekst:
          k.status === "afgjort"
            ? `${KLAGE_UDFALD_NAVNE[k.udfald ?? ""] ?? ""}${
                k.udfald === "medhold"
                  ? annulleret
                    ? ". Afgørelsen er ophævet. Auktionen kan ikke åbnes igen, men du kan sætte varen op igen."
                    : ". Afgørelsen er ophævet."
                  : "."
              }`
            : undefined,
        tilstand: k.status === "afgjort" ? "faerdig" : "kommende",
      },
    );
  } else if (a.ophaevet_kl) {
    trin.push({ titel: "Ophævet", tid: a.ophaevet_kl, tilstand: "faerdig" });
  } else if (kanKlage) {
    trin.push({ titel: "Klage", tekst: `Du kan klage senest ${dato(a.klage_frist_kl)}.`, tilstand: "kommende" });
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:py-12">
      <p className="text-sm text-tekst-svag">Sagsnummer {a.sagsnummer}</p>
      <h1 className="mt-1 font-serif text-[26px] leading-tight font-semibold text-tekst sm:text-[32px]">
        {HANDLING_BRUGER[a.handling] ?? "Afgørelse fra BidHamr"}
      </h1>
      <p className="mt-2 text-base text-tekst-daempet">{HANDLING_KONSEKVENS[a.handling]}</p>

      {a.ophaevet_kl && (
        <p className="mt-4 rounded-xl bg-succes-bg p-4 text-sm text-succes-tekst">
          Afgørelsen er ophævet {dato(a.ophaevet_kl)}
          {a.ophaevet_grund === "klage" ? " efter din klage" : ""}.
        </p>
      )}

      <section className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6" aria-labelledby="status-titel">
        <h2 id="status-titel" className="font-serif text-[20px] leading-tight font-semibold text-tekst">
          Status
        </h2>
        <div className="mt-4">
          <Tidslinje trin={trin} />
        </div>
      </section>

      <section className="mt-6 rounded-[14px] border border-kant bg-white px-5 py-2 sm:px-6" aria-label="Begrundelse">
        <dl>
          {a.indhold_tekst && <Raekke titel="Det drejer sig om">{a.indhold_tekst}</Raekke>}
          <Raekke titel="Hvorfor">{a.fakta}</Raekke>
          <Raekke titel="Regel eller lov">
            {a.regel_tekst}
            <span className="mt-0.5 block text-sm text-tekst-svag">{GRUNDLAG_NAVNE[a.grundlag] ?? a.grundlag}</span>
          </Raekke>
          <Raekke titel="Sådan blev det opdaget">{hvordan}</Raekke>
          {a.handling === "konto_suspenderet" && (
            <Raekke titel="Varighed">{a.varighed_til ? `Til ${dato(a.varighed_til)}` : "Indtil videre"}</Raekke>
          )}
          <Raekke titel="Dato">{dato(a.oprettet_kl)}</Raekke>
          {auktionSynlig && (
            <Raekke titel="Auktion">
              <Link href={`/auktion/${a.auktion_id}`} className="font-medium text-groen hover:underline">
                Gå til auktionen
              </Link>
            </Raekke>
          )}
          {paaPause && (
            <Raekke titel="Auktion">
              Auktionen er sat på pause, mens vi kigger på den. Der kan ikke bydes, og den slutter ikke, før den er oppe
              igen.
            </Raekke>
          )}
          {annulleret && klageIGang && (
            <Raekke titel="Auktion">Auktionen er stoppet. Vent på svaret på din klage, før du sætter varen op igen.</Raekke>
          )}
          {annulleret && saetOp === "ok" && (
            <Raekke titel="Auktion">
              <span className="block">
                {a.ophaevet_kl ? "Vi beklager, at vi stoppede din auktion. " : ""}
                Auktionen kan ikke åbnes igen, fordi buddene ikke gælder længere. Du kan sætte varen op igen med ét klik –
                den nye auktion får samme titel, beskrivelse, billeder, startpris og varighed.
              </span>
              <SaetOpIgenKnap auktionId={a.auktion_id!} />
            </Raekke>
          )}
          {annulleret && saetOp === "allerede_genopsat" && (
            <Raekke titel="Auktion">
              <span className="block">Du har sat varen op igen.</span>
              {nyAuktionId && (
                <Link href={`/auktion/${nyAuktionId}`} className="font-medium text-groen hover:underline">
                  Gå til den nye auktion
                </Link>
              )}
            </Raekke>
          )}
          {annulleret && !klageIGang && saetOp !== null && saetOp !== "ok" && saetOp !== "allerede_genopsat" && (
            <Raekke titel="Auktion">
              <span className="block">
                Auktionen er stoppet og kan ikke åbnes igen. Overholder varen vores regler, kan du sætte den op igen som
                en ny auktion.
              </span>
              <Link href="/opret-auktion" className="btn btn-sekundaer mt-3">
                Opret en ny auktion
              </Link>
            </Raekke>
          )}
        </dl>
      </section>

      <section className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6" aria-labelledby="klage-titel">
        <h2 id="klage-titel" className="font-serif text-[20px] leading-tight font-semibold text-tekst">
          {k ? "Din klage" : "Er du uenig?"}
        </h2>
        {k ? (
          <div className="mt-2 space-y-2 text-[15px] text-tekst-daempet">
            <p>
              Sagsnummer {k.sagsnummer} · modtaget {dato(k.oprettet_kl)}
            </p>
            {k.status === "afventer" ? (
              <p>En anden medarbejder end den, der traf afgørelsen, ser på din klage. Du får svar på e-mail.</p>
            ) : (
              <>
                <p className="font-semibold text-tekst">{KLAGE_UDFALD_NAVNE[k.udfald ?? ""] ?? k.udfald}</p>
                {k.svar && <p className="whitespace-pre-wrap">{k.svar}</p>}
                {k.udfald !== "medhold" && <p className="text-sm">{ANDRE_KLAGEMULIGHEDER}</p>}
              </>
            )}
          </div>
        ) : kanKlage ? (
          <>
            <p className="mb-4 mt-2 text-[15px] text-tekst-daempet">
              Du kan klage gratis senest {dato(a.klage_frist_kl)}. Klagen behandles af en anden medarbejder end den, der
              traf afgørelsen.
            </p>
            <KlageFormular type="afgoerelse" id={a.id} token={tokenOk ? t : null} />
          </>
        ) : (
          <p className="mt-2 text-[15px] text-tekst-daempet">
            {a.ophaevet_kl ? "Afgørelsen er ophævet, så der er intet at klage over." : "Fristen for at klage er udløbet."}
          </p>
        )}
        {!k && <p className="mt-4 text-sm text-tekst-svag">{ANDRE_KLAGEMULIGHEDER}</p>}
      </section>

      <p className="mt-6 text-sm text-tekst-svag">
        <Link href="/dsa" className="font-medium text-groen hover:underline">
          Sådan behandler vi anmeldelser og klager
        </Link>
      </p>
    </main>
  );
}
