import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logDriftFejl } from "@/lib/drift";
import { indenForGraense } from "@/lib/rateLimit";
import { sendtPdf, type SendtRaekke } from "@/lib/erhverv/firmaFakturaServer";
import { firmaFakturaCsv, pdfFilnavn, type FirmaFakturaData } from "@/lib/erhverv/firmaFaktura";
import { lavZip } from "@/lib/zip";

// Eksport til firmaets regnskab: alle SENDTE fakturaer og kreditnotaer med
// udstedelsesdato i perioden - som CSV eller PDF'er i en ZIP. Kun firmaet
// selv (firma_fakturaer_eksport filtrerer på auth.uid() - også en lukket
// firmakonto, opbevaringspligt). Kun GET.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DATO = /^\d{4}-\d{2}-\d{2}$/;
const MAKS_ZIP = 500;
const SIDE = 1000;

type EksportRaekke = Omit<SendtRaekke, "status" | "data"> & { nummer: number; data: FirmaFakturaData };

function gyldigDato(v: string | null): string | null {
  if (!v || !DATO.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

function tekst(status: number, besked: string) {
  return new NextResponse(besked, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const fra = gyldigDato(req.nextUrl.searchParams.get("fra"));
  const til = gyldigDato(req.nextUrl.searchParams.get("til"));
  const format = req.nextUrl.searchParams.get("format") === "zip" ? "zip" : "csv";
  if (!fra || !til || fra > til) return tekst(400, "Vælg en gyldig periode (fra og med - til og med).");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL(`/login?redirect=${encodeURIComponent("/firma/fakturaer")}`, req.url));
  if (!(await indenForGraense("firma_faktura_eksport", user.id))) return tekst(429, "Du har hentet mange filer på kort tid. Vent lidt, og prøv igen.");

  try {
    // Side for side efter nummer (firma_fakturaer_eksport) - intet samlet
    // loft. Også lukkede firmakonti (opbevaringspligt).
    const sendte: EksportRaekke[] = [];
    let efter = 0;
    for (;;) {
      const { data, error } = await supabase.rpc("firma_fakturaer_eksport", { p_fra: fra, p_til: til, p_efter: efter, p_antal: SIDE });
      if (error) {
        if (error.code === "42501") return tekst(404, "Siden findes ikke.");
        throw error;
      }
      const side = (data as EksportRaekke[] | null) ?? [];
      if (side.length === 0) break;
      sendte.push(...side);
      if (format === "zip" && sendte.length > MAKS_ZIP) break;
      if (side.length < SIDE) break;
      efter = side[side.length - 1].nummer;
    }

    if (format === "csv") {
      return new NextResponse(firmaFakturaCsv(sendte.map((f) => f.data)), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="fakturaer-${fra}-til-${til}.csv"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (sendte.length === 0) return tekst(404, "Der er ingen sendte fakturaer i perioden.");
    // ZIP'en bygges i hukommelsen: højst MAKS_ZIP PDF'er pr. fil (CSV'en har
    // intet loft). Firmaet deler perioden op.
    if (sendte.length > MAKS_ZIP) return tekst(400, `Vælg en kortere periode (højst ${MAKS_ZIP} fakturaer pr. ZIP-fil). CSV-filen har ingen grænse.`);
    const filer = [];
    for (const f of sendte) {
      if (f.saelger_id !== user.id) continue;
      filer.push({ navn: pdfFilnavn(f.data), data: await sendtPdf({ ...f, status: "sendt" }) });
    }
    return new NextResponse(Buffer.from(lavZip(filer)), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="fakturaer-${fra}-til-${til}.zip"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "firma/fakturaer/eksport", fejl: err, brugerId: user.id });
    return tekst(500, "Filen kunne ikke laves lige nu. Prøv igen om lidt.");
  }
}
