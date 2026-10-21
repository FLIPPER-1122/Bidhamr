import { Suspense } from "react";
import BetaFejlKnap from "@/components/betafejl/BetaFejlKnap";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminVaertAktiv, erAdminVaert } from "@/lib/adminVaert";
import AdminSidebar, { INGEN_TAELLERE, type MiniStatus } from "@/components/admin/AdminSidebar";
import AdminTopSoeg from "@/components/admin/AdminTopSoeg";
import Kvittering from "@/components/admin/Kvittering";
import { hentErhvervNye, hentNoedstopTal } from "@/lib/admin/taellere";
import { hentAdminStatus } from "@/lib/admin/status";
import { hentStaffAdgang, kraevSideRolle, type StaffRole } from "@/lib/adminAuth";

// Fælles ramme for hele admin: menu, søgning øverst, nødstop-bjælken og
// kvitteringen efter en handling (<Kvittering />, så den virker på alle
// sider).
//
// Hastighed: menuens tal og nødstop-bjælken streames hver for sig
// (Suspense), så siden ikke venter på dem. Menuen vises med det samme uden
// tal og fyldes ud, når tallene er hentet.

// Menuen med tal og statuslampe. Samme beregning som forsiden (hentAdminStatus).
async function StaffMenu({ rolle, paaAdminVaert }: { rolle: StaffRole; paaAdminVaert: boolean }) {
  const [{ status, tal: t }, antalErhverv] = await Promise.all([
    hentAdminStatus(rolle),
    rolle === "chef" ? hentErhvervNye() : Promise.resolve(0),
  ]);
  return (
    <AdminSidebar
      rolle={rolle}
      paaAdminVaert={paaAdminVaert}
      status={{ tone: status.tone, titel: status.titel, href: status.tone === "groen" ? "/admin" : status.href }}
      taellere={{
        handler: t.haenger + t.fragt + t.markeret + t.ubetalte,
        sager: t.sager,
        // Rødt, når en reklamation kræver staff; ellers dem, der venter på sælgeren (gråt).
        reklamationer: t.reklamationStille + t.reklamationSagAendret || t.reklamationAfventer,
        reklamationerKritisk: t.reklamationStille + t.reklamationSagAendret > 0,
        // Rødt: indsigelser venter på afgørelse. Ellers spærrede sælgere (gråt).
        ekstraFragt: t.ekstraFragtIndsigelser || t.ekstraFragtForfaldne,
        ekstraFragtKritisk: t.ekstraFragtIndsigelser > 0,
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

async function SaelgerMenu({ paaAdminVaert }: { paaAdminVaert: boolean }) {
  const antalErhverv = await hentErhvervNye();
  const status: MiniStatus =
    antalErhverv > 0
      ? {
          tone: "gul",
          titel: `${antalErhverv} ${antalErhverv === 1 ? "ny henvendelse venter" : "nye henvendelser venter"}`,
          href: "/admin/erhverv",
        }
      : { tone: "groen", titel: "Ingen nye henvendelser", href: "/admin/erhverv" };
  return <AdminSidebar rolle="saelger" paaAdminVaert={paaAdminVaert} taellere={{ ...INGEN_TAELLERE, erhverv: antalErhverv }} status={status} />;
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
  //
  // Mørkt navy-tema: data-tema="admin-moerk" sidder på en indpakning (uden
  // egen boks: display: contents) om indholdet og kvitteringen. Tokens får
  // mørke værdier derinde (globals.css), så menuen beholder sin skovgrønne
  // stil, og resten af hjemmesiden ikke påvirkes.
  //
  // <main> er "relative", så absolut placerede elementer derinde (fx sr-only-
  // tekster) har main som ophav og klippes af dens scroll. Uden det regnes de
  // ud fra <body> og forlænger hele dokumentet med en hvid flade under admin
  // (fejl set på admin.bidhamr.dk, 20. okt. 2026). Højden bruger dvh, så
  // mobilens adresselinje ikke giver ekstra scroll; html/body får navy i
  // globals.css (html:has([data-tema="admin-moerk"])).
  return (
    <div className="flex h-[calc(100dvh-var(--samtykke-hoejde,0px))] bg-groen-mork">
      {menu}
      <div data-tema="admin-moerk" className="contents">
        <main
          id="admin-indhold"
          className="relative min-w-0 flex-1 overflow-auto bg-admin-bg pt-14 lg:border-l lg:border-admin-skel lg:pt-0"
        >
          {bjaelke}
          <div className="border-b border-admin-kant bg-white/70 px-4 py-2.5 sm:px-6">
            <AdminTopSoeg erhverv={erhverv} />
          </div>
          {children}
        </main>
        <Kvittering />
      </div>
      {/* "Meld fejl" til staff før lancering (ellers intet). */}
      <Suspense fallback={null}>
        <BetaFejlKnap />
      </Suspense>
    </div>
  );
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Al adgang går gennem hentStaffAdgang (src/lib/adminAuth.ts): med
  // ADMIN_VAERT sat kræves admin-hosten, to-trins-login (aal2, kode højst 12
  // timer gammel), aktiv i databasen og en staff-rolle. Uden ADMIN_VAERT kun
  // rollen, som før. Svaret deles med siden (cache()).
  const adgang = await hentStaffAdgang();
  const paaAdminVaert = erAdminVaert((await headers()).get("host"));

  // Rollen 'saelger' (erhvervssælger) kommer ind, men ser KUN Erhverv.
  // Alle andre admin-sider og -actions afviser rollen selv (assertRole/
  // kraevSideRolle kender den ikke), og proxyen sender saelger videre til
  // /admin/erhverv fra alle andre admin-stier (src/lib/supabase/middleware.ts).
  if (adgang.ok && adgang.rolle === "saelger") {
    return (
      <Ramme
        erhverv
        menu={
          <Suspense fallback={<MenuPladsholder />}>
            <SaelgerMenu paaAdminVaert={paaAdminVaert} />
          </Suspense>
        }
      >
        {children}
      </Ramme>
    );
  }

  if (!adgang.ok) {
    // Uden ADMIN_VAERT som før: til forsiden. Med: samme afvisning som
    // siderne (login- eller kode-siden på admin-hosten, til admin-hosten fra
    // hovedsitet, ellers "Siden findes ikke").
    if (!adminVaertAktiv()) redirect("/");
    await kraevSideRolle("medarbejder");
    notFound();
  }
  const rolle = adgang.rolle;
  if (rolle !== "chef" && rolle !== "admin" && rolle !== "medarbejder") notFound();

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
          <StaffMenu rolle={rolle} paaAdminVaert={paaAdminVaert} />
        </Suspense>
      }
    >
      {children}
    </Ramme>
  );
}
