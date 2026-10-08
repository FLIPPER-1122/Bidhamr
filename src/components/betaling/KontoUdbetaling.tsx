"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  aabnStripeOversigt,
  opdaterSaelgerStatus,
  startSaelgerOnboarding,
  type Bankudbetaling,
  type Betalingsindstillinger,
  type Overfoersel,
} from "@/app/actions/betaling";
import { FejlBoks } from "@/components/betaling/FejlBoks";
import { kroner } from "@/lib/kroner";

// Overførsler, der ikke længere står hos sælgeren, vises med status.
const OVERFOERSEL_STATUS: Record<Overfoersel["status"], string> = {
  overfoert: "Overført",
  tilbagefoert: "Tilbageført",
  refunderet: "Pengene er sendt tilbage til køberen",
  indsigelse: "Indsigelse fra køberens bank",
};

// Udbetalinger til banken (betalingsmodel destination).
const BANK_STATUS: Record<Bankudbetaling["status"], { tekst: string; stil: string }> = {
  paa_vej: { tekst: "På vej til din bank", stil: "text-info-tekst" },
  udbetalt: { tekst: "Sendt til din bank", stil: "text-groen-mork" },
  fejlet: { tekst: "Fejlede – sendes igen, når bankkontoen er rettet", stil: "text-fejl-tekst" },
};

function datoTekst(iso: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("da-DK", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Copenhagen",
  });
}

export default function KontoUdbetaling({
  saelger,
  erRetur,
  overfoersler,
  bankudbetalinger = [],
}: {
  saelger: Betalingsindstillinger["saelger"];
  erRetur: boolean;
  // null = kunne ikke hentes.
  overfoersler: Overfoersel[] | null;
  // Udbetalinger fra din Stripe-konto til banken (destination). null = kunne
  // ikke hentes.
  bankudbetalinger?: Bankudbetaling[] | null;
}) {
  const router = useRouter();
  const [fejl, setFejl] = useState<string | null>(null);
  const [venter, startTransition] = useTransition();
  const [aabnerOversigt, startOversigt] = useTransition();
  const opdateret = useRef(false);

  // Tilbage fra Stripes onboarding (?stripe=retur): hent status fra Stripe.
  useEffect(() => {
    if (!erRetur || opdateret.current) return;
    opdateret.current = true;
    opdaterSaelgerStatus().then((svar) => {
      if ("fejl" in svar) setFejl(svar.fejl);
      router.replace("/konto");
      router.refresh();
    });
  }, [erRetur, router]);

  function start() {
    setFejl(null);
    startTransition(async () => {
      const svar = await startSaelgerOnboarding();
      if ("fejl" in svar) setFejl(svar.fejl);
      else window.location.href = svar.url;
    });
  }

  // Linket fra Stripe er til engangsbrug og oprettes først ved klik.
  function aabnOversigt() {
    setFejl(null);
    startOversigt(async () => {
      const svar = await aabnStripeOversigt();
      if ("fejl" in svar) setFejl(svar.fejl);
      else window.location.href = svar.url;
    });
  }

  const klar = saelger.overfoerslerAktiv && saelger.udbetalingerAktiv;
  const mangler = saelger.detaljerIndsendt && saelger.manglerOplysninger;
  const lukket = saelger.frakoblet || saelger.afvist;

  let status: { tekst: string; stil: string };
  if (saelger.frakoblet) {
    status = { tekst: "Udbetalingskontoen er lukket", stil: "border-fejl-kant bg-fejl-bg text-fejl-tekst" };
  } else if (saelger.afvist) {
    status = { tekst: "Stripe har afvist udbetalingskontoen", stil: "border-fejl-kant bg-fejl-bg text-fejl-tekst" };
  } else if (mangler) {
    status = { tekst: "Stripe mangler oplysninger – fortsæt opsætningen", stil: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst" };
  } else if (klar) {
    status = { tekst: "Klar til udbetaling", stil: "border-succes-kant bg-groen-lys text-groen-mork" };
  } else if (saelger.detaljerIndsendt) {
    status = { tekst: "Stripe tjekker dine oplysninger", stil: "border-info-kant bg-info-bg text-info-tekst" };
  } else if (saelger.harKonto) {
    status = { tekst: "Mangler oplysninger", stil: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst" };
  } else {
    status = { tekst: "Ikke oprettet", stil: "border-kant bg-white text-tekst-daempet" };
  }

  const visFortsaet = !lukket && (!klar || mangler);
  const visOversigt = saelger.harKonto && saelger.detaljerIndsendt && !saelger.frakoblet;

  return (
    <div className="space-y-4">
      <p className="text-sm text-tekst-daempet">
        Når du sælger, håndteres betalingen af vores betalingspartner Stripe, som udbetaler
        pengene til din bankkonto. Opret din udbetalingskonto, før du sælger.
      </p>
      {fejl && <FejlBoks tekst={fejl} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={`rounded-full border px-3 py-1 text-sm font-medium ${status.stil}`}>
          {status.tekst}
        </span>
        {visFortsaet && (
          <button type="button" onClick={start} disabled={venter} className="btn btn-primaer w-full sm:w-auto">
            {venter
              ? "Sender dig videre…"
              : saelger.harKonto
                ? "Fortsæt opsætning hos Stripe"
                : "Opret udbetalingskonto"}
          </button>
        )}
      </div>

      {lukket && (
        <p className="text-sm text-tekst-daempet">
          Du kan ikke få penge udbetalt til denne konto. Skriv til{" "}
          <a href="mailto:support@bidhamr.dk" className="font-medium text-groen hover:underline">
            support@bidhamr.dk
          </a>
          , så hjælper vi dig.
        </p>
      )}

      {saelger.venterPaaBank && !lukket && (
        <div role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          <p className="font-semibold">Udbetalingen til din bank fejlede</p>
          <p className="mt-1">
            Vores betalingspartner Stripe kunne ikke sende pengene til din bankkonto. Ret dine
            bankoplysninger hos Stripe med knappen herunder. Når bankkontoen er rettet, sendes
            pengene automatisk igen.
          </p>
        </div>
      )}

      {visOversigt && (
        <div className="space-y-2 border-t border-kant pt-4">
          <p className="text-sm text-tekst-daempet">
            {saelger.bidhamrUdbetaler
              ? "Når en handel er helt færdig, sender vores betalingspartner Stripe pengene til din bank. Hos Stripe kan du se dine udbetalinger og rette din bankkonto."
              : "Stripe udbetaler automatisk pengene fra din udbetalingskonto til din bank. Hos Stripe kan du se dine udbetalinger, hvornår pengene kommer, og rette din bankkonto."}
          </p>
          <button
            type="button"
            onClick={aabnOversigt}
            disabled={aabnerOversigt}
            className="btn btn-sekundaer w-full sm:w-auto"
          >
            {aabnerOversigt ? "Åbner Stripe…" : saelger.venterPaaBank ? "Ret bankkonto hos Stripe" : "Se dine udbetalinger hos Stripe"}
          </button>
        </div>
      )}

      {(saelger.bidhamrUdbetaler || (bankudbetalinger?.length ?? 0) > 0) && bankudbetalinger !== undefined && (
        <div className="border-t border-kant pt-4">
          <h3 className="text-sm font-semibold text-tekst">Udbetalt til din bank</h3>
          {bankudbetalinger === null ? (
            <p className="mt-2 text-sm text-tekst-daempet">Dine udbetalinger kunne ikke hentes lige nu.</p>
          ) : bankudbetalinger.length === 0 ? (
            <p className="mt-2 text-sm text-tekst-daempet">
              Ingen udbetalinger endnu. Pengene sendes til din bank, når køberen har godkendt varen,
              eller fristen for at oprette en sag er udløbet.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-kant rounded-xl border border-kant">
              {bankudbetalinger.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <span className="block font-medium text-tekst">
                      {u.antalHandler === 1 ? "1 salg" : `${u.antalHandler} salg`}
                    </span>
                    <span className="text-xs text-tekst-daempet">
                      {datoTekst(u.oprettetKl)}
                      <span className={`ml-2 font-medium ${BANK_STATUS[u.status].stil}`}>{BANK_STATUS[u.status].tekst}</span>
                    </span>
                  </div>
                  <span
                    className={`shrink-0 font-medium tabular-nums ${
                      u.status === "fejlet" ? "text-tekst-daempet line-through" : "text-tekst"
                    }`}
                  >
                    {kroner(u.beloebOere)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(saelger.harKonto || (overfoersler?.length ?? 0) > 0) && (
        <div className="border-t border-kant pt-4">
          <h3 className="text-sm font-semibold text-tekst">Overført fra dine salg</h3>
          {overfoersler === null ? (
            <p className="mt-2 text-sm text-tekst-daempet">Dine overførsler kunne ikke hentes lige nu.</p>
          ) : overfoersler.length === 0 ? (
            <p className="mt-2 text-sm text-tekst-daempet">
              Ingen overførsler endnu. Pengene overføres til din udbetalingskonto, når køberen har
              godkendt varen, eller fristen for at oprette en sag er udløbet.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-kant rounded-xl border border-kant">
              {overfoersler.map((o) => (
                <li key={o.handelId} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <Link
                      href={`/mine-handler/${o.handelId}`}
                      className="block truncate font-medium text-tekst hover:underline"
                    >
                      {o.titel}
                    </Link>
                    <span className="text-xs text-tekst-daempet">
                      {datoTekst(o.overfoertKl)}
                      {o.status !== "overfoert" && (
                        <span className={`ml-2 font-medium ${o.status === "tilbagefoert" ? "text-fejl-tekst" : "text-tekst-daempet"}`}>{OVERFOERSEL_STATUS[o.status]}</span>
                      )}
                    </span>
                  </div>
                  <span
                    className={`shrink-0 font-medium tabular-nums ${
                      o.status === "tilbagefoert" ? "text-tekst-daempet line-through" : "text-tekst"
                    }`}
                  >
                    {kroner(o.beloebOere)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {overfoersler && overfoersler.length > 0 && (
            <p className="mt-2 text-xs text-tekst-daempet">
              Beløbet er din salgspris minus sælgergebyret. Stripe sender det videre til din bank.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
