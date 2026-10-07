import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logDriftFejl } from "@/lib/drift";

// "Download dine data" (GDPR). Formularen på /konto poster hertil, og svaret
// er en JSON-fil. Indholdet bygges af mine_data() i databasen (udleder
// brugeren af auth.uid(), højst 1 gang i timen) - appen kan bruge samme RPC.
// POST (ikke GET), så et link eller prefetch ikke kan bruge timens udtræk.
export async function POST(req: NextRequest) {
  // Kun fra vores egen side (formularen på /konto). Sammenlignes med
  // Host-headeren, så det også virker bag Vercels proxy.
  const vaert = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const origin = req.headers.get("origin");
  let fremmed = false;
  try {
    fremmed = !!origin && new URL(origin).host !== vaert;
  } catch {
    fremmed = true;
  }
  if (fremmed) {
    return NextResponse.json({ fejl: "Ugyldig forespørgsel." }, { status: 403 });
  }
  const base = origin ?? req.nextUrl.origin;

  const supabase = await createClient();
  const { data: brugerData } = await supabase.auth.getUser();
  if (!brugerData.user) {
    return NextResponse.redirect(new URL("/login?redirect=/konto%23dine-data", base), 303);
  }

  const { data, error } = await supabase.rpc("mine_data");
  if (error) {
    const tilbage = new URL("/konto", base);
    if (error.code === "BHR01") {
      tilbage.searchParams.set("data", "vent");
    } else {
      await logDriftFejl({ kilde: "server", sti: "/konto/data", fejl: error, brugerId: brugerData.user.id });
      tilbage.searchParams.set("data", "fejl");
    }
    tilbage.hash = "dine-data";
    return NextResponse.redirect(tilbage, 303);
  }

  // Egne maksimumbud (automatisk bud) er med i mine_data() under
  // "mine_maksimumbud" (20261010010000_autobud.sql) - også for appen.

  const dato = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });
  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="bidhamr-mine-data-${dato}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
