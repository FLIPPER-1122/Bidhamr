import { type NextRequest } from "next/server";
import { assertRole } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { hentReklamationspakke } from "@/lib/reklamation/pakke";
import { FOR_MANGE, reklamationZipIndenForGraense } from "@/lib/reklamation/graense";
import { reklamationStaffAdgang } from "@/lib/reklamation/staffAdgang";
import { reklamationZipSvar, tekstSvar } from "@/lib/reklamation/zipSvar";

// Staff: alle billeder til en reklamation som én ZIP (sælgers pakkebilleder +
// købers skadebilleder + oplysninger.txt).
//
// GET /admin/reklamationer/<id>/billeder
// KUN staff (medarbejder+) med to-trins-login (assertRole -> hentStaffAdgang),
// som ikke er inhabil (part i handlen eller har handlet med en af parterne).
// Alle andre får 404 (inhabil: 403 med forklaring). Grænse: 60 ZIP'er i
// timen pr. medarbejder (fejler lukket). Ingen ændringer. Sælgeren har
// ingen adgang til pakken eller billederne (Filip, 22. okt. 2026).

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let adgang: Awaited<ReturnType<typeof assertRole>>;
  try {
    adgang = await assertRole("medarbejder");
  } catch {
    return tekstSvar(404, "Siden findes ikke.");
  }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return tekstSvar(404, "Reklamationen findes ikke.");
  const rid = id.toLowerCase();

  try {
    const a = await reklamationStaffAdgang(adgang.admin, adgang.userId, rid);
    if (a === "ikke_fundet") return tekstSvar(404, "Reklamationen findes ikke.");
    if (a === "inhabil") {
      return tekstSvar(403, "Du er inhabil i denne handel og kan ikke hente billederne. Lad en kollega tage den.");
    }
    if (!(await reklamationZipIndenForGraense(adgang.userId))) return tekstSvar(429, FOR_MANGE);
    const res = await hentReklamationspakke(adgang.admin, rid);
    if (!res) return tekstSvar(404, "Reklamationen findes ikke.");
    return await reklamationZipSvar(adgang.admin, res.pakke, res.filer, adgang.userId);
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "admin/reklamationer/billeder", fejl: err, brugerId: adgang.userId });
    return tekstSvar(500, "Billederne kunne ikke hentes. Prøv igen om lidt.");
  }
}
