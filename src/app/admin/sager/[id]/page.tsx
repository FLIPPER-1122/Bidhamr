import Link from "next/link";
import { notFound } from "next/navigation";
import { getStaffRole, harMindstRolle } from "@/lib/adminAuth";
import { hentSag } from "@/app/actions/adminSager";
import { hentSamtalerForSag } from "@/app/actions/staffChat";
import { SAG_CHAT_TYPE, SAG_KATEGORI_NAVN, SAG_STATUS_NAVN, SAG_TYPE_NAVN } from "@/lib/sager";
import { kroner } from "@/lib/kroner";
import HandelStatusBadge, { statusLabel } from "@/components/HandelStatusBadge";
import StaffSamtaleListe from "@/components/admin/staffchat/StaffSamtaleListe";
import FaellesbeskedKnap from "@/components/admin/staffchat/FaellesbeskedKnap";
import SagHandlinger from "@/components/admin/sager/SagHandlinger";
import { BeskyttelseBadge, SagBilleder, SagStatusBadge, sagTid } from "@/components/sager/visning";

// Navne på handlingerne i moderation_log for sager.
const LOG_NAVN: Record<string, string> = {
  sag_afgjort_koeber: "Medhold til køber",
  sag_afgjort_saelger: "Medhold til sælger",
  sag_lukket: "Sagen er lukket",
  sag_retur_afleveret: "Returpakke afleveret",
  sag_genaabnet: "Sagen er genåbnet",
  konto_lukket: "Konto lukket permanent",
};

function logNavn(h: string) {
  return LOG_NAVN[h] ?? h.replace(/_/g, " ");
}

function Kort({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
      <h2 className="mb-3 text-base font-semibold text-neutral-900">{titel}</h2>
      {children}
    </section>
  );
}

function Felt({ navn, children }: { navn: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase text-neutral-500">{navn}</dt>
      <dd className="mt-0.5 break-words text-neutral-800">{children}</dd>
    </div>
  );
}

const BETALING_STATUS: Record<string, string> = {
  afventer: "Afventer betaling",
  behandles: "Behandles",
  betalt: "Betalt",
  annulleret: "Annulleret",
  refunderet: "Refunderet",
};

const jaNej = (v: boolean) => (v ? "Ja" : "Nej");

export default async function AdminSag({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [res, samtalerRes, rolle] = await Promise.all([
    hentSag(id),
    hentSamtalerForSag(SAG_CHAT_TYPE, id),
    getStaffRole(),
  ]);
  if ("fejl" in res) {
    if (res.fejl === "Sagen findes ikke.") notFound();
    throw new Error(res.fejl);
  }
  const { sag } = res;
  const b = sag.betaling;
  const kanSkriveFaelles = rolle ? harMindstRolle(rolle, "admin") : false;
  const koeberNavn = sag.koeber.navn ?? "Uden navn";
  const saelgerNavn = sag.saelger.navn ?? "Uden navn";

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <Link
        href="/admin/sager"
        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-800"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Alle sager
      </Link>

      {/* Overblik og handlinger */}
      <section className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <SagStatusBadge status={sag.status} />
          {sag.beskyttelse && <BeskyttelseBadge />}
          {sag.genaabnetAntal > 0 && (
            <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700">
              Genåbnet {sag.genaabnetAntal} {sag.genaabnetAntal === 1 ? "gang" : "gange"}
            </span>
          )}
        </div>
        <h1 className="mt-2 break-words text-xl font-bold text-neutral-900 sm:text-2xl">
          {sag.auktionTitel ?? "(slettet auktion)"}
        </h1>
        <p className="mt-1 text-sm text-neutral-700">{SAG_TYPE_NAVN[sag.type]}</p>
        <p className="mt-1 text-sm text-neutral-500">
          {SAG_STATUS_NAVN[sag.status]} · Oprettet {sagTid(sag.oprettetKl)}
        </p>

        {b?.indsigelse && (
          <p className="mt-3 rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2 text-sm text-advarsel-tekst">
            Køberen har en åben indsigelse hos sin bank. Pengene kan ikke flyttes, før den er afgjort.
          </p>
        )}
        {b?.kraeverOpmaerksomhed && (
          <p className="mt-3 rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
            Betalingen kræver opmærksomhed. Se{" "}
            <Link href="/admin/betalinger" className="font-semibold underline">
              Betalinger
            </Link>
            .
          </p>
        )}

        <div className="mt-4">
          <SagHandlinger
            sagId={sag.id}
            type={sag.type}
            indsigelse={!!b?.indsigelse}
            kan={sag.kan}
            koeber={{ id: sag.koeber.id, navn: koeberNavn, lukket: sag.koeberLukket }}
            saelger={{ id: sag.saelger.id, navn: saelgerNavn, lukket: sag.saelgerLukket }}
          />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Kort titel="Køberens beskrivelse">
          <p className="whitespace-pre-wrap break-words text-sm text-neutral-800">{sag.beskrivelse}</p>
        </Kort>

        <Kort titel="Afgørelse">
          {sag.begrundelse || sag.internNote || sag.afgjortKl ? (
            <dl className="space-y-3 text-sm">
              {sag.afgjortKl && (
                <Felt navn="Afgjort">
                  {sagTid(sag.afgjortKl)} af {sag.afgjortAfNavn ?? "ukendt"}
                </Felt>
              )}
              {sag.begrundelse && (
                <Felt navn="Begrundelse (til køber og sælger)">
                  <span className="whitespace-pre-wrap">{sag.begrundelse}</span>
                </Felt>
              )}
              {sag.internNote && (
                <Felt navn="Intern note">
                  <span className="whitespace-pre-wrap">{sag.internNote}</span>
                </Felt>
              )}
              {sag.returKraeves && (
                <Felt navn="Retur">
                  {sag.returAfleveretKl
                    ? `Returpakke afleveret ${sagTid(sag.returAfleveretKl)}`
                    : "Køberen skal sende varen retur"}
                  {sag.returfragtBetaler === "bidhamr" && " · BidHamr betaler returfragten"}
                </Felt>
              )}
            </dl>
          ) : (
            <p className="text-sm text-neutral-500">Sagen er ikke afgjort endnu.</p>
          )}
        </Kort>
      </div>

      <Kort titel={`Billeder (${sag.billeder.length})`}>
        {(["pakke", "label", "indhold", "andet"] as const).map((k) => {
          const egne = sag.billeder.filter((x) => x.kategori === k);
          if (egne.length === 0) return null;
          return (
            <div key={k} className="mb-5 last:mb-0">
              <h3 className="mb-2 text-sm font-medium text-neutral-700">
                {SAG_KATEGORI_NAVN[k]} ({egne.length})
              </h3>
              <SagBilleder billeder={egne} stor />
            </div>
          );
        })}
        {sag.billeder.length === 0 && <p className="text-sm text-neutral-500">Køberen har ikke tilføjet billeder.</p>}
        {sag.billeder.length > 0 && (
          <p className="mt-3 text-xs text-neutral-500">
            Klik på et billede for at se det i fuld størrelse. Linkene udløber efter en time – genindlæs siden for nye.
          </p>
        )}
      </Kort>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Kort titel="Handlen">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <Felt navn="Auktion">
              {sag.auktionId ? (
                <Link href={`/auktion/${sag.auktionId}`} className="font-medium hover:underline">
                  {sag.auktionTitel ?? "(slettet auktion)"}
                </Link>
              ) : (
                "(slettet auktion)"
              )}
            </Felt>
            <Felt navn="Status nu">
              <HandelStatusBadge status={sag.handelStatus} />
            </Felt>
            <Felt navn="Køber">
              <Link href={`/admin/brugere/${sag.koeber.id}`} className="font-medium hover:underline">
                {koeberNavn}
              </Link>
              {sag.koeberLukket && <span className="ml-1 text-xs text-fejl-tekst">(lukket)</span>}
            </Felt>
            <Felt navn="Sælger">
              <Link href={`/admin/brugere/${sag.saelger.id}`} className="font-medium hover:underline">
                {saelgerNavn}
              </Link>
              {sag.saelgerLukket && <span className="ml-1 text-xs text-fejl-tekst">(lukket)</span>}
            </Felt>
            <Felt navn="Status da sagen blev oprettet">{statusLabel(sag.handelStatusVedOprettelse)}</Felt>
            <Felt navn="Sporingsnummer">{sag.trackingNumber ?? "–"}</Felt>
            <Felt navn="Sendt">{sag.sendtKl ? sagTid(sag.sendtKl) : "–"}</Felt>
            <Felt navn="Modtaget">{sag.modtagetKl ? sagTid(sag.modtagetKl) : "–"}</Felt>
          </dl>
          {kanSkriveFaelles && (
            <div className="mt-4 border-t border-neutral-100 pt-4">
              <FaellesbeskedKnap tradeId={sag.tradeId} />
            </div>
          )}
        </Kort>

        <Kort titel="Betaling">
          {b ? (
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <Felt navn="Status">{BETALING_STATUS[b.status] ?? b.status}</Felt>
              <Felt navn="BidHamr Beskyttelse">{jaNej(b.beskyttelse)}</Felt>
              <Felt navn="Frigivet til sælger">{jaNej(b.frigivet)}</Felt>
              <Felt navn="Overført til sælger">{jaNej(b.overfoert)}</Felt>
              <Felt navn="Refusion anmodet">{jaNej(b.refusionAnmodet)}</Felt>
              <Felt navn="Refunderet">{jaNej(b.refunderet)}</Felt>
              {sag.kan.seBeloeb && (
                <>
                  {b.totalOere !== null && <Felt navn="Betalt i alt">{kroner(b.totalOere)}</Felt>}
                  {b.beskyttelseOere !== null && (
                    <Felt navn="Heraf BidHamr Beskyttelse">{kroner(b.beskyttelseOere)}</Felt>
                  )}
                  {b.refusionOere !== null && <Felt navn="Refusion">{kroner(b.refusionOere)}</Felt>}
                </>
              )}
            </dl>
          ) : (
            <p className="text-sm text-neutral-500">Ingen betaling fundet.</p>
          )}
          <p className="mt-3 text-xs text-neutral-500">
            BidHamr holder aldrig pengene. Betalingen håndteres af vores betalingspartner Stripe.
          </p>
        </Kort>
      </div>

      <Kort titel="Samtaler om sagen">
        {"fejl" in samtalerRes ? (
          <p role="alert" className="text-sm text-fejl-tekst">
            Samtalerne kunne ikke hentes: {samtalerRes.fejl}
          </p>
        ) : (
          <StaffSamtaleListe
            samtaler={samtalerRes.samtaler}
            tom="Ingen samtaler om sagen endnu. Brug knapperne øverst for at skrive til køber eller sælger."
          />
        )}
      </Kort>

      <Kort titel="Log">
        {sag.log.length === 0 ? (
          <p className="text-sm text-neutral-500">Ingen handlinger endnu.</p>
        ) : (
          <ol className="space-y-3">
            {sag.log.map((l, i) => (
              <li key={`${l.oprettetKl}-${i}`} className="border-l-2 border-neutral-200 pl-3 text-sm">
                <p className="font-medium text-neutral-800">{logNavn(l.handling)}</p>
                <p className="text-xs text-neutral-500">
                  {sagTid(l.oprettetKl)} · {l.medarbejderNavn ?? "ukendt"}
                </p>
                {l.aarsag && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-neutral-700">{l.aarsag}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </Kort>
    </div>
  );
}
