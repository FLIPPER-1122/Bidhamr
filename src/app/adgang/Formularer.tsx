"use client";

// Formularerne på admin-hostens login-sider (/adgang/*). Al logik ligger i
// src/app/actions/adgang.ts - her er kun visning og navigation.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type * as A from "@/lib/adgang";
import { FELT, FORMULAR_FEJL, LABEL, LINK, SUCCES_BOKS } from "@/components/konto/felter";
import { hovedsiteUrl } from "@/lib/adminVaert";
import { useHydreret } from "@/lib/useHydreret";

const NETVAERK = "Der er ingen forbindelse lige nu. Prøv igen.";
const KORT = "rounded-[14px] border border-kant bg-white p-5 shadow-kort sm:p-8";
const KODEFELT = `${FELT} text-center text-xl tracking-[0.4em] tabular-nums`;

// Handlingerne er route handlers (POST /adgang/api/<handling>), ikke server
// actions - se src/app/adgang/api/[handling]/route.ts.
type Svar<F extends (...a: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;
async function kald<T>(handling: string, krop: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`/adgang/api/${handling}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(krop),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.headers.get("content-type")?.includes("application/json")) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function Spinner() {
  return <span className="btn-spinner" aria-hidden="true" />;
}

export function LukketBesked() {
  return (
    <p role="status" className="mt-4 rounded-xl border border-advarsel-kant bg-advarsel-bg p-4 text-sm text-advarsel-tekst">
      Du har ikke sat to-trins-login op, og tilmeldingen er lukket. Bed chefen om at åbne for den under
      Admin → Medarbejdere. Så får du en mail.
    </p>
  );
}

export function LogUdLink({ tekst = "Log ud" }: { tekst?: string }) {
  const router = useRouter();
  const [venter, setVenter] = useState(false);
  return (
    <button
      type="button"
      disabled={venter}
      onClick={async () => {
        setVenter(true);
        await kald("logud").catch(() => null);
        router.push("/adgang/login");
        router.refresh();
      }}
      className={`${LINK} inline-flex min-h-11 items-center text-sm`}
    >
      {tekst}
    </button>
  );
}

// --- Log ind ------------------------------------------------------------------

export function AdminLoginForm({ naeste }: { naeste: string }) {
  const router = useRouter();
  const hydreret = useHydreret();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [venter, setVenter] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [lukket, setLukket] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    setVenter(true);
    setFejl(null);
    setLukket(false);
    let svar: Svar<typeof A.logIndAdmin>;
    try {
      svar = await kald("login", { email, password });
    } catch {
      setVenter(false);
      setFejl(NETVAERK);
      return;
    }
    if ("fejl" in svar) {
      setVenter(false);
      setFejl(svar.fejl);
      return;
    }
    if (svar.naeste === "lukket") {
      setVenter(false);
      setPassword("");
      setLukket(true);
      return;
    }
    const q = `?naeste=${encodeURIComponent(naeste)}`;
    router.push(svar.naeste === "kode" ? `/adgang/kode${q}` : "/adgang/opsaet");
  }

  return (
    <div className={KORT}>
      <h1 className="text-[26px] leading-tight sm:text-[30px]">Log ind i admin</h1>
      <p className="mt-1 text-sm text-tekst-svag">Kun for BidHamrs medarbejdere. Bagefter skal du bruge koden fra din app.</p>
      {lukket && <LukketBesked />}
      <form onSubmit={send} method="post" className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className={LABEL}>
            E-mail
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`mt-1.5 ${FELT}`}
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="password" className={LABEL}>
              Adgangskode
            </label>
            <a href={hovedsiteUrl("/glemt-adgangskode")} className={`${LINK} inline-flex min-h-11 items-center text-[13px]`}>
              Glemt adgangskode?
            </a>
          </div>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`mt-1.5 ${FELT}`}
          />
        </div>
        {fejl && (
          <p role="alert" className={FORMULAR_FEJL}>
            {fejl}
          </p>
        )}
        <button type="submit" disabled={venter || !hydreret} aria-busy={venter || undefined} className="btn btn-primaer btn-stor w-full">
          {venter && <Spinner />}
          Log ind
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-tekst-svag">
        Mistet din telefon?{" "}
        <Link href="/adgang/gendan" className={LINK}>
          Brug en gendannelseskode
        </Link>
      </p>
    </div>
  );
}

// --- Koden fra app'en -----------------------------------------------------------

export function AdminKodeForm({ naeste, fornyelse }: { naeste: string; fornyelse: boolean }) {
  const hydreret = useHydreret();
  const [kode, setKode] = useState("");
  const [venter, setVenter] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    setVenter(true);
    setFejl(null);
    let svar: Svar<typeof A.bekraeftAdminKode>;
    try {
      svar = await kald("kode", { kode });
    } catch {
      setVenter(false);
      setFejl(NETVAERK);
      return;
    }
    if ("fejl" in svar) {
      setVenter(false);
      setKode("");
      setFejl(svar.fejl);
      return;
    }
    // Fuld indlæsning, så admin-layoutet læser den nye session.
    window.location.assign(naeste);
  }

  return (
    <div className={KORT}>
      <h1 className="text-[26px] leading-tight sm:text-[30px]">Skriv koden fra din app</h1>
      <p className="mt-1 text-sm text-tekst-svag">
        {fornyelse
          ? "Det er et stykke tid siden, du sidst skrev en kode. Skriv den nye kode fra din app for at fortsætte."
          : "Åbn din app (fx Google Authenticator eller 1Password), og skriv de 6 cifre for BidHamr Admin."}
      </p>
      <form onSubmit={send} method="post" className="mt-6 space-y-4">
        <div>
          <label htmlFor="kode" className={LABEL}>
            Kode
          </label>
          <input
            id="kode"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            maxLength={7}
            value={kode}
            onChange={(e) => setKode(e.target.value)}
            className={`mt-1.5 ${KODEFELT}`}
          />
        </div>
        {fejl && (
          <p role="alert" className={FORMULAR_FEJL}>
            {fejl}
          </p>
        )}
        <button type="submit" disabled={venter || !hydreret} aria-busy={venter || undefined} className="btn btn-primaer btn-stor w-full">
          {venter && <Spinner />}
          Fortsæt
        </button>
      </form>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm text-tekst-svag">
        <Link href="/adgang/gendan" className={`${LINK} inline-flex min-h-11 items-center`}>
          Mistet din telefon?
        </Link>
        <LogUdLink />
      </div>
    </div>
  );
}

// --- Opsætning ------------------------------------------------------------------

type Trin = { slags: "start" } | { slags: "scan"; faktorId: string; qr: string; hemmelighed: string } | { slags: "koder"; koder: string[] };

export function AdminOpsaetForm({ mailBekraeftet }: { mailBekraeftet: boolean }) {
  const router = useRouter();
  const hydreret = useHydreret();
  const [trin, setTrin] = useState<Trin>({ slags: "start" });
  // Trin 0: engangskoden fra mailen (adgangskoden alene er ikke nok).
  const [mailOk, setMailOk] = useState(mailBekraeftet);
  const [mailSendt, setMailSendt] = useState<string | null>(null);
  const [mailKode, setMailKode] = useState("");

  async function sendMail() {
    setVenter(true);
    setFejl(null);
    let svar: Svar<typeof A.sendMailKode>;
    try {
      svar = await kald("mail-kode");
    } catch {
      setVenter(false);
      setFejl(NETVAERK);
      return;
    }
    setVenter(false);
    if ("fejl" in svar) {
      setFejl(svar.fejl);
      return;
    }
    setMailSendt(svar.email);
  }

  async function bekraeftMail(e: FormEvent) {
    e.preventDefault();
    setVenter(true);
    setFejl(null);
    let svar: Svar<typeof A.bekraeftMailKode>;
    try {
      svar = await kald("mail-kode-bekraeft", { kode: mailKode });
    } catch {
      setVenter(false);
      setFejl(NETVAERK);
      return;
    }
    setVenter(false);
    if ("fejl" in svar) {
      setMailKode("");
      setFejl(svar.fejl);
      return;
    }
    setMailOk(true);
  }
  const [kode, setKode] = useState("");
  const [venter, setVenter] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [gemt, setGemt] = useState(false);
  const [kopieret, setKopieret] = useState(false);

  async function start() {
    setVenter(true);
    setFejl(null);
    let svar: Svar<typeof A.startToTrinOpsaet>;
    try {
      svar = await kald("opsaet-start");
    } catch {
      setVenter(false);
      setFejl(NETVAERK);
      return;
    }
    setVenter(false);
    if ("fejl" in svar) {
      if (svar.kode === "aktiv") {
        router.push("/adgang/kode");
        return;
      }
      if (svar.kode === "mail") setMailOk(false);
      setFejl(svar.fejl);
      return;
    }
    setTrin({ slags: "scan", faktorId: svar.faktorId, qr: svar.qr, hemmelighed: svar.hemmelighed });
  }

  async function bekraeft(e: FormEvent) {
    e.preventDefault();
    if (trin.slags !== "scan") return;
    setVenter(true);
    setFejl(null);
    let svar: Svar<typeof A.bekraeftToTrinOpsaet>;
    try {
      svar = await kald("opsaet-bekraeft", { faktorId: trin.faktorId, kode });
    } catch {
      setVenter(false);
      setFejl(NETVAERK);
      return;
    }
    setVenter(false);
    if ("fejl" in svar) {
      setKode("");
      setFejl(svar.fejl);
      return;
    }
    setTrin({ slags: "koder", koder: svar.koder });
  }

  if (trin.slags === "koder") {
    const tekst = `BidHamr Admin - gendannelseskoder\nHver kode kan bruges én gang, hvis du mister din telefon.\n\n${trin.koder.join("\n")}\n`;
    return (
      <div className={KORT}>
        <h1 className="text-[26px] leading-tight sm:text-[30px]">Gem dine gendannelseskoder</h1>
        <p className={`mt-4 ${SUCCES_BOKS}`} role="status">
          To-trins-login er sat op. Vi har sendt dig en mail.
        </p>
        <p className="mt-4 text-sm text-tekst-daempet">
          Mister du telefonen, kan du komme ind med en af koderne herunder. Hver kode virker én gang. De vises kun
          nu, så gem dem et sikkert sted, fx i din adgangskode-app.
        </p>
        <ol className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-admin-graa p-4 font-mono text-[15px] tabular-nums">
          {trin.koder.map((k) => (
            <li key={k}>{k}</li>
          ))}
        </ol>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-sekundaer btn-lille"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(tekst);
                setKopieret(true);
              } catch {
                setKopieret(false);
              }
            }}
          >
            {kopieret ? "Kopieret" : "Kopiér koderne"}
          </button>
          <a
            className="btn btn-sekundaer btn-lille"
            download="bidhamr-admin-gendannelseskoder.txt"
            href={`data:text/plain;charset=utf-8,${encodeURIComponent(tekst)}`}
          >
            Hent som fil
          </a>
        </div>
        <label className="mt-5 flex items-start gap-3 text-sm text-tekst">
          <input type="checkbox" checked={gemt} onChange={(e) => setGemt(e.target.checked)} className="mt-0.5 h-5 w-5 accent-groen" />
          Jeg har gemt koderne et sikkert sted.
        </label>
        <button
          type="button"
          disabled={!gemt}
          onClick={() => {
            router.push("/admin");
            router.refresh();
          }}
          className="btn btn-primaer btn-stor mt-4 w-full"
        >
          Gå til admin
        </button>
      </div>
    );
  }

  if (trin.slags === "scan") {
    return (
      <div className={KORT}>
        <h1 className="text-[26px] leading-tight sm:text-[30px]">Scan koden med din app</h1>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-tekst-daempet">
          <li>Åbn din app, og vælg at tilføje en konto.</li>
          <li>Scan QR-koden herunder.</li>
          <li>Skriv de 6 cifre, appen viser for BidHamr Admin.</li>
        </ol>
        <div className="mt-4 flex justify-center rounded-xl border border-kant bg-white p-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- QR-koden er et data:-billede fra Supabase */}
          <img src={trin.qr} alt="QR-kode til din app" width={200} height={200} className="h-[200px] w-[200px]" />
        </div>
        <details className="mt-3 text-sm text-tekst-daempet">
          <summary className="min-h-11 cursor-pointer py-2 font-medium text-groen">Kan du ikke scanne?</summary>
          <p className="mt-1">Skriv denne kode i appen i stedet:</p>
          <p className="mt-2 break-all rounded-lg bg-admin-graa p-3 font-mono text-[15px] text-tekst">{trin.hemmelighed}</p>
        </details>
        <form onSubmit={bekraeft} method="post" className="mt-5 space-y-4">
          <div>
            <label htmlFor="kode" className={LABEL}>
              Kode fra appen
            </label>
            <input
              id="kode"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={7}
              value={kode}
              onChange={(e) => setKode(e.target.value)}
              className={`mt-1.5 ${KODEFELT}`}
            />
          </div>
          {fejl && (
            <p role="alert" className={FORMULAR_FEJL}>
              {fejl}
            </p>
          )}
          <button type="submit" disabled={venter || !hydreret} aria-busy={venter || undefined} className="btn btn-primaer btn-stor w-full">
            {venter && <Spinner />}
            Bekræft
          </button>
        </form>
      </div>
    );
  }

  if (!mailOk) {
    return (
      <div className={KORT}>
        <h1 className="text-[26px] leading-tight sm:text-[30px]">Bekræft din e-mail</h1>
        <p className="mt-2 text-sm text-tekst-daempet">
          Før du sætter to-trins-login op, sender vi en kode til din e-mail. Så ved vi, at det er dig – ikke en,
          der kun kender din adgangskode.
        </p>
        {mailSendt && (
          <p role="status" className={`mt-4 ${SUCCES_BOKS}`}>
            Vi har sendt en kode til {mailSendt}. Den gælder i 15 minutter.
          </p>
        )}
        {fejl && (
          <p role="alert" className={`mt-4 ${FORMULAR_FEJL}`}>
            {fejl}
          </p>
        )}
        {mailSendt ? (
          <form onSubmit={bekraeftMail} method="post" className="mt-5 space-y-4">
            <div>
              <label htmlFor="mailkode" className={LABEL}>
                Kode fra mailen
              </label>
              <input
                id="mailkode"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                maxLength={7}
                value={mailKode}
                onChange={(e) => setMailKode(e.target.value)}
                className={`mt-1.5 ${KODEFELT}`}
              />
            </div>
            <button type="submit" disabled={venter || !hydreret} aria-busy={venter || undefined} className="btn btn-primaer btn-stor w-full">
              {venter && <Spinner />}
              Bekræft
            </button>
            <button type="button" onClick={sendMail} disabled={venter || !hydreret} className={`${LINK} inline-flex min-h-11 items-center text-sm`}>
              Send en ny kode
            </button>
          </form>
        ) : (
          <button type="button" onClick={sendMail} disabled={venter || !hydreret} aria-busy={venter || undefined} className="btn btn-primaer btn-stor mt-6 w-full">
            {venter && <Spinner />}
            Send kode til min e-mail
          </button>
        )}
        <div className="mt-4 text-center">
          <LogUdLink />
        </div>
      </div>
    );
  }

  return (
    <div className={KORT}>
      <h1 className="text-[26px] leading-tight sm:text-[30px]">Sæt to-trins-login op</h1>
      <p className="mt-2 text-sm text-tekst-daempet">
        For at komme ind i admin skal du bruge en kode fra en app på din telefon, hver gang du logger ind og
        mindst hver 12. time. Det beskytter vores brugere, hvis din adgangskode bliver stjålet.
      </p>
      <p className="mt-2 text-sm text-tekst-daempet">
        Du skal bruge en app som Google Authenticator, Microsoft Authenticator eller 1Password. Det tager et par
        minutter.
      </p>
      {fejl && (
        <p role="alert" className={`mt-4 ${FORMULAR_FEJL}`}>
          {fejl}
        </p>
      )}
      <button type="button" onClick={start} disabled={venter || !hydreret} aria-busy={venter || undefined} className="btn btn-primaer btn-stor mt-6 w-full">
        {venter && <Spinner />}
        Start
      </button>
      <div className="mt-4 text-center">
        <LogUdLink />
      </div>
    </div>
  );
}

// --- Gendannelseskode -----------------------------------------------------------

export function AdminGendanForm() {
  const router = useRouter();
  const hydreret = useHydreret();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [kode, setKode] = useState("");
  const [venter, setVenter] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    setVenter(true);
    setFejl(null);
    let svar: Svar<typeof A.gendanAdmin>;
    try {
      svar = await kald("gendan", { email, password, gendannelseskode: kode });
    } catch {
      setVenter(false);
      setFejl(NETVAERK);
      return;
    }
    if ("fejl" in svar) {
      setVenter(false);
      setFejl(svar.fejl);
      return;
    }
    router.push("/adgang/opsaet");
  }

  return (
    <div className={KORT}>
      <h1 className="text-[26px] leading-tight sm:text-[30px]">Mistet din telefon?</h1>
      <p className="mt-1 text-sm text-tekst-svag">
        Log ind med en af dine gendannelseskoder. Din gamle app holder op med at virke, og du sætter en ny op
        med det samme.
      </p>
      <form onSubmit={send} method="post" className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className={LABEL}>
            E-mail
          </label>
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className={`mt-1.5 ${FELT}`} />
        </div>
        <div>
          <label htmlFor="password" className={LABEL}>
            Adgangskode
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`mt-1.5 ${FELT}`}
          />
        </div>
        <div>
          <label htmlFor="gendan" className={LABEL}>
            Gendannelseskode
          </label>
          <input
            id="gendan"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            placeholder="XXXX-XXXX-XXXX-XXXX"
            maxLength={24}
            value={kode}
            onChange={(e) => setKode(e.target.value)}
            className={`mt-1.5 ${FELT} font-mono tracking-wider`}
          />
        </div>
        {fejl && (
          <p role="alert" className={FORMULAR_FEJL}>
            {fejl}
          </p>
        )}
        <button type="submit" disabled={venter || !hydreret} aria-busy={venter || undefined} className="btn btn-primaer btn-stor w-full">
          {venter && <Spinner />}
          Fortsæt
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-tekst-svag">
        Har du ingen koder? Bed chefen om at nulstille dit to-trins-login.{" "}
        <Link href="/adgang/login" className={LINK}>
          Tilbage til log ind
        </Link>
      </p>
    </div>
  );
}
