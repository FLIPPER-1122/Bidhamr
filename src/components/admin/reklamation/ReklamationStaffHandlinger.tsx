"use client";

// Staffs knapper på en reklamation (BidHamr anmelder - Filip, 22. okt. 2026):
// Anmeld (fragtfirmaets sagsnummer + link til anmeldelsen), Godkendt
// (beløb), Afvist (grund til sælgeren), kvittér for en ændret sag, ret
// status (påkrævet intern begrundelse), annullér (grund til sælgeren) og den
// interne note. KUN CHEFEN: "Udbetal til sælger" med fluebenet "Erstatningen
// er modtaget fra DAO". Databasen tjekker rolle, to-trins-login og
// inhabilitet igen (src/app/actions/adminReklamation.ts).
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  afvisReklamation,
  anmeldReklamation,
  annullerReklamation,
  gemReklamationNote,
  godkendReklamation,
  kvitterSagAendret,
  retReklamationStatus,
  sendReklamationTilBankIgen,
  udbetalReklamation,
  type ReklamationSvar,
} from "@/app/actions/adminReklamation";
import { visKvittering } from "@/components/admin/Kvittering";
import {
  REKLAMATION_MIN_OERE,
  REKLAMATION_MIN_TEKST,
  REKLAMATION_RET_STATUSSER,
  REKLAMATION_STATUS_STAFF,
  betingelseTekst,
  fortolkKroner,
  kanKvittere,
  kroner,
  type ReklamationRetStatus,
  type ReklamationStatus,
} from "@/lib/reklamation/typer";
import { useHydreret } from "@/lib/useHydreret";

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const FELT =
  "mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-groen sm:text-sm";

function useSend() {
  const router = useRouter();
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const laas = useRef(false);
  async function send(fn: () => Promise<ReklamationSvar>, kvittering: string, efter?: () => void) {
    if (laas.current) return;
    laas.current = true;
    setSender(true);
    setFejl(null);
    try {
      const res = await fn();
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      efter?.();
      visKvittering(res.uaendret ? "Intet at ændre." : kvittering);
      router.refresh();
    } catch {
      setFejl(GENERISK);
    } finally {
      laas.current = false;
      setSender(false);
    }
  }
  return { sender, fejl, setFejl, send };
}

function Fejl({ fejl }: { fejl: string | null }) {
  if (!fejl) return null;
  return (
    <p role="alert" className="rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
      {fejl}
    </p>
  );
}

function Dialog({
  titel,
  beskrivelse,
  aaben,
  onLuk,
  laast,
  children,
}: {
  titel: string;
  beskrivelse?: ReactNode;
  aaben: boolean;
  onLuk: () => void;
  laast: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const boksRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!aaben) return;
    const forrige = document.activeElement as HTMLElement | null;
    boksRef.current?.querySelector<HTMLElement>("select, input, textarea, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !laast) onLuk();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      forrige?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aaben]);
  if (!aaben) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={() => !laast && onLuk()}
    >
      <div
        ref={boksRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-titel`}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={`${id}-titel`} className="text-lg font-bold text-neutral-900">
          {titel}
        </h2>
        {beskrivelse && <div className="mt-1.5 text-sm text-neutral-600">{beskrivelse}</div>}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

function Knapper({ sender, onLuk, bekraeft, fare = false, spaerret = false }: { sender: boolean; onLuk: () => void; bekraeft: string; fare?: boolean; spaerret?: boolean }) {
  const hydreret = useHydreret();
  return (
    <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:justify-end">
      <button
        type="submit"
        disabled={sender || !hydreret || spaerret}
        aria-busy={sender}
        className={`btn order-1 sm:order-2 ${fare ? "btn-fare-fyldt" : "btn-primaer"}`}
      >
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        {bekraeft}
      </button>
      <button type="button" onClick={onLuk} disabled={sender} className="btn btn-sekundaer order-2 sm:order-1">
        Annullér
      </button>
    </div>
  );
}

// En knap, der åbner en dialog med en formular.
function DialogKnap({
  tekst,
  stil = "btn-sekundaer",
  titel,
  beskrivelse,
  children,
}: {
  tekst: string;
  stil?: string;
  titel: string;
  beskrivelse?: ReactNode;
  children: (s: ReturnType<typeof useSend> & { luk: () => void }) => ReactNode;
}) {
  const [aaben, setAaben] = useState(false);
  const s = useSend();
  const luk = () => setAaben(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          s.setFejl(null);
          setAaben(true);
        }}
        className={`btn ${stil} w-full sm:w-auto`}
      >
        {tekst}
      </button>
      <Dialog titel={titel} beskrivelse={beskrivelse} aaben={aaben} onLuk={luk} laast={s.sender}>
        {children({ ...s, luk })}
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------ Anmeld

function AnmeldKnap({
  reklamationId,
  sagId,
  transportoerNavn,
  anmeldUrl,
  sagsnummer,
  ret = false,
}: {
  reklamationId: string;
  sagId: string;
  transportoerNavn: string;
  anmeldUrl: string | null;
  sagsnummer: string | null;
  // Kun ret sagsnummeret (status anmeldt).
  ret?: boolean;
}) {
  const id = useId();
  return (
    <DialogKnap
      tekst={ret ? "Ret sagsnummer" : `Anmeldt hos ${transportoerNavn}`}
      stil={ret ? "btn-sekundaer" : "btn-primaer"}
      titel={ret ? "Ret fragtfirmaets sagsnummer" : `Skaden er anmeldt hos ${transportoerNavn}`}
      beskrivelse={
        ret ? undefined : (
          <>
            Anmeld skaden hos {transportoerNavn} med oplysningerne og billederne nedenfor, og skriv {transportoerNavn}s
            sagsnummer her. Sælgeren får besked om, at skaden er anmeldt (aldrig sagsnummeret eller linket).
          </>
        )
      }
    >
      {({ sender, fejl, setFejl, send, luk }) => (
        <form
          method="post"
          className="space-y-4"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const nr = String(new FormData(e.currentTarget).get("sagsnummer") ?? "").trim();
            if (!nr) {
              setFejl(`Skriv ${transportoerNavn}s sagsnummer.`);
              return;
            }
            void send(() => anmeldReklamation(reklamationId, nr, sagId), ret ? "Sagsnummeret er rettet" : "Registreret som anmeldt", luk);
          }}
        >
          {!ret && anmeldUrl && (
            <a href={anmeldUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-semibold text-groen hover:underline">
              Åbn {transportoerNavn}s anmeldelse ↗<span className="sr-only"> (åbner i et nyt vindue)</span>
            </a>
          )}
          <div>
            <label htmlFor={`${id}-nr`} className="block text-sm font-medium text-neutral-800">
              {transportoerNavn}s sagsnummer
            </label>
            <input id={`${id}-nr`} name="sagsnummer" defaultValue={sagsnummer ?? ""} required maxLength={100} autoComplete="off" disabled={sender} className={FELT} />
            <p className="mt-1 text-xs text-neutral-500">Står i kvitteringen fra {transportoerNavn}. Kun synligt for BidHamr.</p>
          </div>
          <Fejl fejl={fejl} />
          <Knapper sender={sender} onLuk={luk} bekraeft={ret ? "Gem sagsnummer" : "Registrér som anmeldt"} />
        </form>
      )}
    </DialogKnap>
  );
}

// ------------------------------------------------------------------ Godkendt

// Under Stripes mindste udbetaling (databasen tjekker igen). Ugyldigt format
// afgøres af serveren (fortolkKroner).
function forLilleBeloeb(v: string): string | null {
  const b = fortolkKroner(v);
  return "oere" in b && b.oere < REKLAMATION_MIN_OERE ? REKLAMATION_MIN_TEKST : null;
}

function GodkendKnap({ reklamationId, sagId, transportoerNavn, kravbeloebOere }: { reklamationId: string; sagId: string; transportoerNavn: string; kravbeloebOere: number }) {
  const id = useId();
  return (
    <DialogKnap
      tekst="Godkendt"
      stil="btn-primaer"
      titel={`${transportoerNavn} har godkendt erstatningen`}
      beskrivelse={`Skriv det beløb, ${transportoerNavn} har godkendt. Sælgeren får besked om, at pengene udbetales, når ${transportoerNavn} har betalt BidHamr. Chefen udbetaler bagefter.`}
    >
      {({ sender, fejl, setFejl, send, luk }) => (
        <form
          method="post"
          className="space-y-4"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const beloeb = String(new FormData(e.currentTarget).get("beloeb") ?? "").trim();
            if (!beloeb) {
              setFejl("Skriv det godkendte beløb i kroner, fx 1.250,00.");
              return;
            }
            const minFejl = forLilleBeloeb(beloeb);
            if (minFejl) {
              setFejl(minFejl);
              return;
            }
            void send(() => godkendReklamation(reklamationId, beloeb, sagId), "Registreret som godkendt", luk);
          }}
        >
          <div>
            <label htmlFor={`${id}-beloeb`} className="block text-sm font-medium text-neutral-800">
              Godkendt beløb i kr.
            </label>
            <input id={`${id}-beloeb`} name="beloeb" inputMode="decimal" autoComplete="off" required placeholder="Fx 1.250,00" disabled={sender} className={FELT} />
            <p className="mt-1 text-xs text-neutral-500">
                Mindst {kroner(REKLAMATION_MIN_OERE)} (Stripes mindste udbetaling) og højst {kroner(kravbeloebOere)} (kravbeløbet).
              </p>
          </div>
          <Fejl fejl={fejl} />
          <Knapper sender={sender} onLuk={luk} bekraeft="Registrér som godkendt" />
        </form>
      )}
    </DialogKnap>
  );
}

// ------------------------------------------------------------------ Afvist

function AfvisKnap({ reklamationId, sagId, transportoerNavn }: { reklamationId: string; sagId: string; transportoerNavn: string }) {
  const id = useId();
  return (
    <DialogKnap
      tekst="Afvist"
      titel={`${transportoerNavn} har afvist reklamationen`}
      beskrivelse="Så er det sælgerens tab – BidHamr dækker ikke. Sælgeren får besked med begrundelsen."
    >
      {({ sender, fejl, setFejl, send, luk }) => (
        <form
          method="post"
          className="space-y-4"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const grund = String(new FormData(e.currentTarget).get("grund") ?? "").trim();
            if (!grund) {
              setFejl("Skriv fragtfirmaets begrundelse. Den vises for sælgeren.");
              return;
            }
            void send(() => afvisReklamation(reklamationId, grund, sagId), "Registreret som afvist", luk);
          }}
        >
          <div>
            <label htmlFor={`${id}-grund`} className="block text-sm font-medium text-neutral-800">
              {transportoerNavn}s begrundelse <span className="font-normal text-neutral-500">(vises for sælgeren)</span>
            </label>
            <textarea id={`${id}-grund`} name="grund" rows={3} required maxLength={1000} disabled={sender} className={FELT} placeholder="Fx: Skaden kan ikke henføres til transporten." />
          </div>
          <Fejl fejl={fejl} />
          <Knapper sender={sender} onLuk={luk} bekraeft="Registrér som afvist" fare />
        </form>
      )}
    </DialogKnap>
  );
}

// ------------------------------------------------------------------ Udbetal (chef)

function UdbetalKnap({
  reklamationId,
  sagId,
  transportoerNavn,
  godkendtBeloebOere,
  genoptag,
}: {
  reklamationId: string;
  sagId: string;
  transportoerNavn: string;
  godkendtBeloebOere: number;
  // Et tidligere forsøg er sat i gang uden et sikkert svar fra Stripe.
  genoptag: boolean;
}) {
  const id = useId();
  const [modtaget, setModtaget] = useState(false);
  return (
    <DialogKnap
      tekst={genoptag ? "Udbetal til sælger (prøv igen)" : "Udbetal til sælger"}
      stil="btn-primaer"
      titel={`Udbetal ${kroner(godkendtBeloebOere)} til sælgeren`}
      beskrivelse={
        <>
          Hele det godkendte beløb sendes via Stripe fra BidHamrs Stripe-saldo til sælgerens Stripe-konto og derfra til
          sælgerens bank. BidHamr beholder intet. Gør det kun, når erstatningen fra {transportoerNavn} er modtaget (på
          banken eller modregnet på fakturaen).
          {genoptag && " Et tidligere forsøg fik ikke et sikkert svar fra Stripe – vi slår det op først, så der aldrig udbetales to gange."}
        </>
      }
    >
      {({ sender, fejl, setFejl, send, luk }) => (
        <form
          method="post"
          className="space-y-4"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (!modtaget) {
              setFejl(`Sæt flueben ved, at erstatningen er modtaget fra ${transportoerNavn}.`);
              return;
            }
            void send(
              () => udbetalReklamation(reklamationId, { erstatningModtaget: true }, sagId),
              "Erstatningen er udbetalt til sælgeren",
              () => {
                setModtaget(false);
                luk();
              },
            );
          }}
        >
          <label htmlFor={`${id}-modtaget`} className="flex min-h-11 items-start gap-3 rounded-lg border border-neutral-300 p-3 text-sm text-neutral-800">
            <input
              id={`${id}-modtaget`}
              type="checkbox"
              checked={modtaget}
              onChange={(e) => setModtaget(e.target.checked)}
              disabled={sender}
              className="mt-0.5 h-5 w-5 shrink-0 accent-groen"
            />
            <span>
              Erstatningen er modtaget fra {transportoerNavn}
              <span className="block text-xs text-neutral-500">Gemmes med dit navn og tidspunktet.</span>
            </span>
          </label>
          <Fejl fejl={fejl} />
          <Knapper sender={sender} onLuk={luk} bekraeft={`Udbetal ${kroner(godkendtBeloebOere)}`} spaerret={!modtaget} />
        </form>
      )}
    </DialogKnap>
  );
}

// Udbetalingen til sælgerens bank er annulleret hos Stripe (kun chefen).
function SendTilBankIgenKnap({
  reklamationId,
  sagId,
  godkendtBeloebOere,
  afvist = false,
}: {
  reklamationId: string;
  sagId: string;
  godkendtBeloebOere: number;
  // Stripe afviste udbetalingen endeligt (fx under mindste udbetaling) -
  // ellers blev den annulleret hos Stripe.
  afvist?: boolean;
}) {
  return (
    <DialogKnap
      tekst="Send til banken igen"
      stil="btn-primaer"
      titel={`Send ${kroner(godkendtBeloebOere)} til sælgerens bank igen`}
      beskrivelse={
        afvist
          ? "Stripe afviste udbetalingen til sælgerens bank, og den prøves ikke igen automatisk. Pengene står stadig på sælgerens Stripe-konto. Se fejlen og drift-loggen, og kontrollér i Stripe, før du sender igen. Der sendes aldrig mere end det godkendte beløb."
          : "Udbetalingen til sælgerens bank blev annulleret hos Stripe – ikke af BidHamr. Pengene står stadig på sælgerens Stripe-konto. Kontrollér i Stripe, hvorfor den blev annulleret, før du sender igen. Der sendes aldrig mere end det godkendte beløb."
      }
    >
      {({ sender, fejl, send, luk }) => (
        <form
          method="post"
          className="space-y-4"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            void send(() => sendReklamationTilBankIgen(reklamationId, sagId), "Erstatningen er sendt til sælgerens bank igen", luk);
          }}
        >
          <Fejl fejl={fejl} />
          <Knapper sender={sender} onLuk={luk} bekraeft="Send igen" />
        </form>
      )}
    </DialogKnap>
  );
}

// ------------------------------------------------------------------ Ret status

function RetStatusKnap({
  reklamationId,
  sagId,
  status,
  kravbeloebOere,
  sagsnummer,
}: {
  reklamationId: string;
  sagId: string;
  status: ReklamationStatus;
  kravbeloebOere: number;
  sagsnummer: string | null;
}) {
  const id = useId();
  const standard: ReklamationRetStatus = (REKLAMATION_RET_STATUSSER as readonly string[]).includes(status)
    ? (status as ReklamationRetStatus)
    : "afventer_bidhamr";
  const [ny, setNy] = useState<ReklamationRetStatus>(standard);
  return (
    <DialogKnap
      tekst="Ret status"
      titel="Ret reklamationens status"
      beskrivelse="Brug det, hvis noget er registreret forkert, eller svaret er kommet på anden vis. Sælgeren får ingen besked. Kan ikke bruges, når erstatningen er udbetalt."
    >
      {({ sender, fejl, setFejl, send, luk }) => (
        <form
          method="post"
          className="space-y-4"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const v = (k: string) => String(fd.get(k) ?? "").trim();
            if (!v("begrundelse")) {
              setFejl("Skriv en intern begrundelse for rettelsen.");
              return;
            }
            if (ny === "godkendt" && !v("beloeb")) {
              setFejl("Skriv det godkendte beløb i kroner, fx 1.250,00.");
              return;
            }
            const minFejl = ny === "godkendt" ? forLilleBeloeb(v("beloeb")) : null;
            if (minFejl) {
              setFejl(minFejl);
              return;
            }
            void send(
              () =>
                retReklamationStatus({
                  reklamationId,
                  status: ny,
                  beloebKr: v("beloeb"),
                  sagsnummer: v("sagsnummer"),
                  grund: v("grund"),
                  begrundelse: v("begrundelse"),
                  sagId,
                }),
              "Status er rettet",
              luk,
            );
          }}
        >
          <div>
            <label htmlFor={`${id}-status`} className="block text-sm font-medium text-neutral-800">
              Ny status
            </label>
            <select
              id={`${id}-status`}
              name="status"
              value={ny}
              onChange={(e) => setNy(e.target.value as ReklamationRetStatus)}
              disabled={sender}
              className={`${FELT} h-11 bg-white`}
            >
              {REKLAMATION_RET_STATUSSER.map((s) => (
                <option key={s} value={s}>
                  {REKLAMATION_STATUS_STAFF[s]}
                </option>
              ))}
            </select>
          </div>
          {ny === "godkendt" && (
            <div>
              <label htmlFor={`${id}-beloeb`} className="block text-sm font-medium text-neutral-800">
                Godkendt beløb i kr.
              </label>
              <input id={`${id}-beloeb`} name="beloeb" inputMode="decimal" autoComplete="off" required placeholder="Fx 1.250,00" disabled={sender} className={FELT} />
              <p className="mt-1 text-xs text-neutral-500">
                Mindst {kroner(REKLAMATION_MIN_OERE)} (Stripes mindste udbetaling) og højst {kroner(kravbeloebOere)} (kravbeløbet).
              </p>
            </div>
          )}
          {(ny === "anmeldt" || ny === "godkendt" || ny === "afvist") && (
            <div>
              <label htmlFor={`${id}-nr`} className="block text-sm font-medium text-neutral-800">
                Fragtfirmaets sagsnummer {sagsnummer ? <span className="font-normal text-neutral-500">(valgfrit – bevares ellers)</span> : null}
              </label>
              <input id={`${id}-nr`} name="sagsnummer" defaultValue={sagsnummer ?? ""} maxLength={100} autoComplete="off" disabled={sender} className={FELT} />
            </div>
          )}
          {ny === "afvist" && (
            <div>
              <label htmlFor={`${id}-grund`} className="block text-sm font-medium text-neutral-800">
                Fragtfirmaets begrundelse <span className="font-normal text-neutral-500">(vises for sælgeren)</span>
              </label>
              <textarea id={`${id}-grund`} name="grund" rows={2} maxLength={1000} disabled={sender} className={FELT} />
            </div>
          )}
          <div>
            <label htmlFor={`${id}-beg`} className="block text-sm font-medium text-neutral-800">
              Intern begrundelse
            </label>
            <textarea
              id={`${id}-beg`}
              name="begrundelse"
              rows={3}
              required
              maxLength={2000}
              disabled={sender}
              placeholder="Fx: DAO svarede på mail, at de har godkendt 1.200 kr."
              className={FELT}
            />
            <p className="mt-1 text-xs text-neutral-500">Kun synlig for BidHamr. Gemmes i loggen.</p>
          </div>
          <Fejl fejl={fejl} />
          <Knapper sender={sender} onLuk={luk} bekraeft="Ret status" />
        </form>
      )}
    </DialogKnap>
  );
}

// ------------------------------------------------------------------ Annullér

function AnnullerKnap({ reklamationId, sagId }: { reklamationId: string; sagId: string }) {
  const id = useId();
  return (
    <DialogKnap
      tekst="Annullér"
      stil="btn-fare"
      titel="Annullér reklamationen"
      beskrivelse="Reklamationen stoppes, og sælgeren får en besked med din begrundelse."
    >
      {({ sender, fejl, setFejl, send, luk }) => (
        <form
          method="post"
          className="space-y-4"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const grund = String(new FormData(e.currentTarget).get("grund") ?? "").trim();
            if (!grund) {
              setFejl("Skriv en begrundelse. Den vises for sælgeren.");
              return;
            }
            void send(() => annullerReklamation(reklamationId, grund, sagId), "Reklamationen er annulleret", luk);
          }}
        >
          <div>
            <label htmlFor={`${id}-grund`} className="block text-sm font-medium text-neutral-800">
              Begrundelse til sælgeren
            </label>
            <textarea
              id={`${id}-grund`}
              name="grund"
              rows={3}
              required
              maxLength={1000}
              disabled={sender}
              placeholder="Fx: Skaden skyldes ikke fragten, så der kan ikke reklameres."
              className={FELT}
            />
          </div>
          <Fejl fejl={fejl} />
          <Knapper sender={sender} onLuk={luk} bekraeft="Annullér reklamationen" fare />
        </form>
      )}
    </DialogKnap>
  );
}

// ------------------------------------------------------------------ Kvittér

// Sagen er ændret efter anmeldelsen: "set - reklamationen fortsætter".
// aarsag: hvorfor sagen er ændret (fragt_reklamation_betingelser): null =
// betingelserne er opfyldt igen, undefined = ukendt. Er årsagen ikke
// midlertidig (anke), afviser databasen kvitteringen - så vises kun årsagen
// og henvisningen til annullér/ret status.
function KvitterKnap({ reklamationId, sagId, aarsag }: { reklamationId: string; sagId: string; aarsag?: string | null }) {
  const id = useId();
  const kendt = aarsag !== undefined;
  const tilladt = !kendt || kanKvittere(aarsag);
  return (
    <DialogKnap
      tekst="Kvittér for ændringen"
      titel="Kvittér for den ændrede sag"
      beskrivelse={'Reklamationen fortsætter uændret, og "Godkendt" og udbetalingen er igen mulige (udbetalingen kræver dog, at betingelserne er helt opfyldt). Sælgeren får besked. Skal reklamationen stoppes, så annullér eller ret status i stedet.'}
    >
      {({ sender, fejl, setFejl, send, luk }) => (
        <>
          {kendt && (
            <p
              role="note"
              className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
                tilladt ? "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst" : "border-fejl-kant bg-fejl-bg text-fejl-tekst"
              }`}
            >
              {aarsag === null
                ? "Betingelserne er opfyldt igen: køberen er refunderet, afgørelsen er endelig, og indpakningen er ordentlig."
                : tilladt
                  ? `Årsag: ${betingelseTekst(aarsag)}. Du kan lade reklamationen fortsætte. Ender sagen alligevel ikke til købers fordel, markeres den som ændret igen.`
                  : `Årsag: ${betingelseTekst(aarsag)}. Reklamationen kan derfor ikke fortsætte. Annullér den, eller ret status.`}
            </p>
          )}
          {!tilladt ? (
            <div className="flex justify-end">
              <button type="button" onClick={luk} className="btn btn-sekundaer">
                Luk
              </button>
            </div>
          ) : (
            <form
              method="post"
              className="space-y-4"
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                const begrundelse = String(new FormData(e.currentTarget).get("begrundelse") ?? "").trim();
                if (!begrundelse) {
                  setFejl("Skriv en intern begrundelse.");
                  return;
                }
                void send(() => kvitterSagAendret(reklamationId, begrundelse, sagId), "Kvitteret – reklamationen fortsætter", luk);
              }}
            >
              <div>
                <label htmlFor={`${id}-beg`} className="block text-sm font-medium text-neutral-800">
                  Intern begrundelse
                </label>
                <textarea
                  id={`${id}-beg`}
                  name="begrundelse"
                  rows={3}
                  required
                  maxLength={2000}
                  disabled={sender}
                  placeholder="Fx: Anken handler kun om returfragten – skaden og refusionen står ved magt."
                  className={FELT}
                />
                <p className="mt-1 text-xs text-neutral-500">Kun synlig for BidHamr. Gemmes i loggen.</p>
              </div>
              <Fejl fejl={fejl} />
              <Knapper sender={sender} onLuk={luk} bekraeft="Kvittér" />
            </form>
          )}
        </>
      )}
    </DialogKnap>
  );
}

// ------------------------------------------------------------------ Note

export function ReklamationNote({
  reklamationId,
  sagId,
  note,
  inhabil,
}: {
  reklamationId: string;
  sagId: string;
  note: string | null;
  inhabil: boolean;
}) {
  const id = useId();
  const hydreret = useHydreret();
  const [tekst, setTekst] = useState(note ?? "");
  const { sender, fejl, send } = useSend();
  const aendret = tekst.trim() !== (note ?? "").trim();

  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void send(() => gemReklamationNote(reklamationId, tekst, sagId), "Noten er gemt");
  }

  return (
    <form onSubmit={indsend} method="post" className="space-y-3">
      <label htmlFor={`${id}-note`} className="sr-only">
        Intern note
      </label>
      <textarea
        id={`${id}-note`}
        value={tekst}
        onChange={(e) => setTekst(e.target.value)}
        rows={4}
        maxLength={4000}
        disabled={sender || inhabil}
        placeholder="Fx: Anmeldt på omdeling.info 3. nov. – DAO svarer inden for 14 dage."
        className={FELT}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">Kun synlig for BidHamr – aldrig for sælgeren.</p>
        <button type="submit" disabled={sender || !aendret || inhabil || !hydreret} aria-busy={sender} className="btn btn-sekundaer btn-lille">
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          Gem note
        </button>
      </div>
      <Fejl fejl={fejl} />
    </form>
  );
}

// ------------------------------------------------------------------ Samlet

export default function ReklamationStaffHandlinger({
  reklamationId,
  sagId,
  status,
  kravbeloebOere,
  godkendtBeloebOere,
  sagsnummer,
  transportoerNavn,
  anmeldUrl,
  inhabil,
  erChef,
  udbetalingIGang = false,
  sagAendret = false,
  sagAendretAarsag,
  bankAnnulleret = false,
  bankAfvist = false,
}: {
  reklamationId: string;
  sagId: string;
  status: ReklamationStatus;
  kravbeloebOere: number;
  godkendtBeloebOere: number | null;
  sagsnummer: string | null;
  transportoerNavn: string;
  anmeldUrl: string | null;
  inhabil: boolean;
  // Kun chefen ser "Udbetal til sælger" (databasen tjekker rollen igen).
  erChef: boolean;
  // Chefens udbetaling er sat i gang uden et sikkert svar fra Stripe.
  udbetalingIGang?: boolean;
  // Sagen er ændret efter anmeldelsen, og ingen har kvitteret.
  sagAendret?: boolean;
  // Hvorfor (fragt_reklamation_betingelser): null = opfyldt igen, undefined = ukendt.
  sagAendretAarsag?: string | null;
  // Udbetalingen til sælgerens bank er annulleret hos Stripe eller afvist
  // endeligt af Stripe (og transferen er ikke tilbageført) - chefen kan
  // sende igen.
  bankAnnulleret?: boolean;
  // ... og det var en endelig afvisning (fx amount_too_small).
  bankAfvist?: boolean;
}) {
  if (inhabil) {
    return (
      <p className="rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2 text-sm text-advarsel-tekst">
        Du er inhabil: du er part i handlen eller har handlet med en af parterne. Lad en kollega tage den.
      </p>
    );
  }
  if (status === "udbetalt" && bankAnnulleret) {
    return (
      <div className="flex flex-col gap-2">
        <p className="rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
          {bankAfvist
            ? "Stripe afviste udbetalingen til sælgerens bank endeligt (se fejlen nedenfor)."
            : "Udbetalingen til sælgerens bank blev annulleret hos Stripe."}{" "}
          Pengene står på sælgerens Stripe-konto og sendes ikke automatisk igen.{!erChef && " Kun chefen kan sende dem igen."}
        </p>
        {erChef && godkendtBeloebOere != null && (
          <div>
            <SendTilBankIgenKnap reklamationId={reklamationId} sagId={sagId} godkendtBeloebOere={godkendtBeloebOere} afvist={bankAfvist} />
          </div>
        )}
      </div>
    );
  }
  if (status === "udbetalt") {
    return <p className="text-sm text-neutral-600">Erstatningen er udbetalt til sælgeren. Der er ikke mere at gøre.</p>;
  }
  const kanAnnullere = (status === "afventer_bidhamr" || status === "anmeldt" || status === "godkendt") && !udbetalingIGang;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
      {sagAendret && <KvitterKnap reklamationId={reklamationId} sagId={sagId} aarsag={sagAendretAarsag} />}
      {status === "afventer_bidhamr" && (
        <AnmeldKnap reklamationId={reklamationId} sagId={sagId} transportoerNavn={transportoerNavn} anmeldUrl={anmeldUrl} sagsnummer={sagsnummer} />
      )}
      {status === "anmeldt" && !sagAendret && (
        <GodkendKnap reklamationId={reklamationId} sagId={sagId} transportoerNavn={transportoerNavn} kravbeloebOere={kravbeloebOere} />
      )}
      {status === "anmeldt" && <AfvisKnap reklamationId={reklamationId} sagId={sagId} transportoerNavn={transportoerNavn} />}
      {status === "anmeldt" && (
        <AnmeldKnap reklamationId={reklamationId} sagId={sagId} transportoerNavn={transportoerNavn} anmeldUrl={anmeldUrl} sagsnummer={sagsnummer} ret />
      )}
      {status === "godkendt" && erChef && !sagAendret && godkendtBeloebOere != null && (
        <UdbetalKnap
          reklamationId={reklamationId}
          sagId={sagId}
          transportoerNavn={transportoerNavn}
          godkendtBeloebOere={godkendtBeloebOere}
          genoptag={udbetalingIGang}
        />
      )}
      {!udbetalingIGang && (
        <RetStatusKnap reklamationId={reklamationId} sagId={sagId} status={status} kravbeloebOere={kravbeloebOere} sagsnummer={sagsnummer} />
      )}
      {kanAnnullere && <AnnullerKnap reklamationId={reklamationId} sagId={sagId} />}
    </div>
  );
}
