import { NextResponse, type NextRequest } from "next/server";
import { assertRole } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { erMaaned, konkurrenceCsv, type CsvRaekke } from "@/lib/konkurrence/regler";

// Deltagerlisten for en måned som CSV (Admin → Konkurrence). KUN chef - alle
// andre får 404 (rollen tjekkes her og igen i databasen med p_chef). Kun de
// nødvendige felter: måned, bruger-id, navn og antal lod (+ lod-intervallet,
// når listen er fastfrosset ved lodtrækningen). Ingen e-mail eller adresse.
// Kun GET, ingen ændringer. ?maaned=YYYY-MM (dansk tid).

export const dynamic = "force-dynamic";

function svar(status: number, tekst: string) {
  return new NextResponse(tekst, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  let adgang: Awaited<ReturnType<typeof assertRole>>;
  try {
    adgang = await assertRole("chef");
  } catch {
    return svar(404, "Siden findes ikke.");
  }
  const maaned = req.nextUrl.searchParams.get("maaned");
  if (!erMaaned(maaned)) return svar(400, "Vælg en gyldig måned (ÅÅÅÅ-MM).");

  const { data, error } = await adgang.admin.rpc("konkurrence_admin_liste", {
    p_chef: adgang.userId,
    p_maaned: maaned,
  });
  if (error) {
    await logDriftFejl({ kilde: "server", hvor: "admin/konkurrence/csv", fejl: error, brugerId: adgang.userId });
    return svar(500, "Listen kunne ikke hentes. Prøv igen om lidt.");
  }
  const rows = (data ?? []) as (CsvRaekke & { fastfrosset: boolean })[];
  const fastfrosset = rows.some((r) => r.fastfrosset);
  return new NextResponse(konkurrenceCsv(maaned, rows, fastfrosset), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bidhamr-konkurrence-${maaned}${fastfrosset ? "-fastfrosset" : ""}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
