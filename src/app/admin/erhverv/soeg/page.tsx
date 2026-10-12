import { redirect } from "next/navigation";
import { kraevErhvervSide } from "@/lib/adminAuth";
import { direkteTil, soegErhverv } from "@/lib/admin/soeg";
import SoegResultater from "@/components/admin/SoegResultater";

// Søgning for sælgeren (og chefen) i Erhverv: firmaer, henvendelser og
// klager over firmaer. Ét resultat -> direkte dertil.
export const metadata = { title: "Søg i Erhverv" };

export default async function ErhvervSoeg({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { admin } = await kraevErhvervSide();
  const q = ((await searchParams).q ?? "").trim().slice(0, 120);
  const traef = await soegErhverv(admin, q);
  const til = direkteTil(traef);
  if (til) redirect(til);
  return <SoegResultater q={q} traef={traef} erhverv />;
}
