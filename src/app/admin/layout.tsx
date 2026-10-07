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
  const [user, rolle] = await Promise.all([hentBruger(), hentMinRolle()]);

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

  // Højden trækker cookie-bannerets højde fra (--samtykke-hoejde), så
  // banneret aldrig dækker knapper nederst i admin - heller ikke på mobil.
  return (
    <div className="flex h-[calc(100vh-var(--samtykke-hoejde,0px))] bg-neutral-50">
      <AdminSidebar rolle={rolle} taellere={{ ubetalte: antalUbetalte, betalinger: antalBetalinger, chats: antalChats, sager: antalSager, kontolukninger: antalLukninger, kontakt: antalKontakt, rapporter: antalRapporter, bedoemmelser: antalBedoemmelser, dsa: antalDsa }} />
      <main className="flex-1 overflow-auto bg-neutral-50 lg:ml-0 pt-14 lg:pt-0">
        {children}
      </main>
    </div>
  );
}
