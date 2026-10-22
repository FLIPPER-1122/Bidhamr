"use client";

import Link from "next/link";
import CookieindstillingerKnap from "@/components/samtykke/CookieindstillingerKnap";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { MENU_IKONER } from "@/components/admin/menuIkoner";
import { hovedsiteUrl } from "@/lib/adminVaert";
import type { StatusTone } from "@/lib/admin/statuslinje";

// Admin-menuen (docs/ADMIN-REDESIGN.md 2.2 + godkendt showcase): mørk
// skovgrøn sidebjælke, seks grupper, tællere farvet efter alvor, en lille
// statuslampe øverst og den aktive side markeret med orange streg.
// Ingen foldede grupper - så kan intet, der kræver handling, gemmes væk.
//
// Adgangen tjekkes altid igen på selve siden. Menuen skjuler bare de punkter,
// man ikke har rolle til.

type StaffRole = "chef" | "admin" | "medarbejder";
// 'saelger' (erhvervssælger) står uden for hierarkiet og ser KUN Erhverv.
type MenuRolle = StaffRole | "saelger";

// Hierarki: medarbejder < admin < chef. Skal matche src/lib/adminAuth.ts.
const ROLE_LEVEL: Record<StaffRole, number> = { medarbejder: 1, admin: 2, chef: 3 };

const ROLLE_NAVN: Record<MenuRolle, string> = {
  chef: "Chef",
  admin: "Admin",
  medarbejder: "Medarbejder",
  saelger: "Sælger",
};

export type MenuTaellere = {
  handler: number;
  sager: number;
  // Reklamationer hos fragtfirmaet. Kritisk = ikke anmeldt efter 3 dage /
  // sagen ændret / (chefen) udbetalingen hænger -> rødt.
  reklamationer: number;
  reklamationerKritisk: boolean;
  // Årsagerne til det røde tal (til skærmlæsere).
  reklamationerAfventerRoed?: number;
  reklamationerSagAendret?: number;
  reklamationerUdbetalingFejl?: number;
  // Det grå tal (til skærmlæsere): skal anmeldes / (chefen) venter på
  // chefens udbetaling.
  reklamationerAfventer?: number;
  reklamationerVenterUdbetaling?: number;
  // Ekstra fragt (for lille pakke). Kritisk = indsigelser venter på afgørelse -> rødt.
  ekstraFragt: number;
  ekstraFragtKritisk: boolean;
  betalinger: number;
  brugere: number;
  henvendelser: number;
  anmeldelser: number;
  // Mindst én DSA-sag er over fristen -> rødt tal.
  anmeldelserKritisk: boolean;
  erhverv: number;
};

export const INGEN_TAELLERE: MenuTaellere = {
  handler: 0,
  sager: 0,
  reklamationer: 0,
  reklamationerKritisk: false,
  ekstraFragt: 0,
  ekstraFragtKritisk: false,
  betalinger: 0,
  brugere: 0,
  henvendelser: 0,
  anmeldelser: 0,
  anmeldelserKritisk: false,
  erhverv: 0,
};

type TalNoegle = Exclude<
  keyof MenuTaellere,
  | "anmeldelserKritisk"
  | "reklamationerKritisk"
  | "ekstraFragtKritisk"
  | "reklamationerAfventerRoed"
  | "reklamationerSagAendret"
  | "reklamationerUdbetalingFejl"
  | "reklamationerAfventer"
  | "reklamationerVenterUdbetaling"
>;

type MenuPunkt = {
  href: string;
  label: string;
  minRolle: StaffRole;
  // Andre adresser, der hører til samme menupunkt (fanerne på siden).
  ogsaa?: string[];
  tal?: TalNoegle;
  // gul = høj alvor (venter på en afgørelse), graa = til orientering.
  tone?: "gul" | "graa";
  ikon?: string;
};

type MenuGruppe = { id: string; titel: string; punkter: MenuPunkt[] };

// Erhverv: kun chef og saelger (kraevErhvervSide i src/lib/adminAuth.ts).
const ERHVERV: MenuPunkt = {
  href: "/admin/erhverv",
  label: "Erhverv",
  minRolle: "chef",
  tal: "erhverv",
  tone: "gul",
};

const GRUPPER: MenuGruppe[] = [
  {
    id: "overblik",
    titel: "Overblik",
    punkter: [{ href: "/admin", label: "Forside", minRolle: "medarbejder" }],
  },
  {
    id: "handel",
    titel: "Handel og penge",
    punkter: [
      { href: "/admin/handler", label: "Handler", minRolle: "medarbejder", ogsaa: ["/admin/ubetalte"], tal: "handler", tone: "graa" },
      { href: "/admin/sager", label: "Sager", minRolle: "medarbejder", tal: "sager", tone: "gul" },
      { href: "/admin/reklamationer", label: "Reklamationer", minRolle: "medarbejder", tal: "reklamationer", tone: "graa" },
      { href: "/admin/ekstra-fragt", label: "Ekstra fragt", minRolle: "medarbejder", tal: "ekstraFragt", tone: "graa" },
      { href: "/admin/betalinger", label: "Betalingsfejl", minRolle: "medarbejder", tal: "betalinger", tone: "gul" },
      // Pengetal og indtjening: KUN chef (siderne giver 404 for alle andre).
      { href: "/admin/penge", label: "Penge", minRolle: "chef", ogsaa: ["/admin/fakturaer", "/admin/dac7"] },
      // Månedens lodtrækning om et gavekort: KUN chef (siden giver 404 for alle andre).
      { href: "/admin/konkurrence", label: "Konkurrence", minRolle: "chef" },
    ],
  },
  {
    id: "brugere",
    titel: "Brugere og sikkerhed",
    punkter: [
      { href: "/admin/brugere", label: "Brugere", minRolle: "medarbejder", ogsaa: ["/admin/kontolukninger"], tal: "brugere", tone: "graa" },
      { href: "/admin/kontakt", label: "Henvendelser", minRolle: "medarbejder", ogsaa: ["/admin/chats"], tal: "henvendelser", tone: "graa" },
    ],
  },
  {
    id: "indhold",
    titel: "Indhold og moderation",
    punkter: [
      {
        href: "/admin/dsa",
        label: "Anmeldelser",
        minRolle: "medarbejder",
        ogsaa: ["/admin/rapporter", "/admin/opklarede-rapporter", "/admin/bruger-rapporter", "/admin/rapport-arkiv", "/admin/bedommelser"],
        tal: "anmeldelser",
        tone: "graa",
        ikon: "/admin/rapporter",
      },
      { href: "/admin/auktioner", label: "Auktioner", minRolle: "admin" },
    ],
  },
  { id: "erhverv", titel: "Erhverv", punkter: [ERHVERV] },
  {
    id: "drift",
    titel: "Drift og indstillinger",
    punkter: [
      { href: "/admin/drift", label: "Drift", minRolle: "admin", ogsaa: ["/admin/dsa/rapport"] },
      { href: "/admin/medarbejder-log", label: "Handlingslog", minRolle: "medarbejder" },
      { href: "/admin/medarbejdere", label: "Medarbejdere", minRolle: "chef" },
      { href: "/admin/beta", label: "Beta-test", minRolle: "admin", ogsaa: ["/admin/beta-fejl"], ikon: "/admin/beta-fejl" },
      { href: "/admin/venteliste", label: "Venteliste", minRolle: "chef" },
    ],
  },
];

// Sælgeren ser kun Erhverv - men med alle fanerne som menupunkter, så
// forsiden og listerne er ét klik væk.
const SAELGER_GRUPPER: MenuGruppe[] = [
  {
    id: "erhverv",
    titel: "Erhverv",
    punkter: [
      { href: "/admin/erhverv", label: "Oversigt", minRolle: "chef", tal: "erhverv", tone: "gul", ikon: "/admin" },
      { href: "/admin/erhverv/henvendelser", label: "Henvendelser", minRolle: "chef", ikon: "/admin/kontakt" },
      { href: "/admin/erhverv/firmaer", label: "Firmaer", minRolle: "chef", ikon: "/admin/erhverv" },
      { href: "/admin/erhverv/klager", label: "Købers klager over firmaer", minRolle: "chef", ikon: "/admin/sager" },
      { href: "/admin/erhverv/dsa-klager", label: "Firmaers klager (DSA)", minRolle: "chef", ikon: "/admin/dsa" },
      { href: "/admin/erhverv/pakker", label: "Pakker", minRolle: "chef", ikon: "/admin/fakturaer" },
    ],
  },
];

const PRIK: Record<StatusTone, string> = {
  groen: "bg-lampe-groen",
  gul: "bg-lampe-gul",
  roed: "bg-lampe-roed",
};

export type MiniStatus = { tone: StatusTone; titel: string; href: string | null };

// Logo på mørk grøn flade. Der findes endnu ingen hvid logovariant (DESIGN.md
// 10, TODO designeren) - mærket står derfor på en lys ring, og navnet er tekst.
function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <svg viewBox="0 0 64 64" className="h-[30px] w-[30px] shrink-0 rounded-lg ring-1 ring-white/25" aria-hidden="true">
        <rect width="64" height="64" rx="16" fill="#1E5E4A" />
        <g transform="translate(29 34) rotate(-35)">
          <rect x="-16" y="-16" width="32" height="13" rx="4" fill="#E8772E" />
          <rect x="-3.5" y="-3" width="7" height="24" rx="3.5" fill="#fff" />
        </g>
        <circle cx="49" cy="15" r="7.5" fill="#E8772E" />
      </svg>
      <span className="text-[17px] font-bold tracking-tight text-white">
        BidHamr <span className="font-semibold text-white/75">admin</span>
      </span>
    </span>
  );
}

function Tal({ antal, tone, sr }: { antal: number; tone: "roed" | "gul" | "graa"; sr?: string }) {
  if (!antal) return null;
  const cls = tone === "roed" ? "bg-tal-roed text-white" : tone === "gul" ? "bg-tal-gul text-tekst" : "bg-white/20 text-white";
  return (
    <span className={`relative min-w-[22px] rounded-full px-[7px] py-px text-center text-[11.5px] font-bold tabular-nums ${cls}`}>
      {antal}
      <span className="sr-only">{sr ?? (tone === "roed" ? " – over fristen" : " venter")}</span>
    </span>
  );
}

// Skærmlæsertekst til reklamationernes tal: årsagen til det røde tal
// ("ikke anmeldt" / "sag ændret" / "udbetaling"), ellers hvad de venter på
// (at blive anmeldt / chefens udbetaling - tallet vises for chefen).
function reklamationSr(t: MenuTaellere, tone: string): string {
  if (tone !== "roed") {
    const dele = [
      t.reklamationerAfventer ? `${t.reklamationerAfventer} skal anmeldes` : null,
      t.reklamationerVenterUdbetaling ? `${t.reklamationerVenterUdbetaling} venter på din udbetaling` : null,
    ].filter(Boolean);
    return dele.length ? ` – ${dele.join(", ")}` : " venter";
  }
  const dele = [
    t.reklamationerAfventerRoed ? `${t.reklamationerAfventerRoed} ikke anmeldt` : null,
    t.reklamationerSagAendret ? `${t.reklamationerSagAendret} sag ændret` : null,
    t.reklamationerUdbetalingFejl ? `${t.reklamationerUdbetalingFejl} udbetaling kræver handling` : null,
  ].filter(Boolean);
  return dele.length ? ` – ${dele.join(", ")}` : " – kræver handling";
}

export default function AdminSidebar({
  rolle,
  taellere = INGEN_TAELLERE,
  status,
  paaAdminVaert = false,
}: {
  rolle: MenuRolle;
  taellere?: MenuTaellere;
  status?: MiniStatus | null;
  // Admin på egen host (ADMIN_VAERT, sat af layoutet på serveren): log ud
  // sender til /adgang/login, og "Tilbage til siden" går til hovedsitet.
  paaAdminVaert?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  // Mobilskuffens indhold bygges først, når den åbnes første gang (mindre
  // DOM og hydrering ved hver sidevisning).
  const [bygget, setBygget] = useState(false);
  const [loggerUd, setLoggerUd] = useState(false);
  const menuKnapRef = useRef<HTMLButtonElement>(null);
  const mobilMenuRef = useRef<HTMLDivElement>(null);
  const mobilMenuId = `${id}-mobilmenu`;

  // Åben mobilmenu: fokus ind i menuen, og Esc lukker den og sender fokus
  // tilbage til menuknappen.
  useEffect(() => {
    if (!open) return;
    // Menuen er usynlig (visibility) indtil overgangen starter, og et usynligt
    // element kan ikke få fokus - vent derfor til næste frame.
    const fokusId = window.setTimeout(() => {
      mobilMenuRef.current?.querySelector<HTMLElement>("a[href], button:not([disabled])")?.focus();
    }, 50);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      menuKnapRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(fokusId);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleLogout() {
    setLoggerUd(true);
    // Supabase-klienten hentes først ved klik, så den ikke ligger i menuens
    // første JavaScript.
    // scope "local": kun denne session logges ud. Den globale udgave loggede
    // også medarbejderen ud af appen og hovedsitet.
    const { createClient } = await import("@/lib/supabase/client");
    await createClient().auth.signOut({ scope: "local" });
    router.push(paaAdminVaert ? "/adgang/login" : "/login");
    router.refresh();
  }

  const synligeGrupper: MenuGruppe[] =
    rolle === "saelger"
      ? SAELGER_GRUPPER
      : GRUPPER.map((g) => ({
          ...g,
          punkter: g.punkter.filter((p) => ROLE_LEVEL[rolle] >= ROLE_LEVEL[p.minRolle]),
        })).filter((g) => g.punkter.length > 0);

  // Det mest specifikke menupunkt vinder, så fx /admin/brugere/123 markerer
  // "Brugere", og /admin/dsa/rapport markerer "Drift" (ikke "Anmeldelser").
  const matcher = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(`${href}/`);
  const aktivHref = synligeGrupper
    .flatMap((g) => g.punkter)
    .flatMap((p) => [p.href, ...(p.ogsaa ?? [])].filter(matcher).map((sti) => ({ sti, href: p.href })))
    .sort((a, b) => b.sti.length - a.sti.length)[0]?.href;

  function punkt(p: MenuPunkt) {
    const aktiv = p.href === aktivHref;
    const antal = p.tal ? taellere[p.tal] : 0;
    const tone =
      (p.tal === "anmeldelser" && taellere.anmeldelserKritisk) || (p.tal === "reklamationer" && taellere.reklamationerKritisk) ||
      (p.tal === "ekstraFragt" && taellere.ekstraFragtKritisk)
        ? "roed"
        : (p.tone ?? "graa");
    return (
      <Link
        href={p.href}
        onClick={() => setOpen(false)}
        aria-current={aktiv ? "page" : undefined}
        className={`flex min-h-[40px] items-center gap-3 rounded-lg border-l-[3px] px-2.5 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-orange ${
          aktiv
            ? "border-orange bg-white/12 font-semibold text-white"
            : "border-transparent font-medium text-white/90 hover:bg-white/8 hover:text-white"
        }`}
      >
        <span className={aktiv ? "text-white" : "text-white/70"}>{MENU_IKONER[p.ikon ?? p.href]}</span>
        <span className="min-w-0 flex-1 truncate">{p.label}</span>
        <Tal antal={antal} tone={tone} sr={p.tal === "reklamationer" ? reklamationSr(taellere, tone) : undefined} />
      </Link>
    );
  }

  const indhold = (sted: "mobil" | "pc") => (
    <div className="flex h-full flex-col gap-3.5 px-3.5 py-[18px]">
      <div className="space-y-2 px-1">
        <Link href={rolle === "saelger" ? "/admin/erhverv" : "/admin"} onClick={() => setOpen(false)} className="inline-flex rounded-lg focus-visible:outline-2 focus-visible:outline-orange">
          <Logo />
        </Link>
        <span className="ml-10 block w-max rounded-full bg-white/14 px-[9px] py-0.5 text-[11.5px] font-semibold text-white">
          {ROLLE_NAVN[rolle]}
        </span>
      </div>

      {status && (
        <Link
          href={status.href ?? "/admin"}
          onClick={() => setOpen(false)}
          className="flex items-center gap-2 rounded-lg bg-white/8 px-2.5 py-2 text-[12.5px] text-white hover:bg-white/12 focus-visible:outline-2 focus-visible:outline-orange"
        >
          <span aria-hidden="true" className={`h-[11px] w-[11px] shrink-0 rounded-full ${PRIK[status.tone]}`} />
          <span className="min-w-0">{status.titel}</span>
        </Link>
      )}

      <nav aria-label="Admin" className="-mx-1 flex-1 overflow-y-auto px-1">
        {synligeGrupper.map((g) => (
          <div key={g.id} className="mt-3.5 first:mt-0">
            {/* Sælgeren har kun én gruppe - ingen gruppeoverskrift. */}
            {rolle !== "saelger" && (
              <h2
                id={`${id}-${sted}-${g.id}`}
                className="mx-2 mb-1 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-white/60"
              >
                {g.titel}
              </h2>
            )}
            <ul aria-labelledby={rolle !== "saelger" ? `${id}-${sted}-${g.id}` : undefined} className="space-y-0.5">
              {g.punkter.map((p) => (
                <li key={p.href}>{punkt(p)}</li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="space-y-1 border-t border-white/10 pt-3 text-[13px]">
        <button
          type="button"
          onClick={handleLogout}
          disabled={loggerUd}
          className="flex min-h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left font-medium text-white/80 transition-colors hover:bg-white/8 hover:text-white disabled:opacity-50"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-7.5A2.25 2.25 0 003.75 5.25v13.5A2.25 2.25 0 006 21h7.5a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
          </svg>
          {loggerUd ? "Logger ud…" : "Log ud"}
        </button>
        <a href={hovedsiteUrl("/")} className="flex min-h-9 items-center px-2.5 text-xs text-white/65 transition-colors hover:text-white">
          ← Tilbage til siden
        </a>
        {/* Admin-hosten har ingen valgfrie cookies og intet cookie-banner. */}
        {!paaAdminVaert && (
          <CookieindstillingerKnap
            vedKlik={() => setOpen(false)}
            className="flex min-h-9 items-center px-2.5 text-left text-xs text-white/65 transition-colors hover:text-white"
          />
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Mobil: fast topbjælke med logo, statuslampe og menuknap. */}
      <div className="fixed left-0 right-0 top-0 z-40 flex h-14 items-center justify-between gap-3 bg-groen-mork px-4 lg:hidden">
        <Link href={rolle === "saelger" ? "/admin/erhverv" : "/admin"} className="rounded-lg focus-visible:outline-2 focus-visible:outline-orange">
          <Logo />
        </Link>
        <div className="flex items-center gap-2">
          {status && (
            <Link
              href={status.href ?? "/admin"}
              className="relative grid h-11 w-11 place-items-center rounded-lg hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-orange"
            >
              <span aria-hidden="true" className={`h-3 w-3 rounded-full ring-2 ring-white/30 ${PRIK[status.tone]}`} />
              <span className="sr-only">Status: {status.titel}</span>
            </Link>
          )}
          <button
            ref={menuKnapRef}
            type="button"
            onClick={() => {
              setBygget(true);
              setOpen(!open);
            }}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-white/25 px-3 text-sm font-semibold text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-orange"
            aria-expanded={open}
            aria-controls={mobilMenuId}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
              {open ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
              )}
            </svg>
            {open ? "Luk" : "Menu"}
          </button>
        </div>
      </div>

      {open && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setOpen(false)} />}

      {/* Mobil skuffe. Lukket: inert + usynlig, så den hverken er i
          tab-rækkefølgen eller læses op af skærmlæsere. Indholdet bygges
          først, når den åbnes første gang. */}
      <div
        id={mobilMenuId}
        ref={mobilMenuRef}
        inert={!open}
        className={`fixed bottom-0 left-0 top-0 z-40 w-[270px] max-w-[85vw] bg-groen-mork transition-[transform,visibility] duration-200 motion-reduce:transition-none lg:hidden ${
          open ? "visible translate-x-0" : "invisible -translate-x-full"
        }`}
      >
        {bygget && indhold("mobil")}
      </div>

      {/* Computer */}
      <aside
        aria-label="Admin-menu"
        className="sticky top-0 hidden h-[calc(100vh-var(--samtykke-hoejde,0px))] w-[248px] shrink-0 flex-col bg-groen-mork lg:flex"
      >
        {indhold("pc")}
      </aside>
    </>
  );
}
