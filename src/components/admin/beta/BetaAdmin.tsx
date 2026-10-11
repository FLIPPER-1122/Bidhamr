"use client";

// Admin → Beta-invitationer: kontakten "Beta åben/lukket" (kun chef),
// formularen til nye invitationer og listen med status pr. invitation.
// Alle knapper er mindst 44 px høje (.btn), og listen er kort under hinanden,
// så den virker på mobil.
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import {
  inviterBetaTester,
  saetBetaAaben,
  sendBetaInvitationIgen,
  tilbagekaldBetaInvitation,
  type BetaInvitation,
  type BetaOversigt,
  type BetaStatus,
} from "@/app/actions/adminBeta";

const STATUS: Record<BetaStatus, { tekst: string; klasse: string }> = {
  inviteret: { tekst: "Inviteret", klasse: "bg-neutral-100 text-neutral-700" },
  oprettet: { tekst: "Oprettet konto", klasse: "bg-blue-100 text-blue-800" },
  mitid: { tekst: "MitID-verificeret", klasse: "bg-green-100 text-green-800" },
  tilbagekaldt: { tekst: "Tilbagekaldt", klasse: "bg-red-100 text-red-800" },
};

const RAEKKEFOELGE: BetaStatus[] = ["inviteret", "oprettet", "mitid", "tilbagekaldt"];

function dato(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Besked = { tekst: string; fejl: boolean } | null;

function BeskedLinje({ besked }: { besked: Besked }) {
  if (!besked) return null;
  return (
    <p
      role={besked.fejl ? "alert" : "status"}
      className={`text-sm font-medium ${besked.fejl ? "text-fejl-tekst" : "text-succes-tekst"}`}
    >
      {besked.tekst}
    </p>
  );
}

export default function BetaAdmin({ oversigt, erChef }: { oversigt: BetaOversigt; erChef: boolean }) {
  const router = useRouter();
  const [besked, setBesked] = useState<Besked>(null);

  const antal = RAEKKEFOELGE.map((s) => ({
    status: s,
    n: oversigt.invitationer.filter((i) => i.status === s).length,
  }));

  return (
    <div className="space-y-5">
      <Kontakt oversigt={oversigt} erChef={erChef} onBesked={setBesked} onFaerdig={() => router.refresh()} />

      <InvitationsFormular onBesked={setBesked} onFaerdig={() => router.refresh()} />

      <BeskedLinje besked={besked} />

      <section className="rounded-xl border border-neutral-200 bg-white">
        <div className="flex flex-col gap-2 border-b border-neutral-100 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <h2 className="font-sans text-base font-semibold text-neutral-900">
            Invitationer ({oversigt.invitationer.length})
          </h2>
          <ul className="flex flex-wrap gap-2 text-xs" aria-label="Antal pr. status">
            {antal.map(({ status, n }) => (
              <li key={status} className={`rounded-full px-2.5 py-1 font-medium ${STATUS[status].klasse}`}>
                {STATUS[status].tekst}: {n}
              </li>
            ))}
          </ul>
        </div>
        {oversigt.invitationer.length === 0 ? (
          <p className="p-6 text-center text-sm text-neutral-500">Ingen invitationer endnu.</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {oversigt.invitationer.map((inv) => (
              <InvitationRaekke key={inv.id} inv={inv} onBesked={setBesked} onFaerdig={() => router.refresh()} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Kontakt({
  oversigt,
  erChef,
  onBesked,
  onFaerdig,
}: {
  oversigt: BetaOversigt;
  erChef: boolean;
  onBesked: (b: Besked) => void;
  onFaerdig: () => void;
}) {
  const aaben = oversigt.betaAaben;
  async function skift(til: boolean) {
    const svar = await saetBetaAaben(til);
    if ("fejl" in svar) return { fejl: svar.fejl };
    onBesked({ tekst: svar.besked, fejl: false });
    onFaerdig();
  }

  return (
    <section
      className={`rounded-xl border p-4 sm:p-5 ${aaben ? "border-green-200 bg-green-50" : "border-neutral-200 bg-white"}`}
      aria-labelledby="beta-kontakt-titel"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="beta-kontakt-titel" className="font-sans text-base font-semibold text-neutral-900">
            Beta-testen er {aaben ? "åben" : "lukket"}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-neutral-600">
            {aaben
              ? "Inviterede kan oprette en konto og bruge hele siden (ikke admin). Lukker du, ser de coming-soon igen inden for 5 minutter. Deres konti og data bevares."
              : "Ingen beta-testere kommer forbi coming-soon, og inviterede kan ikke oprette en konto. Konti og data er bevaret."}
          </p>
          {!oversigt.kunInviterede && (
            <p className="mt-2 max-w-2xl text-sm font-medium text-yellow-800">
              Databasens tilmeldingsværn er slået fra: alle kan oprette en konto direkte hos Supabase. Det skal kun
              være sådan efter lancering eller på testdatabasen.
            </p>
          )}
          {!erChef && <p className="mt-2 text-sm text-neutral-500">Kun chefen kan åbne og lukke beta-testen.</p>}
        </div>
        {erChef && (
          <div className="shrink-0">
            {aaben ? (
              <BekraeftDialog
                triggerLabel="Luk beta-testen"
                triggerClassName="btn btn-fare w-full sm:w-auto"
                title="Luk beta-testen?"
                description="Alle beta-testere ser coming-soon igen inden for 5 minutter, og ingen kan oprette en konto med en invitation. Konti, handler og data bevares. Du kan åbne igen med ét klik."
                confirmLabel="Luk beta-testen"
                onConfirm={() => skift(false)}
              />
            ) : (
              <BekraeftDialog
                triggerLabel="Åbn beta-testen"
                triggerClassName="btn btn-primaer w-full sm:w-auto"
                title="Åbn beta-testen?"
                description="Alle med en aktiv invitation kan oprette en konto og bruge hele siden (ikke admin). Alle andre ser stadig coming-soon."
                confirmLabel="Åbn beta-testen"
                onConfirm={() => skift(true)}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function InvitationsFormular({ onBesked, onFaerdig }: { onBesked: (b: Besked) => void; onFaerdig: () => void }) {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [fejl, setFejl] = useState<string | null>(null);
  const [sender, start] = useTransition();

  function send(e: FormEvent) {
    e.preventDefault();
    setFejl(null);
    onBesked(null);
    start(async () => {
      const svar = await inviterBetaTester({ email, note });
      if ("fejl" in svar) {
        setFejl(svar.fejl);
        return;
      }
      setEmail("");
      setNote("");
      onBesked({ tekst: svar.besked, fejl: !svar.mailSendt });
      onFaerdig();
    });
  }

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5" aria-labelledby="beta-ny-titel">
      <h2 id="beta-ny-titel" className="font-sans text-base font-semibold text-neutral-900">
        Ny invitation
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-neutral-600">
        Personen får en mail med et link til at oprette en konto med netop denne e-mail. Har e-mailen allerede en
        konto, står der i stedet, at personen bare skal logge ind.
      </p>
      <form onSubmit={send} className="mt-4 space-y-4" noValidate>
        <div>
          <label htmlFor="beta-email" className="block text-sm font-medium text-neutral-800">
            E-mail
          </label>
          <input
            id="beta-email"
            type="email"
            inputMode="email"
            autoComplete="off"
            required
            maxLength={320}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={fejl ? true : undefined}
            aria-describedby={fejl ? "beta-fejl" : undefined}
            className="mt-1 h-11 w-full max-w-md rounded-xl border border-kant-staerk bg-white px-4 text-[15px] focus:border-groen focus:outline-2 focus:outline-groen/25"
          />
        </div>
        <div>
          <label htmlFor="beta-note" className="block text-sm font-medium text-neutral-800">
            Note <span className="font-normal text-neutral-500">(valgfri, kun til staff)</span>
          </label>
          <textarea
            id="beta-note"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Fx alder, telefon eller hvor personen er fundet"
            className="mt-1 min-h-[72px] w-full max-w-md rounded-xl border border-kant-staerk bg-white px-4 py-3 text-[15px] focus:border-groen focus:outline-2 focus:outline-groen/25"
          />
        </div>
        {fejl && (
          <p id="beta-fejl" role="alert" className="text-sm font-medium text-fejl-tekst">
            {fejl}
          </p>
        )}
        <button
          type="submit"
          disabled={sender || !email.trim()}
          aria-busy={sender || undefined}
          className="btn btn-primaer w-full sm:w-auto"
        >
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          Send invitation
        </button>
      </form>
    </section>
  );
}

function InvitationRaekke({
  inv,
  onBesked,
  onFaerdig,
}: {
  inv: BetaInvitation;
  onBesked: (b: Besked) => void;
  onFaerdig: () => void;
}) {
  const [arbejder, start] = useTransition();
  const s = STATUS[inv.status] ?? STATUS.inviteret;
  const tilbagekaldt = inv.status === "tilbagekaldt";

  function sendIgen() {
    onBesked(null);
    start(async () => {
      const svar = await sendBetaInvitationIgen(inv.id);
      onBesked("fejl" in svar ? { tekst: svar.fejl, fejl: true } : { tekst: svar.besked, fejl: false });
      onFaerdig();
    });
  }

  function genaktiver() {
    onBesked(null);
    start(async () => {
      const svar = await inviterBetaTester({ email: inv.email });
      onBesked("fejl" in svar ? { tekst: svar.fejl, fejl: true } : { tekst: svar.besked, fejl: !svar.mailSendt });
      onFaerdig();
    });
  }

  async function tilbagekald() {
    const svar = await tilbagekaldBetaInvitation(inv.id);
    if ("fejl" in svar) return { fejl: svar.fejl };
    onBesked({ tekst: svar.besked, fejl: false });
    onFaerdig();
  }

  const detaljer = [
    `Inviteret ${dato(inv.inviteret_kl)}${inv.inviteret_af_navn ? ` af ${inv.inviteret_af_navn}` : ""}`,
    inv.antal_sendt > 1 ? `Sendt ${inv.antal_sendt} gange, senest ${dato(inv.sidst_sendt_kl)}` : null,
    inv.konto_oprettet_kl ? `Konto oprettet ${dato(inv.konto_oprettet_kl)}` : null,
    inv.mitid_kl ? `MitID ${dato(inv.mitid_kl)}` : null,
    inv.tilbagekaldt_kl ? `Tilbagekaldt ${dato(inv.tilbagekaldt_kl)}` : null,
  ].filter(Boolean) as string[];

  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-all font-medium text-neutral-900">{inv.email}</span>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${s.klasse}`}>{s.tekst}</span>
        </div>
        {inv.note && <p className="mt-1 break-words text-sm text-neutral-700">{inv.note}</p>}
        <ul className="mt-1 space-y-0.5 text-xs text-neutral-500">
          {detaljer.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
        {tilbagekaldt ? (
          <button type="button" onClick={genaktiver} disabled={arbejder} aria-busy={arbejder || undefined} className="btn btn-sekundaer">
            {arbejder && <span className="btn-spinner" aria-hidden="true" />}
            Invitér igen
          </button>
        ) : (
          <>
            <button type="button" onClick={sendIgen} disabled={arbejder} aria-busy={arbejder || undefined} className="btn btn-sekundaer">
              {arbejder && <span className="btn-spinner" aria-hidden="true" />}
              Send igen
            </button>
            <BekraeftDialog
              triggerLabel="Tilbagekald"
              triggerClassName="btn btn-fare"
              title="Tilbagekald invitationen?"
              description={`${inv.email} kommer ikke længere forbi coming-soon (inden for 5 minutter) og kan ikke oprette en konto med invitationen. En eventuel konto og dens data bevares. Du kan invitere e-mailen igen senere.`}
              confirmLabel="Tilbagekald"
              onConfirm={tilbagekald}
            />
          </>
        )}
      </div>
    </li>
  );
}
