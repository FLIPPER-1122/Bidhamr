import { NextResponse, type NextRequest } from "next/server";
import { assertRole } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { CSV_MAKS_RAEKKER, maanedInterval, pengeCsv, type Postering } from "@/lib/admin/pengeOekonomi";

// Månedens posteringer som CSV til regnskabet (Admin -> Penge). KUN chef -
// alle andre får 404 (rollen tjekkes her og igen i databasen med p_chef).
// Kun GET, ingen ændringer. ?maaned=YYYY-MM (dansk tid). Har måneden flere
// end 20.000 posteringer, gives en tydelig fejl i stedet for at klippe stille.

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
  const { maaned, fra, til } = maanedInterval(req.nextUrl.searchParams.get("maaned"));
  const { data, error } = await adgang.admin.rpc("admin_penge_posteringer", {
    p_chef: adgang.userId,
    p_fra: fra.toISOString(),
    p_til: til.toISOString(),
    // Én ekstra række: så kan vi se, om der er flere end grænsen.
    p_graense: CSV_MAKS_RAEKKER + 1,
  });
  if (error) {
    await logDriftFejl({ kilde: "server", hvor: "admin/penge/csv", fejl: error, brugerId: adgang.userId });
    return svar(500, "Posteringerne kunne ikke hentes. Prøv igen om lidt.");
  }
  const rows = (data ?? []) as Postering[];
  if (rows.length > CSV_MAKS_RAEKKER) {
    return svar(
      413,
      `Måneden ${maaned} har over ${CSV_MAKS_RAEKKER.toLocaleString("da-DK")} posteringer, og CSV-filen ville blive ufuldstændig. Intet er hentet. Skriv til udvikleren, så eksporten kan deles op.`,
    );
  }
  return new NextResponse(pengeCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bidhamr-penge-${maaned}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
