import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { lavMineDataFil } from "@/lib/mineDataFil";

// "Download dine data" (GDPR). Formularen på /konto poster hertil, og svaret
// er en JSON-fil (art. 20, maskinlæsbar) eller en PDF til at læse
// (format=pdf). Samme kode som appens /api/konto/data (src/lib/mineDataFil.ts).
// Indholdet bygges af mine_data() i databasen (udleder
// brugeren af auth.uid(), højst 1 gang i timen) - appen kan bruge samme RPC.
// PDF og JSON bygger på præcis samme kald, så grænsen deles: én fil i timen,
// uanset format. Det kræver ingen ny databasefunktion, og PDF'en kan ikke
// bruges til at omgå grænsen.
// POST (ikke GET), så et link eller prefetch ikke kan bruge timens udtræk.
export async function POST(req: NextRequest) {
  // Kun fra vores egen side (formularen på /konto). Origin SKAL være sat
  // (browseren sender den altid ved POST) og være vores egen vært - samme
  // tjek som /api/offentlig. Sammenlignes med Host-headeren, så det også
  // virker bag Vercels proxy.
  const vaert = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const origin = req.headers.get("origin");
  let egen = false;
  try {
    egen = !!origin && !!vaert && new URL(origin).host === vaert;
  } catch {
    egen = false;
  }
  if (!egen || !origin) {
    return NextResponse.json({ fejl: "Ugyldig forespørgsel." }, { status: 403 });
  }
  const base = origin;

  // Firma-dashboardet (/firma/oplysninger) sender fra=firma med, så en fejl
  // ("vent"/"fejl") vises dér - /konto sender en firmakonto til /firma.
  // Kun de faste værdier bruges, aldrig en sti fra formularen.
  let fraFirma = false;
  let somPdf = false;
  try {
    const formular = await req.formData();
    fraFirma = formular.get("fra") === "firma";
    somPdf = formular.get("format") === "pdf";
  } catch {
    fraFirma = false;
    somPdf = false;
  }
  const tilbageSti = fraFirma ? "/firma/oplysninger" : "/konto";
  const tilbageMed = (status: "vent" | "fejl") => {
    const tilbage = new URL(tilbageSti, base);
    tilbage.searchParams.set("data", status);
    tilbage.hash = "dine-data";
    return NextResponse.redirect(tilbage, 303);
  };

  const supabase = await createClient();
  const { data: brugerData } = await supabase.auth.getUser();
  if (!brugerData.user) {
    return NextResponse.redirect(new URL(`/login?redirect=${encodeURIComponent(`${tilbageSti}#dine-data`)}`, base), 303);
  }

  const fil = await lavMineDataFil(supabase, brugerData.user.id, somPdf, "/konto/data");
  if ("fejl" in fil) return tilbageMed(fil.fejl);

  const krop =
    typeof fil.indhold === "string"
      ? fil.indhold
      : new Blob([fil.indhold as Uint8Array<ArrayBuffer>], { type: fil.type });
  return new NextResponse(krop, {
    status: 200,
    headers: {
      "Content-Type": fil.type,
      "Content-Disposition": `attachment; filename="${fil.filnavn}"`,
      "Cache-Control": "no-store",
    },
  });
}
