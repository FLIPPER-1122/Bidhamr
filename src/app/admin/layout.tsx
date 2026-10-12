import { Suspense } from "react";
import { redirect } from "next/navigation";
import BetaFejlKnap from "@/components/betafejl/BetaFejlKnap";
import { hentBruger, hentMinRolle } from "@/lib/supabase/bruger";
import AdminSidebar, { INGEN_TAELLERE, type MiniStatus } from "@/components/admin/AdminSidebar";
import AdminTopSoeg from "@/components/admin/AdminTopSoeg";
import Kvittering from "@/components/admin/Kvittering";
import { hentErhvervNye, hentNoedstopTal } from "@/lib/admin/taellere";
import { hentAdminStatus } from "@/lib/admin/status";
import type { StaffRole } from "@/lib/adminAuth";

// Fælles ramme for hele admin: menu, søgning øverst, nødstop-bjælken og
// kvitteringen efter en handling (<Kvittering />, så den virker på alle
// sider).
//
// Hastighed: menuens tal og nødstop-bjælken streames hver for sig
// (Suspense), så siden ikke venter på dem. Menuen vises med det samme uden
// tal og fyldes ud, når tallene er hentet.

// Menuen med tal og statuslampe. Samme beregning som forsiden (hentAdminStatus).
async function StaffMenu({ rolle }: { rolle: StaffRole }) {
  const [{ status, tal: t }, antalErhverv] = await Promise.all([
    hentAdminStatus(rolle),
    rolle === "chef" ? hentErhvervNye() : Promise.resolve(0),
  ]);
  return (
    <AdminSidebar
      rolle={rolle}
      status={{ tone: status.tone, titel: status.titel, href: status.tone === "groen" ? "/admin" : status.href }}
      taellere={{
        handler: t.ubetalte,
        sager: t.sager,
        betalinger: t.betalinger,
        brugere: t.kontolukninger,
        henvendelser: t.kontakt + t.chats,
        anmeldelser: t.dsa + t.rapporter + t.bedoemmelser,
        anmeldelserKritisk: t.dsaOverskredet > 0,
        erhverv: antalErhverv,
      }}
    />
  );
}

async function SaelgerMenu() {
  const antalErhverv = await hentErhvervNye();
  const status: MiniStatus =
    antalErhverv > 0
      ? {
          tone: "gul",
          titel: `${antalErhverv} ${antalErhverv === 1 ? "ny henvendelse venter" : "nye henvendelser venter"}`,
          href: "/admin/erhverv",
        }
      : { tone: "groen", titel: "Ingen nye henvendelser", href: "/admin/erhverv" };
  return <AdminSidebar rolle="saelger" taellere={{ ...INGEN_TAELLERE, erhverv: antalErhverv }} status={status} />;
}

// Mens menuens tal hentes: en let, statisk flade i samme størrelse (ingen
// klientkomponent, der skal hydreres to gange).
function MenuPladsholder() {
  return (
    <>
      <div aria-hidden="true" className="fixed left-0 right-0 top-0 z-40 h-14 bg-groen-mork lg:hidden" />
      <div aria-hidden="true" className="sticky top-0 hidden h-[calc(100vh-var(--samtykke-hoejde,0px))] w-[248px] shrink-0 bg-groen-mork lg:block" />
    </>
  );
}

// Nødstop (sikkerhedsnet A): tydelig rød bjælke øverst for al staff.
// Årsagen vises kun for chefen (hentNoedstopBjaelke).
async function NoedstopBjaelke() {
  const n = await hentNoedstopTal();
  if (!n.stoppet) return null;
  return (
    <div role="alert" className="bg-fejl-tekst px-4 py-3 text-sm font-semibold text-white sm:px-6">
      NØDSTOP: {n.stoppet} er stoppet.
      {n.aarsag ? ` Årsag: ${n.aarsag}` : ""} Chefen genoptager under Admin → Penge.
    </div>
  );
}

function Ramme({
  menu,
  erhverv,
  bjaelke,
  children,
}: {
  menu: React.ReactNode;
  erhverv: boolean;
  bjaelke?: React.ReactNode;
  children: React.ReactNode;
}) {
  // Højden trækker cookie-bannerets højde fra (--samtykke-hoejde), så
  // banneret aldrig dækker knapper nederst i admin - heller ikke på mobil.
  return (
    <div className="flex h-[calc(100vh-var(--samtykke-hoejde,0px))] bg-admin-bg">
      {menu}
      <main id="admin-indhold" className="min-w-0 flex-1 overflow-auto bg-admin-bg pt-14 lg:pt-0">
        {bjaelke}
        <div className="border-b border-admin-kant bg-white/70 px-4 py-2.5 sm:px-6">
          <AdminTopSoeg erhverv={erhverv} />
        </div>
        {children}
      </main>
      <Kvittering />
      {/* "Meld fejl" til staff før lancering (ellers intet). */}
      <Suspense fallback={null}>
        <BetaFejlKnap />
      </Suspense>
    </div>
  );
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Bruger og rolle hentes samtidig (højst én gang pr. forespørgsel, delt via
  // cache() i src/lib/supabase/bruger.ts).
  const [user, rolle] = await Promise.all([hentBruger(), hentMinRolle()]);

  // Rollen 'saelger' (erhvervssælger) kommer ind, men ser KUN Erhverv.
  // Alle andre admin-sider og -actions afviser rollen selv (assertRole/
  // kraevSideRolle kender den ikke), og proxyen sender saelger videre til
  // /admin/erhverv fra alle andre admin-stier (src/lib/supabase/middleware.ts).
  if (user && rolle === "saelger") {
    return (
      <Ramme
        erhverv
        menu={
          <Suspense fallback={<MenuPladsholder />}>
            <SaelgerMenu />
          </Suspense>
        }
      >
        {children}
      </Ramme>
    );
  }

  if (!user || (rolle !== "chef" && rolle !== "admin" && rolle !== "medarbejder")) {
    redirect("/");
  }

  return (
    <Ramme
      erhverv={false}
      bjaelke={
        <Suspense fallback={null}>
          <NoedstopBjaelke />
        </Suspense>
      }
      menu={
        <Suspense fallback={<MenuPladsholder />}>
          <StaffMenu rolle={rolle} />
        </Suspense>
      }
    >
      {children}
    </Ramme>
  );
}
