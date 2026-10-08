import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { kraevFirma } from "@/lib/erhverv/firmaData";
import { foerLancering } from "@/lib/lancering";
import FirmaMenu from "@/components/firma/FirmaMenu";
import FirmaLogUd from "@/components/firma/FirmaLogUd";
import { FIRMA_DASHBOARD as D, FIRMA_OVERSIGT } from "@/lib/tekster/erhverv";

// Firma-dashboardet (Filip, 8. okt. 2026): eget layout i route-gruppen
// (firma) - den almindelige Header/Footer (src/app/(app)/layout.tsx) vises
// IKKE. Egen enkel top (logo, firmanavn, "Se din butik", "Log ud") og en menu
// i siden som admin (src/app/admin/layout.tsx). Kun firmakonti: alle andre
// sendes væk (kraevFirma). Hver side kalder også selv kraevFirma, da layout
// og side bygges samtidig (svaret deles via cache()).
// Før lancering (src/lib/lancering.ts) kan firmaet KUN nå /firma* (gaten i
// src/lib/supabase/middleware.ts); "Se din butik" er så slået fra med en
// forklaring, da firmaprofilen er lukket.

export const metadata: Metadata = {
  title: { default: FIRMA_OVERSIGT.titel, template: `%s · ${FIRMA_OVERSIGT.titel}` },
  robots: { index: false, follow: false },
};

export default async function FirmaLayout({ children }: { children: React.ReactNode }) {
  const { bruger, oversigt } = await kraevFirma();
  const lukket = foerLancering();

  return (
    <div className="flex min-h-svh flex-col bg-[#F6F9F8]">
      <a
        href="#indhold"
        className="sr-only z-[60] rounded-lg bg-white px-4 py-3 text-[17px] font-semibold text-groen shadow-flyder focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:outline-2 focus:outline-groen"
      >
        Spring til indhold
      </a>

      <header className="border-b border-kant bg-white">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6 lg:px-8">
          <Link
            href="/firma"
            aria-label={D.top.logoLabel}
            className="order-1 flex min-h-12 shrink-0 items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
          >
            <Image src="/brand/bidhamr-logo.svg" alt="BidHamr" width={230} height={60} preload unoptimized className="h-9 w-auto" />
          </Link>
          {/* Mobil: logo og "Log ud" øverst, firmanavn og "Se din butik"
              på linjen under. Computer: alt på én linje. */}
          <div className="order-3 flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 sm:order-2 sm:w-auto sm:flex-1">
            <p className="text-[19px] leading-snug font-semibold break-words text-groen-mork">{oversigt.firma.firmanavn}</p>
            {lukket ? (
              <span className="text-[16px] leading-snug text-tekst-daempet sm:max-w-[280px] sm:text-right">{D.top.seButikLukket}</span>
            ) : (
              <Link
                href={`/erhvervssaelger/${bruger.id}`}
                className="inline-flex min-h-12 items-center rounded-md px-1 text-[17px] font-semibold text-groen underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
              >
                {D.top.seButik}
              </Link>
            )}
          </div>
          <div className="order-2 ml-auto sm:order-3 sm:ml-0">
            <FirmaLogUd />
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row lg:gap-8 lg:px-8 lg:py-10">
        <FirmaMenu />
        <main id="indhold" tabIndex={-1} className="min-w-0 flex-1 outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
