"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { opdaterSaelgerStatus, startSaelgerOnboarding } from "@/app/actions/betaling";
import { FejlBoks } from "@/components/betaling/FejlBoks";
import Link from "next/link";
import { FIRMA_UDBETALINGSKONTO } from "@/lib/tekster/erhverv";
import { ERHVERV_EMAIL } from "@/lib/erhverv/regler";
import { E_KNAP_PRIMAER, E_KNAP_SEKUNDAER, E_TEKST } from "@/components/erhverv/stil";

// Vises på /opret-auktion i stedet for formularen, når sælgeren ikke har en
// udbetalingskonto (eller ikke har sendt oplysningerne ind hos Stripe).
// Tilbage fra Stripe (?stripe=retur) hentes status, og siden genindlæses –
// er oplysningerne sendt ind, vises formularen.
export default function UdbetalingskontoKraeves({
  harKonto,
  erRetur,
  erFejl,
  erFirma = false,
}: {
  harKonto: boolean;
  erRetur: boolean;
  erFejl: boolean;
  erFirma?: boolean;
}) {
  const router = useRouter();
  const [fejl, setFejl] = useState<string | null>(
    erFejl ? "Vi kunne ikke åbne Stripe. Prøv igen om lidt." : null,
  );
  const [venter, startTransition] = useTransition();
  const [henter, setHenter] = useState(erRetur);
  const opdateret = useRef(false);

  useEffect(() => {
    if (!erRetur || opdateret.current) return;
    opdateret.current = true;
    opdaterSaelgerStatus().then((svar) => {
      if ("fejl" in svar) setFejl(svar.fejl);
      setHenter(false);
      router.replace("/opret-auktion");
      router.refresh();
    });
  }, [erRetur, router]);

  function start() {
    setFejl(null);
    startTransition(async () => {
      const svar = await startSaelgerOnboarding("opret-auktion");
      if ("fejl" in svar) setFejl(svar.fejl);
      else window.location.href = svar.url;
    });
  }

  if (henter) {
    return (
      <p className="rounded-lg border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
        Henter status fra Stripe…
      </p>
    );
  }

  // Firmakonto (målgruppen er ældre): enkel forklaring, store knapper, hjælp
  // og vej tilbage til Firma oversigt.
  if (erFirma) {
    return (
      <div className="space-y-4 rounded-[14px] border-2 border-advarsel-kant bg-advarsel-bg p-5 sm:p-6">
        <h2 className="font-sans text-[22px] font-semibold text-tekst">{FIRMA_UDBETALINGSKONTO.titel}</h2>
        <p className={E_TEKST}>{FIRMA_UDBETALINGSKONTO.tekst}</p>
        {fejl && <FejlBoks tekst={fejl} />}
        <div className="flex flex-col gap-3 sm:flex-row">
          <button type="button" onClick={start} disabled={venter} aria-busy={venter || undefined} className={E_KNAP_PRIMAER}>
            {venter
              ? FIRMA_UDBETALINGSKONTO.knapSender
              : harKonto
                ? FIRMA_UDBETALINGSKONTO.knapFaerdig
                : FIRMA_UDBETALINGSKONTO.knapOpret}
          </button>
          <Link href="/firma" className={E_KNAP_SEKUNDAER}>
            {FIRMA_UDBETALINGSKONTO.tilbage}
          </Link>
        </div>
        <p className={E_TEKST}>
          {FIRMA_UDBETALINGSKONTO.hjaelp}{" "}
          <a
            href={`mailto:${ERHVERV_EMAIL}`}
            className="inline-flex min-h-11 items-center font-semibold break-all text-groen underline underline-offset-2"
          >
            {ERHVERV_EMAIL}
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-advarsel-kant bg-advarsel-bg p-5">
      <p className="text-sm text-advarsel-tekst">
        For at sælge skal du have en udbetalingskonto, så Stripe kan sende pengene til din bank.
      </p>
      {fejl && <FejlBoks tekst={fejl} />}
      <button type="button" onClick={start} disabled={venter} className="btn btn-primaer w-full">
        {venter
          ? "Sender dig videre…"
          : harKonto
            ? "Gør udbetalingskontoen færdig"
            : "Opret udbetalingskonto"}
      </button>
    </div>
  );
}
