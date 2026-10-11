import { Suspense } from "react";
import { redirect } from "next/navigation";
import BetaFejlKnap from "@/components/betafejl/BetaFejlKnap";
import { hentBruger, hentMinRolle } from "@/lib/supabase/bruger";
import AdminSidebar, { INGEN_TAELLERE, type MiniStatus } from "@/components/admin/AdminSidebar";
import AdminTopSoeg from "@/components/admin/AdminTopSoeg";
import Kvittering from "@/components/admin/Kvittering";
import { beregnStatus, koePunkter } from "@/lib/admin/statuslinje";
import { hentErhvervNye, hentStaffTal } from "@/lib/admin/taellere";

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
  // rollen er kendt. Tællerne deles med siden via cache() (src/lib/admin/taellere.ts).
  const erStaff = (r: string | null) => r === "chef" || r === "admin" || r === "medarbejder";
  const taellerLoefte = hentMinRolle().then((r) => (erStaff(r) ? hentStaffTal() : null));
  // Erhverv-tælleren (nye henvendelser) kun for chef og saelger.
  const erhvervLoefte = hentMinRolle().then((r) => (r === "chef" || r === "saelger" ? hentErhvervNye() : 0));
  const [user, rolle] = await Promise.all([hentBruger(), hentMinRolle()]);

  // Rollen 'saelger' (erhvervssælger) kommer ind, men ser KUN Erhverv.
  // Alle andre admin-sider og -actions afviser rollen selv (assertRole/
  // kraevSideRolle kender den ikke), og proxyen sender saelger videre til
  // /admin/erhverv fra alle andre admin-stier (src/lib/supabase/middleware.ts).
  if (user && rolle === "saelger") {
    const antalErhverv = await erhvervLoefte;
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

  const t = await taellerLoefte;
  if (!t) redirect("/");
  const antalErhverv = await erhvervLoefte;
  const status = beregnStatus(
    koePunkter({ dsaOverskredet: t.dsaOverskredet, dsa: t.dsa, sager: t.sager, betalinger: t.betalinger }),
  );

  return (
    <Ramme
      erhverv={false}
      menu={
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
      }
    >
      {children}
    </Ramme>
  );
}
