import Link from "next/link";
import BrugereFaner from "@/components/admin/BrugereFaner";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminSide from "@/components/admin/AdminSide";
import { FounderFaseMaerke, founderDato, type FounderAftale } from "@/components/admin/SellerFounderKort";
import { kraevSideRolle } from "@/lib/adminAuth";
import { kroner } from "@/lib/kroner";

// Admin -> Brugere -> Seller founders (KUN chef): alle aftaler, aktive først.
// Ét klik til brugersiden, hvor aftalen oprettes, rettes og stoppes
// (SellerFounderKort). Data: seller_founder_liste (20261102420000), som
// tjekker chef-rollen igen.
export default async function AdminSellerFounders() {
  const { admin, userId } = await kraevSideRolle("chef");
  const { data, error } = await admin.rpc("seller_founder_liste", { p_chef: userId });
  if (error) console.error("seller_founder_liste fejlede:", error);
  const liste = (Array.isArray(data) ? data : []) as FounderAftale[];
  const aktive = liste.filter((a) => !a.stoppet_kl).length;

  return (
    <AdminSide>
      <AdminSideHoved
        titel="Seller founders"
        forklaring="Private sælgere med en founder-aftale: 0 kr. i købergebyr og sælgergebyr i 6 måneder fra startdatoen, derefter 50 %. Gør en bruger til founder fra brugersiden (søg brugeren, og brug boksen Seller founder)."
      />

      <BrugereFaner aktiv="founders" />

      {error && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg px-5 py-4 text-sm text-fejl-tekst">
          Listen kunne ikke hentes. Prøv igen om lidt.
        </p>
      )}

      {!error && (
        <p className="text-sm text-tekst-svag">
          {aktive} aktive · {liste.length - aktive} stoppede
        </p>
      )}

      <div className="space-y-2">
        {liste.map((a) => (
          <Link
            key={a.bruger_id}
            href={`/admin/brugere/${a.bruger_id}`}
            className="flex flex-wrap items-center gap-3 rounded-none border border-admin-kant bg-white p-4 transition-shadow hover:shadow-md sm:gap-4"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-tekst">{a.navn ?? "Uden navn"}</p>
              <p className="truncate text-sm text-tekst-svag">
                {a.email ?? ""} · start {founderDato(a.start_dato)}
              </p>
            </div>
            <p className="text-sm text-tekst-daempet">
              {a.handler} {a.handler === 1 ? "handel" : "handler"} · rabat {kroner(Number(a.rabat_oere))}
            </p>
            <FounderFaseMaerke a={a} />
          </Link>
        ))}
        {!error && liste.length === 0 && (
          <div className="rounded-none border border-admin-kant bg-white p-10 text-center text-tekst-svag">
            Ingen seller founders endnu.
          </div>
        )}
      </div>
    </AdminSide>
  );
}
