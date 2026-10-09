"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  aabnStripeOversigt,
  opdaterSaelgerStatus,
  startSaelgerOnboarding,
  type Bankudbetaling,
  type Betalingsindstillinger,
} from "@/app/actions/betaling";
import { FejlBoks } from "@/components/betaling/FejlBoks";
import { kroner } from "@/lib/kroner";

// Udbetalinger fra sælgerens Stripe-konto til banken.
const BANK_STATUS: Record<Bankudbetaling["status"], { tekst: string; stil: string }> = {
  paa_vej: { tekst: "På vej til din bank", stil: "text-info-tekst" },
  udbetalt: { tekst: "Sendt til din bank", stil: "text-groen-mork" },
  fejlet: { tekst: "Fejlede – sendes igen, når bankkontoen er rettet", stil: "text-fejl-tekst" },
  annulleret: { tekst: "Stoppet – BidHamr kigger på det", stil: "text-advarsel-tekst" },
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
  bankudbetalinger = [],
}: {
  saelger: Betalingsindstillinger["saelger"];
  erRetur: boolean;
  // Udbetalinger fra din Stripe-konto til banken. null = kunne ikke hentes.
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

      {saelger.frosset && !lukket && (
        <div role="alert" className="rounded-xl border border-advarsel-kant bg-advarsel-bg p-4 text-sm text-advarsel-tekst">
          <p className="font-semibold">Dine auktioner og bud er sat på pause</p>
          <p className="mt-1">
            Stripe har endnu ikke godkendt din udbetalingskonto. Gør opsætningen færdig hos
            Stripe med knappen ovenfor – pausen ophæves automatisk, når kontoen er godkendt.
          </p>
        </div>
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
            Når en handel er helt færdig, sender vores betalingspartner Stripe pengene til din bank.
            Hos Stripe kan du se dine udbetalinger og rette din bankkonto.
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

      {(saelger.harKonto || (bankudbetalinger?.length ?? 0) > 0) && bankudbetalinger !== undefined && (
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
                      u.status === "fejlet" || u.status === "annulleret" ? "text-tekst-daempet line-through" : "text-tekst"
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
    </div>
  );
}
