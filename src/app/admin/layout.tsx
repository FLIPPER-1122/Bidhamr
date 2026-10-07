import { redirect } from "next/navigation";
import { hentBruger, hentMinRolle } from "@/lib/supabase/bruger";
import AdminSidebar from "@/components/admin/AdminSidebar";
import { hentAntalUbetalte } from "@/app/actions/adminActions";
import { hentAntalBetalingerTilHandling } from "@/app/actions/adminBetalinger";
import { antalUbesvaredeStaffSamtaler } from "@/app/actions/staffChat";
import { hentAntalAabneSager } from "@/app/actions/adminSager";
import { hentAntalKontoLukninger } from "@/app/actions/adminKontoLukning";
import { hentAntalTryghed } from "@/app/actions/adminTryghed";
import { hentAntalDsa } from "@/app/actions/adminDsa";
import { hentAntalNyeErhvervHenvendelser } from "@/app/actions/adminErhverv";

const INGEN_TAELLERE = {
  ubetalte: 0,
  betalinger: 0,
  chats: 0,
  sager: 0,
  kontolukninger: 0,
  kontakt: 0,
  rapporter: 0,
  bedoemmelser: 0,
  dsa: 0,
  erhverv: 0,
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Bruger og rolle hentes samtidig (højst én gang pr. forespørgsel, delt via
  // cache() i src/lib/supabase/bruger.ts). Menuens tællere startes, så snart
  // rollen er kendt, i stedet for at vente på begge - hver tæller kalder
  // desuden selv assertRole (samme delte svar) og giver ingen data uden adgang.
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
    return (
      <div className="flex h-[calc(100vh-var(--samtykke-hoejde,0px))] bg-neutral-50">
        <AdminSidebar rolle="saelger" taellere={{ ...INGEN_TAELLERE, erhverv: antalErhverv }} />
        <main className="flex-1 overflow-auto bg-neutral-50 lg:ml-0 pt-14 lg:pt-0">{children}</main>
      </div>
    );
  }

  if (!user || !erStaff(rolle)) {
    redirect("/");
  }

  // Tallet til menuens badge. En fejl her må ikke vælte hele admin-panelet.
  const taellere = await taellerLoefte;
  if (!taellere) redirect("/");
  const [ubetalte, betalinger, chats, sager, lukninger, tryghed, dsa] = taellere;
  const antalUbetalte = "antal" in ubetalte ? ubetalte.antal : 0;
  const antalBetalinger = "antal" in betalinger ? betalinger.antal : 0;
  const antalChats = "antal" in chats ? chats.antal : 0;
  const antalSager = "antal" in sager ? sager.antal : 0;
  const antalLukninger = "antal" in lukninger ? lukninger.antal : 0;
  const antalKontakt = "kontakt" in tryghed ? tryghed.kontakt : 0;
  const antalRapporter = "rapporter" in tryghed ? tryghed.rapporter : 0;
  const antalBedoemmelser = "bedoemmelser" in tryghed ? tryghed.bedoemmelser : 0;
  const antalDsa = "antal" in dsa ? dsa.antal : 0;
  const erhverv = await erhvervLoefte;
  const antalErhverv = erhverv && "antal" in erhverv ? erhverv.antal : 0;

  // Højden trækker cookie-bannerets højde fra (--samtykke-hoejde), så
  // banneret aldrig dækker knapper nederst i admin - heller ikke på mobil.
  return (
    <div className="flex h-[calc(100vh-var(--samtykke-hoejde,0px))] bg-neutral-50">
      <AdminSidebar rolle={rolle} taellere={{ ubetalte: antalUbetalte, betalinger: antalBetalinger, chats: antalChats, sager: antalSager, kontolukninger: antalLukninger, kontakt: antalKontakt, rapporter: antalRapporter, bedoemmelser: antalBedoemmelser, dsa: antalDsa, erhverv: antalErhverv }} />
      <main className="flex-1 overflow-auto bg-neutral-50 lg:ml-0 pt-14 lg:pt-0">
        {children}
      </main>
    </div>
  );
}
