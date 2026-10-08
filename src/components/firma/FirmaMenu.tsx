"use client";

// Menuen i firma-dashboardet (/firma/*), sat op som admin-menuen
// (src/components/admin/AdminSidebar.tsx), men til ældre brugere: stor tekst,
// store knapper (mindst 56px), kun tekst (ingen ikoner uden tekst) og det
// aktive punkt tydeligt markeret (grøn baggrund + aria-current).
// Computer (lg+): altid synlig i siden. Mobil: én stor "Menu"-knap øverst,
// der folder alle punkter ud som en liste med store knapper.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useState } from "react";
import { FIRMA_DASHBOARD } from "@/lib/tekster/erhverv";
import { ERHVERV_EMAIL } from "@/lib/erhverv/regler";

const M = FIRMA_DASHBOARD.menu;

const PUNKTER: { href: string; label: string }[] = [
  { href: "/firma", label: M.overblik },
  { href: "/firma/auktioner", label: M.auktioner },
  { href: "/firma/salg", label: M.salg },
  { href: "/firma/statistik", label: M.statistik },
  { href: "/firma/udbetalinger", label: M.udbetalinger },
  { href: "/firma/abonnement", label: M.abonnement },
  { href: "/firma/regninger", label: M.regninger },
  { href: "/firma/oplysninger", label: M.oplysninger },
];
const HJAELP = { href: "/firma/hjaelp", label: M.hjaelp };

function erAktiv(pathname: string, href: string) {
  if (href === "/firma") return pathname === "/firma";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function FirmaMenu() {
  const pathname = usePathname();
  // Menuen er åben for den side, den blev åbnet på - skiftes side, foldes
  // den sammen igen på mobil (uden en effect).
  const [aabenPaa, setAabenPaa] = useState<string | null>(null);
  const aaben = aabenPaa === pathname;
  const setAaben = (v: boolean | ((a: boolean) => boolean)) =>
    setAabenPaa((typeof v === "function" ? v(aaben) : v) ? pathname : null);
  const listeId = useId();
  const aktiv = [...PUNKTER, HJAELP].find((p) => erAktiv(pathname, p.href));

  const punkt = (p: { href: string; label: string }) => {
    const er = erAktiv(pathname, p.href);
    return (
      <Link
        href={p.href}
        aria-current={er ? "page" : undefined}
        onClick={() => setAaben(false)}
        className={`flex min-h-14 items-center rounded-xl px-4 py-3 text-[18px] leading-snug font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
          er ? "bg-groen text-white" : "text-tekst hover:bg-groen-lys"
        }`}
      >
        {p.label}
      </Link>
    );
  };

  return (
    <nav aria-label={M.navLabel} className="w-full lg:w-72 lg:shrink-0">
      {/* Mobil: én stor knap. Viser også, hvor man er. */}
      <button
        type="button"
        onClick={() => setAaben((a) => !a)}
        aria-expanded={aaben}
        aria-controls={listeId}
        className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border-2 border-groen bg-white px-4 py-3 text-left text-[19px] font-semibold text-groen-mork focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen lg:hidden"
      >
        <span>
          {aaben ? M.luk : M.aabn}
          {aktiv && !aaben && <span className="font-normal text-tekst-daempet"> · {aktiv.label}</span>}
        </span>
        <span aria-hidden="true" className="text-[22px] leading-none">
          {aaben ? "▲" : "▼"}
        </span>
      </button>

      <div
        id={listeId}
        className={`${aaben ? "block" : "hidden"} mt-3 rounded-[18px] border border-kant bg-white p-3 lg:sticky lg:top-6 lg:mt-0 lg:block`}
      >
        <ul className="space-y-1.5">
          {PUNKTER.map((p) => (
            <li key={p.href}>{punkt(p)}</li>
          ))}
        </ul>
        <div className="mt-4 border-t border-kant pt-4">
          {punkt(HJAELP)}
          <a
            href={`mailto:${ERHVERV_EMAIL}`}
            className="mt-1 flex min-h-12 items-center px-4 text-[17px] font-semibold break-all text-groen underline underline-offset-2"
          >
            {ERHVERV_EMAIL}
          </a>
        </div>
      </div>
    </nav>
  );
}
