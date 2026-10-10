"use client";

// Oplysninger til firmaets egen faktura på varen - vises pr. salg i Firma
// oversigt -> Salg og på handelssiden. Firmaet sender selv fakturaen.
import { useState } from "react";
import { E_KNAP_SEKUNDAER } from "@/components/erhverv/stil";
import Ikon from "@/components/Ikon";
import {
  FAKTURA_TEKST as T,
  adresseLinjer,
  fakturaDato,
  fakturaKopiTekst,
  momsAfPris,
  varebeskrivelse,
  type FakturaFirma,
  type FakturaSalg,
} from "@/lib/erhverv/fakturaOplysninger";

function kr(oere: number): string {
  return `${(oere / 100).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr.`;
}

function Raekke({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-[16px] text-tekst-daempet">{label}</dt>
      <dd className="text-[17px] font-semibold break-words text-tekst">{children}</dd>
    </div>
  );
}

export function FakturaOplysningerListe({ salg, firma }: { salg: FakturaSalg; firma: FakturaFirma }) {
  const [status, setStatus] = useState<"" | "ok" | "fejl">("");
  const adr = adresseLinjer(salg);

  async function kopier() {
    try {
      await navigator.clipboard.writeText(fakturaKopiTekst(salg, firma));
      setStatus("ok");
    } catch {
      setStatus("fejl");
    }
  }

  return (
    <div>
      {salg.refunderet_kl && (
        <p role="note" className="mb-3 rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-[16px] text-advarsel-tekst">
          {T.refunderet}
        </p>
      )}
      <dl className="space-y-3">
        <Raekke label={T.koeber}>
          {salg.koeber_navn ?? "–"}
        </Raekke>
        <Raekke label={T.adresse}>
          {adr ? (
            adr.map((l) => (
              <span key={l} className="block">
                {l}
              </span>
            ))
          ) : (
            <span className="font-normal text-tekst-daempet">{T.ingenAdresse}</span>
          )}
        </Raekke>
        <Raekke label={T.email}>{salg.koeber_email ?? "–"}</Raekke>
        <Raekke label={T.vare}>{varebeskrivelse(salg)}</Raekke>
        <Raekke label={T.pris}>{kr(salg.pris_oere)}</Raekke>
        {firma.brugtmoms ? (
          <Raekke label="Moms">
            <span className="font-normal">{T.brugtmoms}</span>
          </Raekke>
        ) : (
          <Raekke label={T.moms}>{kr(momsAfPris(salg.pris_oere))}</Raekke>
        )}
        <Raekke label={T.dato}>{fakturaDato(salg.solgt_kl)}</Raekke>
        <Raekke label={T.handelsId}>
          <span className="font-mono text-[15px]">{salg.trade_id}</span>
        </Raekke>
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={kopier} className={`${E_KNAP_SEKUNDAER} w-full sm:w-auto`}>
          {T.kopier}
        </button>
        <p aria-live="polite" className="text-[16px] font-semibold text-groen-mork">
          {status === "ok" ? T.kopieret : status === "fejl" ? <span className="text-fejl-tekst">{T.kopierFejl}</span> : null}
        </p>
      </div>
    </div>
  );
}

// Foldbar udgave til listen over salg.
export function FakturaOplysningerFold({ salg, firma }: { salg: FakturaSalg; firma: FakturaFirma }) {
  return (
    <details className="group mt-4 rounded-xl border-2 border-kant-staerk bg-white">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-2 text-[17px] font-semibold text-groen hover:bg-groen-lys focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen [&::-webkit-details-marker]:hidden">
        {T.titel}
        <Ikon
          navn="ned"
          className="h-5 w-5 shrink-0 transition-transform duration-150 ease-out group-open:rotate-180 motion-reduce:transition-none"
          strøg={2}
        />
      </summary>
      <div className="border-t border-kant px-4 py-4">
        <FakturaOplysningerListe salg={salg} firma={firma} />
      </div>
    </details>
  );
}
