"use client";

// Erhvervsformularen på /erhverv/formular. Sendes via /api/offentlig (ikke en
// server action), så den også virker for en indlogget almindelig bruger, mens
// siden er lukket (gaten i src/lib/supabase/middleware.ts). Serveren
// (sendErhvervHenvendelse) tjekker alt igen: honeypot "hjemmeside",
// tidsfælde "t" og rate limits.
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { kaldOffentligHandling } from "@/lib/offentligHandling";
import type { sendErhvervHenvendelse } from "@/app/actions/erhverv";
import { ERHVERV_FORMULAR as F } from "@/lib/tekster/erhverv";
import { EMAIL, ERHVERV_GRAENSER as G, POSTNUMMER, renCvr, renTelefon } from "@/lib/erhverv/regler";
import { E_FEJL, E_HJAELP, E_KNAP_PRIMAER, E_LABEL, eFelt, eTekstfelt } from "@/components/erhverv/stil";

type Navn =
  | "firmanavn"
  | "cvr"
  | "kontaktperson"
  | "telefon"
  | "email"
  | "adresse"
  | "postnummer"
  | "by"
  | "hvad_saelger_i"
  | "antal_varer_ca"
  | "besked";

type Felt = {
  navn: Navn;
  tekst: { label: string; hjaelp: string; pladsholder: string };
  valgfri?: boolean;
  type?: "text" | "email" | "tel";
  inputMode?: "numeric" | "tel" | "email" | "text";
  autoComplete?: string;
  lang?: boolean;
  maks: number;
};

const FELTER: Felt[] = [
  { navn: "firmanavn", tekst: F.felter.firmanavn, autoComplete: "organization", maks: G.firmanavn },
  { navn: "cvr", tekst: F.felter.cvr, inputMode: "numeric", autoComplete: "off", maks: 12 },
  { navn: "kontaktperson", tekst: F.felter.kontaktperson, autoComplete: "name", maks: G.kontaktperson },
  { navn: "telefon", tekst: F.felter.telefon, type: "tel", inputMode: "tel", autoComplete: "tel", maks: G.telefonMaks },
  { navn: "email", tekst: F.felter.email, type: "email", inputMode: "email", autoComplete: "email", maks: G.email },
  { navn: "adresse", tekst: F.felter.adresse, valgfri: true, autoComplete: "street-address", maks: G.adresse },
  { navn: "postnummer", tekst: F.felter.postnummer, valgfri: true, inputMode: "numeric", autoComplete: "postal-code", maks: 4 },
  { navn: "by", tekst: F.felter.by, valgfri: true, autoComplete: "address-level2", maks: G.by },
  { navn: "hvad_saelger_i", tekst: F.felter.hvadSaelger, lang: true, maks: G.hvadSaelgerI },
  { navn: "antal_varer_ca", tekst: F.felter.antalVarer, valgfri: true, inputMode: "numeric", maks: 10 },
  { navn: "besked", tekst: F.felter.besked, valgfri: true, lang: true, maks: G.besked },
];

type Vaerdier = Record<Navn, string>;
const TOM = Object.fromEntries(FELTER.map((f) => [f.navn, ""])) as Vaerdier;

function valider(v: Vaerdier): Partial<Record<Navn, string>> {
  const f: Partial<Record<Navn, string>> = {};
  for (const felt of FELTER) {
    const s = v[felt.navn].trim();
    if (!felt.valgfri && !s) f[felt.navn] = F.fejl.mangler;
    else if (s.length > felt.maks) f[felt.navn] = F.fejl.forLang;
  }
  if (!f.cvr && !renCvr(v.cvr)) f.cvr = F.fejl.cvrUgyldigt;
  if (!f.telefon && !renTelefon(v.telefon)) f.telefon = F.fejl.telefonUgyldigt;
  if (!f.email && !EMAIL.test(v.email.trim())) f.email = F.fejl.emailUgyldig;
  if (!f.postnummer && v.postnummer.trim() && !POSTNUMMER.test(v.postnummer.trim())) {
    f.postnummer = F.fejl.postnummerUgyldigt;
  }
  const antalRaa = v.antal_varer_ca.replace(/[.\s]/g, "");
  if (!f.antal_varer_ca && antalRaa && (!/^\d{1,8}$/.test(antalRaa) || Number(antalRaa) > G.antalVarerMaks)) {
    f.antal_varer_ca = F.fejl.antalUgyldigt;
  }
  return f;
}

function erNavn(s: unknown): s is Navn {
  return typeof s === "string" && FELTER.some((f) => f.navn === s);
}

export default function ErhvervFormular() {
  const [v, setV] = useState<Vaerdier>(TOM);
  const [hjemmeside, setHjemmeside] = useState("");
  const [forsoegt, setForsoegt] = useState(false);
  const [serverFejl, setServerFejl] = useState<{ tekst: string; felt?: Navn } | null>(null);
  const [sender, setSender] = useState(false);
  const [sendt, setSendt] = useState(false);
  const startRef = useRef<number>(0);
  const senderRef = useRef(false);
  const fejlBoksRef = useRef<HTMLDivElement>(null);
  const kvitteringRef = useRef<HTMLHeadingElement>(null);

  // Tidsfælde: hvornår formularen blev vist (sættes efter mount, så server-
  // og klient-render er ens).
  useEffect(() => {
    startRef.current = Date.now();
  }, []);

  useEffect(() => {
    if (sendt) kvitteringRef.current?.focus();
  }, [sendt]);

  const feltFejl = forsoegt ? valider(v) : {};
  if (serverFejl?.felt && !feltFejl[serverFejl.felt]) feltFejl[serverFejl.felt] = serverFejl.tekst;
  const antalFejl = Object.keys(feltFejl).length;

  function saet(navn: Navn, vaerdi: string) {
    setV((gl) => ({ ...gl, [navn]: vaerdi }));
    if (serverFejl?.felt === navn) setServerFejl(null);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (senderRef.current) return;
    setForsoegt(true);
    setServerFejl(null);
    const f = valider(v);
    const foerste = FELTER.find((x) => f[x.navn]);
    if (foerste) {
      document.getElementById(`erhverv-${foerste.navn}`)?.focus();
      return;
    }

    senderRef.current = true;
    setSender(true);
    const fd = new FormData();
    for (const felt of FELTER) fd.set(felt.navn, v[felt.navn]);
    fd.set("hjemmeside", hjemmeside);
    fd.set("t", String(startRef.current || Date.now()));
    const svar = await kaldOffentligHandling<Awaited<ReturnType<typeof sendErhvervHenvendelse>>>(
      "erhverv-henvendelse",
      fd,
    );
    senderRef.current = false;
    setSender(false);

    if ("ok" in svar && svar.ok) {
      setSendt(true);
      window.scrollTo({ top: 0 });
      return;
    }
    const fejl = "fejl" in svar ? svar : { fejl: F.fejl.generisk };
    const felt = "felt" in fejl && erNavn(fejl.felt) ? fejl.felt : undefined;
    setServerFejl({ tekst: fejl.fejl || F.fejl.generisk, felt });
    if (felt) document.getElementById(`erhverv-${felt}`)?.focus();
    else window.requestAnimationFrame(() => fejlBoksRef.current?.focus());
  }

  if (sendt) {
    return (
      <div role="status" className="rounded-[18px] border border-succes-kant bg-succes-bg p-6 sm:p-8">
        <h2 ref={kvitteringRef} tabIndex={-1} className="text-[26px] leading-tight text-succes-tekst outline-none">
          {F.kvittering.titel}
        </h2>
        <p className="mt-3 text-[18px] leading-relaxed text-tekst">{F.kvittering.tekst}</p>
        <p className="mt-2 text-[18px] leading-relaxed text-tekst">{F.kvittering.tekst2}</p>
        <Link href="/" className={`${E_KNAP_PRIMAER} mt-6 w-full sm:w-auto`}>
          {F.kvittering.knapForside}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={send} noValidate className="space-y-7">
      {forsoegt && antalFejl > 0 && !serverFejl && (
        <div role="alert" className="rounded-xl border-2 border-fejl-kant bg-fejl-bg p-4 text-[18px] font-semibold text-fejl-tekst">
          {F.fejl.manglerFlere}
        </div>
      )}
      {serverFejl && !serverFejl.felt && (
        <div
          ref={fejlBoksRef}
          tabIndex={-1}
          role="alert"
          className="rounded-xl border-2 border-fejl-kant bg-fejl-bg p-4 text-[18px] font-semibold text-fejl-tekst outline-none"
        >
          {serverFejl.tekst}
        </div>
      )}

      {FELTER.map((felt) => {
        const id = `erhverv-${felt.navn}`;
        const fejl = feltFejl[felt.navn];
        const beskrevet = [felt.tekst.hjaelp ? `${id}-hjaelp` : "", fejl ? `${id}-fejl` : ""].filter(Boolean).join(" ");
        const faelles = {
          id,
          name: felt.navn,
          value: v[felt.navn],
          placeholder: felt.tekst.pladsholder,
          maxLength: felt.maks,
          "aria-invalid": fejl ? true : undefined,
          "aria-describedby": beskrevet || undefined,
          "aria-required": felt.valgfri ? undefined : true,
        } as const;
        return (
          <div key={felt.navn}>
            <label htmlFor={id} className={E_LABEL}>
              {felt.tekst.label}
              {felt.valgfri && <span className="ml-2 font-normal text-tekst-daempet">{F.valgfri}</span>}
            </label>
            {felt.lang ? (
              <textarea
                {...faelles}
                rows={5}
                onChange={(e) => saet(felt.navn, e.target.value)}
                className={eTekstfelt(!!fejl)}
              />
            ) : (
              <input
                {...faelles}
                type={felt.type ?? "text"}
                inputMode={felt.inputMode}
                autoComplete={felt.autoComplete}
                onChange={(e) => saet(felt.navn, e.target.value)}
                className={eFelt(!!fejl)}
              />
            )}
            {felt.tekst.hjaelp && (
              <p id={`${id}-hjaelp`} className={E_HJAELP}>
                {felt.tekst.hjaelp}
              </p>
            )}
            {fejl && (
              <p id={`${id}-fejl`} className={E_FEJL}>
                <span aria-hidden="true">!</span>
                <span>{fejl}</span>
              </p>
            )}
          </div>
        );
      })}

      {/* Honeypot: skjult for mennesker og skærmlæsere. Robotter udfylder den. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="erhverv-hjemmeside">Hjemmeside</label>
        <input
          id="erhverv-hjemmeside"
          name="hjemmeside"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={hjemmeside}
          onChange={(e) => setHjemmeside(e.target.value)}
        />
      </div>

      <button type="submit" disabled={sender} aria-busy={sender || undefined} className={`${E_KNAP_PRIMAER} w-full`}>
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        {sender ? F.knapSender : F.knapSend}
      </button>
    </form>
  );
}
