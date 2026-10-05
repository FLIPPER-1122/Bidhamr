"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  aabnStripeOversigt,
  opdaterSaelgerStatus,
  startSaelgerOnboarding,
  type Betalingsindstillinger,
  type Overfoersel,
} from "@/app/actions/betaling";
import { FejlBoks } from "@/components/betaling/BetalingSektion";
import { kroner } from "@/lib/kroner";

// Overførsler, der ikke længere står hos sælgeren, vises med status.
const OVERFOERSEL_STATUS: Record<Overfoersel["status"], string> = {
  overfoert: "Overført",
  tilbagefoert: "Tilbageført",
  refunderet: "Pengene er sendt tilbage til køberen",
  indsigelse: "Indsigelse fra køberens bank",
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
}: {
  saelger: Betalingsindstillinger["saelger"];
  erRetur: boolean;
  // null = kunne ikke hentes.
  overfoersler: Overfoersel[] | null;
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
    status = { tekst: "Udbetalingskontoen er lukket", stil: "border-[#F3C4C4] bg-[#FDECEC] text-[#A32020]" };
  } else if (saelger.afvist) {
    status = { tekst: "Stripe har afvist udbetalingskontoen", stil: "border-[#F3C4C4] bg-[#FDECEC] text-[#A32020]" };
  } else if (mangler) {
    status = { tekst: "Stripe mangler oplysninger – fortsæt opsætningen", stil: "border-[#F5D9B0] bg-[#FEF3E2] text-[#8A4210]" };
  } else if (klar) {
    status = { tekst: "Klar til udbetaling", stil: "border-[#B9D8CC] bg-groen-lys text-groen-mork" };
  } else if (saelger.detaljerIndsendt) {
    status = { tekst: "Stripe tjekker dine oplysninger", stil: "border-[#C9DCEB] bg-[#EDF3F8] text-[#1F4E79]" };
  } else if (saelger.harKonto) {
    status = { tekst: "Mangler oplysninger", stil: "border-[#F5D9B0] bg-[#FEF3E2] text-[#8A4210]" };
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

      {visOversigt && (
        <div className="space-y-2 border-t border-kant pt-4">
          <p className="text-sm text-tekst-daempet">
            Stripe udbetaler automatisk pengene fra din udbetalingskonto til din bank. Hos Stripe kan
            du se dine udbetalinger, hvornår pengene kommer, og rette din bankkonto.
          </p>
          <button
            type="button"
            onClick={aabnOversigt}
            disabled={aabnerOversigt}
            className="btn btn-sekundaer w-full sm:w-auto"
          >
            {aabnerOversigt ? "Åbner Stripe…" : "Se dine udbetalinger hos Stripe"}
          </button>
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
                        <span className={`ml-2 font-medium ${o.status === "tilbagefoert" ? "text-[#A32020]" : "text-tekst-daempet"}`}>{OVERFOERSEL_STATUS[o.status]}</span>
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
