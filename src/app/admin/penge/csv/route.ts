import { NextResponse, type NextRequest } from "next/server";
import { getStaffRole } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { maanedInterval, pengeCsv, type Postering } from "@/lib/admin/pengeOekonomi";

// Månedens posteringer som CSV til regnskabet (Admin -> Penge). KUN chef -
// alle andre får 404. Kun GET, ingen ændringer. ?maaned=YYYY-MM (dansk tid).

export const dynamic = "force-dynamic";

function svar(status: number, tekst: string) {
  return new NextResponse(tekst, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  if ((await getStaffRole()) !== "chef") return svar(404, "Siden findes ikke.");
  const { maaned, fra, til } = maanedInterval(req.nextUrl.searchParams.get("maaned"));
  const { data, error } = await createAdminClient().rpc("admin_penge_posteringer", {
    p_fra: fra.toISOString(),
    p_til: til.toISOString(),
    p_graense: 20000,
  });
  if (error) {
    await logDriftFejl({ kilde: "server", hvor: "admin/penge/csv", fejl: error });
    return svar(500, "Posteringerne kunne ikke hentes. Prøv igen om lidt.");
  }
  return new NextResponse(pengeCsv((data ?? []) as Postering[]), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bidhamr-penge-${maaned}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
