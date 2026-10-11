import { redirect } from "next/navigation";
import { kraevSideRolle } from "@/lib/adminAuth";
import { direkteTil, soegErhverv, soegStaff } from "@/lib/admin/soeg";
import SoegResultater from "@/components/admin/SoegResultater";

// Søgningen øverst i admin (medarbejder og op). Erhverv (firmaer m.m.) søges
// kun med, når man er chef. Ét resultat -> direkte dertil.
export const metadata = { title: "Søg i admin" };

export default async function AdminSoeg({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { admin, rolle } = await kraevSideRolle("medarbejder");
  const q = ((await searchParams).q ?? "").trim().slice(0, 120);
  const [staff, erhverv] = await Promise.all([
    soegStaff(admin, q),
    rolle === "chef" ? soegErhverv(admin, q) : Promise.resolve([]),
  ]);
  const traef = [...staff, ...erhverv];
  const til = direkteTil(traef);
  if (til) redirect(til);
  return <SoegResultater q={q} traef={traef} />;
}
