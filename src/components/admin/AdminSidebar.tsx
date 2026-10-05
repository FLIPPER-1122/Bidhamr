"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";

type StaffRole = "chef" | "admin" | "medarbejder";

// Hierarki: medarbejder < admin < chef. Skal matche src/lib/adminAuth.ts.
const ROLE_LEVEL: Record<StaffRole, number> = {
  medarbejder: 1,
  admin: 2,
  chef: 3,
};

type AdminTaellere = {
  ubetalte: number;
  betalinger: number;
  chats: number;
  sager: number;
  kontolukninger: number;
  kontakt: number;
  rapporter: number;
};

type MenuPunkt = {
  href: string;
  label: string;
  minRolle: StaffRole;
  // Andre adresser, der hører til samme menupunkt (fx fanerne under Rapporter).
  ogsaa?: string[];
  // Tal i menuen, fx antal ubetalte vindere. Vises kun, når det er over 0.
  badge?: keyof AdminTaellere;
};

type MenuGruppe = {
  id: string;
  titel: string;
  punkter: MenuPunkt[];
  // Sammenfoldet som standard. Valget huskes i browseren.
  kanFoldes?: boolean;
};

// Adgangen tjekkes altid igen på selve siden. Menuen skjuler bare de punkter,
// man ikke har rolle til.
const GRUPPER: MenuGruppe[] = [
  {
    id: "dagligt",
    titel: "Dagligt arbejde",
    punkter: [
      { href: "/admin", label: "Forside", minRolle: "medarbejder" },
      { href: "/admin/sager", label: "Sager", minRolle: "medarbejder", badge: "sager" },
      {
        href: "/admin/rapporter",
        label: "Rapporter",
        minRolle: "medarbejder",
        ogsaa: ["/admin/opklarede-rapporter", "/admin/rapport-arkiv", "/admin/bruger-rapporter"],
        badge: "rapporter",
      },
      { href: "/admin/kontakt", label: "Kontaktformular", minRolle: "medarbejder", badge: "kontakt" },
      { href: "/admin/chats", label: "Chats", minRolle: "medarbejder", badge: "chats" },
    ],
  },
  {
    id: "handler",
    titel: "Handler og brugere",
    punkter: [
      { href: "/admin/handler", label: "Handler", minRolle: "medarbejder" },
      { href: "/admin/betalinger", label: "Betalinger", minRolle: "medarbejder", badge: "betalinger" },
      { href: "/admin/ubetalte", label: "Ubetalte vindere", minRolle: "medarbejder", badge: "ubetalte" },
      { href: "/admin/kontolukninger", label: "Kontolukninger", minRolle: "admin", badge: "kontolukninger" },
      { href: "/admin/brugere", label: "Brugere", minRolle: "medarbejder" },
      { href: "/admin/auktioner", label: "Auktioner", minRolle: "admin" },
      { href: "/admin/bedommelser", label: "Bedømmelser", minRolle: "admin" },
    ],
  },
  {
    id: "overblik",
    titel: "Overblik",
    punkter: [
      // Pengetal og indtjening: KUN chef (siden giver 404 for alle andre).
      { href: "/admin/penge", label: "Penge", minRolle: "chef" },
      { href: "/admin/medarbejder-log", label: "Medarbejder-log", minRolle: "medarbejder" },
      { href: "/admin/drift", label: "Drift", minRolle: "admin" },
    ],
  },
  {
    id: "indstillinger",
    titel: "Indstillinger",
    kanFoldes: true,
    punkter: [
      { href: "/admin/medarbejdere", label: "Medarbejdere", minRolle: "chef" },
      { href: "/admin/venteliste", label: "Venteliste", minRolle: "chef" },
    ],
  },
];

const IKONER: Record<string, React.ReactNode> = {
  "/admin": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zm0 9.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zm9.75-9.75A2.25 2.25 0 0115.75 3.75H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zm0 9.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
    </svg>
  ),
  "/admin/sager": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
    </svg>
  ),
  "/admin/rapporter": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  ),
  "/admin/kontakt": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
    </svg>
  ),
  "/admin/chats": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
    </svg>
  ),
  "/admin/handler": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </svg>
  ),
  "/admin/betalinger": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
    </svg>
  ),
  "/admin/ubetalte": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
    </svg>
  ),
  "/admin/kontolukninger": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
    </svg>
  ),
  "/admin/brugere": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
    </svg>
  ),
  "/admin/auktioner": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  "/admin/bedommelser": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
    </svg>
  ),
  "/admin/penge": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
    </svg>
  ),
  "/admin/medarbejder-log": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  "/admin/drift": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l3-3 3 3 4.5-6 3 4.5 3-1.5M3.75 19.5h16.5" />
    </svg>
  ),
  "/admin/medarbejdere": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
    </svg>
  ),
  "/admin/venteliste": (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
    </svg>
  ),
};

// "Indstillinger" åben/lukket huskes i localStorage. Kan browseren ikke gemme
// (privat vindue, blokeret lager), er gruppen bare lukket som standard.
const FOLD_NOEGLE = "bidhamr-admin-indstillinger-aaben";
const foldLyttere = new Set<() => void>();

function laesFold(): boolean {
  try {
    return window.localStorage.getItem(FOLD_NOEGLE) === "1";
  } catch {
    return false;
  }
}

function gemFold(aaben: boolean) {
  try {
    window.localStorage.setItem(FOLD_NOEGLE, aaben ? "1" : "0");
  } catch {
    // Ignorér – valget huskes så bare ikke.
  }
  foldLyttere.forEach((l) => l());
}

function lytFold(l: () => void) {
  foldLyttere.add(l);
  window.addEventListener("storage", l);
  return () => {
    foldLyttere.delete(l);
    window.removeEventListener("storage", l);
  };
}

export default function AdminSidebar({
  rolle,
  taellere = { ubetalte: 0, betalinger: 0, chats: 0, sager: 0, kontolukninger: 0, kontakt: 0, rapporter: 0 },
}: {
  rolle: StaffRole;
  taellere?: AdminTaellere;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const foldId = useId();
  const [open, setOpen] = useState(false);
  const [loggerUd, setLoggerUd] = useState(false);
  const indstillingerAaben = useSyncExternalStore(lytFold, laesFold, () => false);
  const menuKnapRef = useRef<HTMLButtonElement>(null);
  const mobilMenuRef = useRef<HTMLDivElement>(null);
  const mobilMenuId = `${foldId}-mobilmenu`;

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
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const synligeGrupper = GRUPPER.map((g) => ({
    ...g,
    punkter: g.punkter.filter((p) => ROLE_LEVEL[rolle] >= ROLE_LEVEL[p.minRolle]),
  })).filter((g) => g.punkter.length > 0);

  // Det mest specifikke menupunkt vinder, så fx /admin/brugere/123 markerer
  // "Brugere", og /admin/rapport-arkiv markerer "Rapporter".
  const matcher = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(`${href}/`);
  const aktivHref = synligeGrupper
    .flatMap((g) => g.punkter)
    .flatMap((p) => [p.href, ...(p.ogsaa ?? [])].filter(matcher).map((sti) => ({ sti, href: p.href })))
    .sort((a, b) => b.sti.length - a.sti.length)[0]?.href;

  function punkt(p: MenuPunkt) {
    const aktiv = p.href === aktivHref;
    const antal = p.badge ? taellere[p.badge] : 0;
    return (
      <Link
        href={p.href}
        onClick={() => setOpen(false)}
        aria-current={aktiv ? "page" : undefined}
        className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
          aktiv
            ? "border-l-2 border-orange bg-[#1f2937] pl-[10px] text-white"
            : "text-neutral-300 hover:bg-white/5 hover:text-white"
        }`}
      >
        {IKONER[p.href]}
        <span className="flex-1">{p.label}</span>
        {antal > 0 && (
          <span
            className="rounded-full bg-[#A32020] px-2 py-0.5 text-xs font-bold tabular-nums text-white"
            aria-label={`${antal} venter`}
          >
            {antal}
          </span>
        )}
      </Link>
    );
  }

  // Menuen vises to steder (mobil og computer), så id'er får et suffiks.
  const sidebarContent = (sted: "mobil" | "pc") => (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="border-b border-white/10 px-6 py-5">
        <span className="text-2xl font-extrabold tracking-tight" style={{ color: "var(--color-orange)" }}>
          BidHamr
        </span>
        <span className="ml-2 text-xs font-medium uppercase tracking-widest text-neutral-400">
          {rolle === "chef" ? "Chef" : rolle === "admin" ? "Admin" : "Medarbejder"}
        </span>
      </div>

      {/* Nav */}
      <nav aria-label="Admin" className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {synligeGrupper.map((g) => {
          // En sammenfoldet gruppe åbnes altid, når man står på en af dens sider.
          const indeholderAktiv = g.punkter.some((p) => p.href === aktivHref);
          const vis = !g.kanFoldes || indstillingerAaben || indeholderAktiv;
          const listeId = `${foldId}-${sted}-${g.id}`;
          return (
            <div key={g.id}>
              {g.kanFoldes ? (
                <button
                  type="button"
                  onClick={() => gemFold(!indstillingerAaben)}
                  aria-expanded={vis}
                  aria-controls={listeId}
                  className="flex w-full items-center justify-between rounded-md px-3 py-1 text-xs font-semibold uppercase tracking-wider text-neutral-400 hover:text-white"
                >
                  {g.titel}
                  <svg
                    className={`h-4 w-4 transition-transform ${vis ? "rotate-180" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>
              ) : (
                <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-neutral-400">
                  {g.titel}
                </p>
              )}
              <ul id={listeId} hidden={!vis} className="mt-1 space-y-0.5">
                {g.punkter.map((p) => (
                  <li key={p.href}>
                    {punkt(p)}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="space-y-1 border-t border-white/10 px-3 py-4">
        <button
          type="button"
          onClick={handleLogout}
          disabled={loggerUd}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-neutral-400 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-7.5A2.25 2.25 0 003.75 5.25v13.5A2.25 2.25 0 006 21h7.5a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
          </svg>
          {loggerUd ? "Logger ud…" : "Log ud"}
        </button>
        <Link
          href="/"
          className="block px-3 text-xs text-neutral-500 transition-colors hover:text-neutral-300"
        >
          ← Tilbage til siden
        </Link>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="fixed left-0 right-0 top-0 z-40 flex items-center justify-between border-b border-white/10 bg-[#111827] px-4 py-3 lg:hidden">
        <span className="text-xl font-extrabold" style={{ color: "var(--color-orange)" }}>BidHamr</span>
        <button
          ref={menuKnapRef}
          type="button"
          onClick={() => setOpen(!open)}
          className="p-1 text-neutral-400 hover:text-white"
          aria-label={open ? "Luk menu" : "Åbn menu"}
          aria-expanded={open}
          aria-controls={mobilMenuId}
        >
          {open ? (
            <svg className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          )}
        </button>
      </div>

      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Mobile sidebar */}
      {/* Lukket: inert + usynlig, så den hverken er i tab-rækkefølgen eller
          læses op af skærmlæsere. */}
      <div
        id={mobilMenuId}
        ref={mobilMenuRef}
        inert={!open}
        className={`fixed bottom-0 left-0 top-0 z-40 w-64 transform bg-[#111827] transition-[transform,visibility] duration-300 lg:hidden ${
          open ? "visible translate-x-0" : "invisible -translate-x-full"
        }`}
      >
        {sidebarContent("mobil")}
      </div>

      {/* Desktop sidebar */}
      <div className="sticky top-0 hidden h-screen w-64 flex-col bg-[#111827] lg:flex">
        {sidebarContent("pc")}
      </div>
    </>
  );
}
