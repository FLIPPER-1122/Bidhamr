import { notFound, redirect } from "next/navigation";
import { hentStaffAdgang } from "@/lib/adminAuth";
import { hentBruger } from "@/lib/supabase/bruger";
import { createClient } from "@/lib/supabase/server";
import { minStaffStatus } from "@/lib/staffToTrin";
import { sikkerAdminSti } from "@/lib/staffToTrinRegler";
import { AdminKodeForm, LogUdLink, LukketBesked } from "../Formularer";

// Koden fra app'en: efter login og igen, når den seneste kode er ældre end
// STAFF_TO_TRIN_MAKS_TIMER (standard 12 timer).
export default async function AdminKode({ searchParams }: { searchParams: Promise<{ naeste?: string }> }) {
  const naeste = sikkerAdminSti((await searchParams).naeste);
  const bruger = await hentBruger();
  if (!bruger) redirect(`/adgang/login?naeste=${encodeURIComponent(naeste)}`);

  const adgang = await hentStaffAdgang();
  if (adgang.ok) redirect(naeste);

  const status = await minStaffStatus(await createClient());
  if (!status) throw new Error("min_staff_adgang fejlede");
  if (!status.staff) notFound();
  if (!status.aktiv) {
    if (status.tilmelding_aaben) redirect("/adgang/opsaet");
    return (
      <div className="rounded-none border border-kant bg-white p-5 shadow-kort sm:p-8">
        <h1 className="text-[26px] leading-tight sm:text-[30px]">To-trins-login mangler</h1>
        <LukketBesked />
        <div className="mt-4 text-center">
          <LogUdLink />
        </div>
      </div>
    );
  }
  // aal2 i forvejen, men koden er for gammel: "skriv en ny".
  return <AdminKodeForm naeste={naeste} fornyelse={status.aal === "aal2"} />;
}
