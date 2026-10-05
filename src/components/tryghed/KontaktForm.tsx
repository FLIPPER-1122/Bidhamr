"use client";

import { useRef, useState, type FormEvent } from "react";
import { sendKontakt } from "@/app/actions/kontakt";
import { KONTAKT_BESKED_MAKS, KONTAKT_EMNER, type KontaktEmne } from "@/lib/tryghed";

const felt =
  "min-h-11 mt-1.5 w-full rounded-xl border border-kant-staerk bg-white px-4 py-2.5 text-base text-tekst placeholder:text-pladsholder sm:text-sm hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25";

export default function KontaktForm({
  email,
  emne: startEmne,
  handel,
}: {
  email: string;
  emne: KontaktEmne;
  handel: string;
}) {
  const [emne, setEmne] = useState<KontaktEmne>(startEmne);
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [sendt, setSendt] = useState(false);
  // Tidspunktet, formularen blev vist (robotter udfylder på under 3 sek.).
  const [start] = useState(() => Date.now());
  // Synkron spærre mod dobbelt-submit: state når ikke at opdatere mellem to
  // hurtige klik/Enter, en ref gør.
  const senderRef = useRef(false);

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (senderRef.current) return;
    senderRef.current = true;
    setFejl(null);
    const data = new FormData(e.currentTarget);
    data.set("t", String(start));
    setSender(true);
    let res: Awaited<ReturnType<typeof sendKontakt>>;
    try {
      res = await sendKontakt(data);
    } catch {
      res = { fejl: "Beskeden kunne ikke sendes lige nu. Prøv igen om lidt." };
    } finally {
      senderRef.current = false;
      setSender(false);
    }
    if ("fejl" in res) {
      setFejl(res.fejl);
      return;
    }
    setSendt(true);
  }

  if (sendt) {
    return (
      <div role="status" className="rounded-[14px] border border-succes-kant bg-succes-bg p-5 sm:p-6">
        <h2 className="font-serif text-xl font-semibold text-succes-tekst">Tak for din besked</h2>
        <p className="mt-1 text-sm text-succes-tekst">
          Vi har modtaget den og svarer dig så hurtigt, vi kan – som regel inden for 1-2 hverdage.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={send} className="space-y-5" noValidate>
      <fieldset>
        <legend className="text-sm font-medium text-tekst">Hvad drejer det sig om?</legend>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {KONTAKT_EMNER.map((k) => (
            <label
              key={k.vaerdi}
              className={`flex cursor-pointer items-center justify-center rounded-lg border px-3 py-2.5 text-center text-sm font-medium ${
                emne === k.vaerdi
                  ? "border-groen bg-groen-lys text-groen-mork"
                  : "border-kant-staerk text-tekst hover:bg-groen-lys/50"
              }`}
            >
              <input
                type="radio"
                name="emne"
                value={k.vaerdi}
                checked={emne === k.vaerdi}
                onChange={() => setEmne(k.vaerdi)}
                className="sr-only"
              />
              {k.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="kontakt-besked" className="block text-sm font-medium text-tekst">
          Din besked
        </label>
        <textarea
          id="kontakt-besked"
          name="besked"
          rows={6}
          required
          maxLength={KONTAKT_BESKED_MAKS}
          placeholder={
            emne === "fejl"
              ? "Hvad skete der, og hvor på siden var du?"
              : "Skriv, hvad vi kan hjælpe med."
          }
          className={felt}
        />
      </div>

      <div>
        <label htmlFor="kontakt-handel" className="block text-sm font-medium text-tekst">
          Handels-id <span className="font-normal text-tekst-svag">(valgfrit)</span>
        </label>
        <input
          id="kontakt-handel"
          name="handel"
          type="text"
          defaultValue={handel}
          maxLength={100}
          autoComplete="off"
          className={felt}
        />
        <p className="mt-1 text-xs text-tekst-svag">Findes under Mine handler, hvis det handler om en bestemt handel.</p>
      </div>

      <div>
        <label htmlFor="kontakt-email" className="block text-sm font-medium text-tekst">
          Din e-mail
        </label>
        <input
          id="kontakt-email"
          name="email"
          type="email"
          required
          defaultValue={email}
          autoComplete="email"
          maxLength={254}
          className={felt}
        />
      </div>

      {/* Honeypot: skjult for mennesker og skærmlæsere. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="kontakt-hjemmeside">Lad dette felt være tomt</label>
        <input id="kontakt-hjemmeside" name="hjemmeside" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {fejl && (
        <p role="alert" className="rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}

      <button type="submit" disabled={sender} className="btn btn-primaer w-full sm:w-auto">
        {sender ? "Sender…" : "Send besked"}
      </button>
    </form>
  );
}
