import { notFound, redirect } from "next/navigation";
import { hentBruger } from "@/lib/supabase/bruger";
import { createClient } from "@/lib/supabase/server";
import { minStaffStatus } from "@/lib/staffToTrin";
import { AdminOpsaetForm, LogUdLink, LukketBesked } from "../Formularer";

// Opsætning af to-trins-login: QR-kode, første kode og 10 gendannelseskoder.
// Kun i et åbent tilmeldingsvindue (14 dage ved første udrulning, derefter
// 24 timer, som chefen åbner under Medarbejdere).
export default async function AdminOpsaet() {
  const bruger = await hentBruger();
  if (!bruger) redirect("/adgang/login");
  const status = await minStaffStatus(await createClient());
  if (!status) throw new Error("min_staff_adgang fejlede");
  if (!status.staff) notFound();
  if (status.aktiv) redirect("/adgang/kode");
  if (!status.tilmelding_aaben) {
    return (
      <div className="rounded-[14px] border border-kant bg-white p-5 shadow-kort sm:p-8">
        <h1 className="text-[26px] leading-tight sm:text-[30px]">Tilmeldingen er lukket</h1>
        <LukketBesked />
        <div className="mt-4 text-center">
          <LogUdLink />
        </div>
      </div>
    );
  }
  return <AdminOpsaetForm />;
}
