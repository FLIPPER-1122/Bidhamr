"use client";

// Status, noter og arkivering af en erhvervshenvendelse (opdaterErhvervHenvendelse).
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import { opdaterErhvervHenvendelse } from "@/app/actions/adminErhverv";
import { ADMIN_ERHVERV as A, ADMIN_ERHVERV_EKSTRA as X } from "@/lib/tekster/erhverv";
import { ERHVERV_GRAENSER, type HenvendelseStatus } from "@/lib/erhverv/regler";

export default function HenvendelseHandlinger({
  id,
  status,
  noter: startNoter,
  arkiveret,
}: {
  id: string;
  status: HenvendelseStatus;
  noter: string | null;
  arkiveret: boolean;
}) {
  const router = useRouter();
  const [noter, setNoter] = useState(startNoter ?? "");
  const [besked, setBesked] = useState<{ tekst: string; fejl: boolean } | null>(null);
  const [gemmer, start] = useTransition();

  async function opdater(input: Parameters<typeof opdaterErhvervHenvendelse>[0]) {
    const svar = await opdaterErhvervHenvendelse(input);
    if ("fejl" in svar) return { fejl: svar.fejl };
    router.refresh();
  }

  function gemNote() {
    setBesked(null);
    start(async () => {
      const svar = await opdater({ id, noter });
      setBesked(svar?.fejl ? { tekst: svar.fejl, fejl: true } : { tekst: "Noten er gemt.", fejl: false });
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-sans text-base font-semibold text-neutral-900">{A.henvendelser.kolonneStatus}</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {status !== "i_gang" && (
            <button
              type="button"
              disabled={gemmer}
              onClick={() => start(async () => void (await opdater({ id, status: "i_gang" })))}
              className="btn btn-sekundaer"
            >
              {A.henvendelser.knapIgang}
            </button>
          )}
          {status !== "godkendt" && (
            <BekraeftDialog
              triggerLabel={A.henvendelser.knapGodkend}
              title={A.henvendelser.knapGodkend}
              description={A.henvendelser.bekraeftGodkend}
              confirmLabel={A.henvendelser.knapGodkend}
              onConfirm={() => opdater({ id, status: "godkendt" })}
            />
          )}
          {status !== "afvist" && (
            <BekraeftDialog
              triggerLabel={A.henvendelser.knapAfvis}
              triggerClassName="btn btn-fare"
              title={A.henvendelser.knapAfvis}
              description={A.henvendelser.bekraeftAfvis}
              confirmLabel={A.henvendelser.knapAfvis}
              onConfirm={() => opdater({ id, status: "afvist" })}
            />
          )}
        </div>
      </div>

      <div>
        <label htmlFor="henv-noter" className="font-sans text-base font-semibold text-neutral-900">
          {A.henvendelser.noterTitel}
        </label>
        <textarea
          id="henv-noter"
          value={noter}
          maxLength={ERHVERV_GRAENSER.noter}
          onChange={(e) => setNoter(e.target.value)}
          placeholder={A.henvendelser.noterPladsholder}
          rows={5}
          className="mt-2 min-h-[120px] w-full rounded-xl border border-kant-staerk bg-white px-4 py-3 text-[15px] focus:border-groen focus:outline-2 focus:outline-groen/25"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button type="button" onClick={gemNote} disabled={gemmer} aria-busy={gemmer || undefined} className="btn btn-sekundaer">
            {gemmer && <span className="btn-spinner" aria-hidden="true" />}
            {A.henvendelser.knapGemNote}
          </button>
          {besked && (
            <p role={besked.fejl ? "alert" : "status"} className={`text-sm font-medium ${besked.fejl ? "text-fejl-tekst" : "text-succes-tekst"}`}>
              {besked.tekst}
            </p>
          )}
        </div>
      </div>

      <div>
        {arkiveret ? (
          <button
            type="button"
            disabled={gemmer}
            onClick={() => start(async () => void (await opdater({ id, arkiver: false })))}
            className="btn btn-sekundaer"
          >
            {X.knapHentTilbage}
          </button>
        ) : (
          <BekraeftDialog
            triggerLabel={X.knapArkiver}
            triggerClassName="btn btn-sekundaer"
            title={X.knapArkiver}
            description={X.bekraeftArkiver}
            confirmLabel={X.knapArkiver}
            onConfirm={() => opdater({ id, arkiver: true })}
          />
        )}
      </div>
    </div>
  );
}
