import { redirect } from "next/navigation";
import { hentStaffAdgang } from "@/lib/adminAuth";
import { sikkerAdminSti } from "@/lib/staffToTrinRegler";
import { AdminLoginForm } from "../Formularer";

// Log ind i admin (admin-hosten). Er man allerede helt inde, sendes man videre.
export default async function AdminLogin({ searchParams }: { searchParams: Promise<{ naeste?: string }> }) {
  const naeste = sikkerAdminSti((await searchParams).naeste);
  const adgang = await hentStaffAdgang();
  if (adgang.ok) redirect(naeste);
  if (adgang.grund === "kraever_kode" || adgang.grund === "ukendt_faktor") {
    redirect(`/adgang/kode?naeste=${encodeURIComponent(naeste)}`);
  }
  if (adgang.grund === "ikke_opsat") redirect("/adgang/kode");
  return <AdminLoginForm naeste={naeste} />;
}
