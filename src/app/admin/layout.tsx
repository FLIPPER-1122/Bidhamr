import { Suspense } from "react";
import { redirect } from "next/navigation";
import BetaFejlKnap from "@/components/betafejl/BetaFejlKnap";
import { hentBruger, hentMinRolle } from "@/lib/supabase/bruger";
import AdminSidebar, { INGEN_TAELLERE, type MiniStatus } from "@/components/admin/AdminSidebar";
import AdminTopSoeg from "@/components/admin/AdminTopSoeg";
import Kvittering from "@/components/admin/Kvittering";
import { beregnStatus, koePunkter } from "@/lib/admin/statuslinje";
import { hentAntalUbetalte } from "@/app/actions/adminActions";
import { hentAntalBetalingerTilHandling } from "@/app/actions/adminBetalinger";
import { antalUbesvaredeStaffSamtaler } from "@/app/actions/staffChat";
import { hentAntalAabneSager } from "@/app/actions/adminSager";
import { hentAntalKontoLukninger } from "@/app/actions/adminKontoLukning";
import { hentAntalTryghed } from "@/app/actions/adminTryghed";
import { hentAntalDsa } from "@/app/actions/adminDsa";
import { hentAntalNyeErhvervHenvendelser } from "@/app/actions/adminErhverv";

// Fælles ramme for hele admin: menu, søgning øverst og kvitteringen efter en
// handling (<Kvittering />, så den virker på alle sider).
function Ramme({
  menu,
  erhverv,
  children,
}: {
  menu: React.ReactNode;
  erhverv: boolean;
  children: React.ReactNode;
}) {
  // Højden trækker cookie-bannerets højde fra (--samtykke-hoejde), så
  // banneret aldrig dækker knapper nederst i admin - heller ikke på mobil.
  return (
    <div className="flex h-[calc(100vh-var(--samtykke-hoejde,0px))] bg-admin-bg">
      {menu}
      <main id="admin-indhold" className="min-w-0 flex-1 overflow-auto bg-admin-bg pt-14 lg:pt-0">
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
  // cache() i src/lib/supabase/bruger.ts). Menuens tællere startes, så snart
  // rollen er kendt, i stedet for at vente på begge - hver tæller kalder
  // desuden selv assertRole (samme delte svar) og giver ingen data uden adgang.
  // Trin 3 (docs/ADMIN-REDESIGN.md) erstatter kaldene med én admin_status().
  const erStaff = (r: string | null) => r === "chef" || r === "admin" || r === "medarbejder";
  const taellerLoefte = hentMinRolle().then((r) =>
    erStaff(r)
      ? Promise.all([
          hentAntalUbetalte(),
          hentAntalBetalingerTilHandling(),
          antalUbesvaredeStaffSamtaler(),
          hentAntalAabneSager(),
          hentAntalKontoLukninger(),
          hentAntalTryghed(),
          hentAntalDsa(),
        ])
      : null,
  );
  // Erhverv-tælleren (nye henvendelser) kun for chef og saelger.
  const erhvervLoefte = hentMinRolle().then((r) =>
    r === "chef" || r === "saelger" ? hentAntalNyeErhvervHenvendelser() : null,
  );
  const [user, rolle] = await Promise.all([hentBruger(), hentMinRolle()]);

  // Rollen 'saelger' (erhvervssælger) kommer ind, men ser KUN Erhverv.
  // Alle andre admin-sider og -actions afviser rollen selv (assertRole/
  // kraevSideRolle kender den ikke), og proxyen sender saelger videre til
  // /admin/erhverv fra alle andre admin-stier (src/lib/supabase/middleware.ts).
  if (user && rolle === "saelger") {
    const erhverv = await erhvervLoefte;
    const antalErhverv = erhverv && "antal" in erhverv ? erhverv.antal : 0;
    const status: MiniStatus =
      antalErhverv > 0
        ? {
            tone: "gul",
            titel: `${antalErhverv} ${antalErhverv === 1 ? "ny henvendelse venter" : "nye henvendelser venter"}`,
            href: "/admin/erhverv",
          }
        : { tone: "groen", titel: "Ingen nye henvendelser", href: "/admin/erhverv" };
    return (
      <Ramme erhverv menu={<AdminSidebar rolle="saelger" taellere={{ ...INGEN_TAELLERE, erhverv: antalErhverv }} status={status} />}>
        {children}
      </Ramme>
    );
  }

  if (!user || !erStaff(rolle)) {
    redirect("/");
  }

  // En fejl i en tæller må ikke vælte hele admin-panelet - den tæller bare 0.
  const taellere = await taellerLoefte;
  if (!taellere) redirect("/");
  const [ubetalte, betalinger, chats, sager, lukninger, tryghed, dsa] = taellere;
  const n = (r: object, k: string) => (k in r ? Number((r as Record<string, unknown>)[k]) || 0 : 0);
  const erhverv = await erhvervLoefte;

  const dsaAntal = n(dsa, "antal");
  const dsaOverskredet = n(dsa, "overskredet");
  const antalSager = n(sager, "antal");
  const antalBetalinger = n(betalinger, "antal");

  const status = beregnStatus(
    koePunkter({ dsaOverskredet, dsa: dsaAntal, sager: antalSager, betalinger: antalBetalinger }),
  );

  return (
    <Ramme
      erhverv={false}
      menu={
        <AdminSidebar
          rolle={rolle}
          status={{ tone: status.tone, titel: status.titel, href: status.tone === "groen" ? "/admin" : status.href }}
          taellere={{
            handler: n(ubetalte, "antal"),
            sager: antalSager,
            betalinger: antalBetalinger,
            brugere: n(lukninger, "antal"),
            henvendelser: n(tryghed, "kontakt") + n(chats, "antal"),
            anmeldelser: dsaAntal + n(tryghed, "rapporter") + n(tryghed, "bedoemmelser"),
            anmeldelserKritisk: dsaOverskredet > 0,
            erhverv: erhverv ? n(erhverv, "antal") : 0,
          }}
        />
      }
    >
      {children}
    </Ramme>
  );
}
