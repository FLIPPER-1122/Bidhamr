import { NextResponse, type NextRequest } from "next/server";
import { gemNyAdgangskode } from "@/app/actions/auth";
import { anmeldIndhold, klagOverAfgoerelse, klagSomAnmelder } from "@/app/actions/dsa";

// De få handlinger, som en indlogget ALMINDELIG bruger skal kunne udføre på
// en offentlig side, mens siden er lukket for alle andre end staff:
//   ny-adgangskode        /reset-password (recovery-sessionen er et login)
//   dsa-anmeld            /dsa/anmeld og anmeld-knappen (DSA art. 16)
//   dsa-klage-afgoerelse  /dsa/afgoerelse/[id] (DSA art. 20)
//   dsa-klage-anmelder    /dsa/anmeldelse/[id]
//
// Hvorfor ikke bare server actions: gaten i src/lib/supabase/middleware.ts
// afviser alle POST'er fra indloggede almindelige brugere på offentlige
// sidestier, fordi et action-id kan sendes til enhver sti og dermed køre en
// hvilken som helst action (fx afgivBud). En route handler kan derimod kun
// køre præcis det, der står her - derfor er listen lukket.
//
// Funktionerne er de samme som før (samme regler, rate limits og fejl); de
// kaldes bare herfra. Kun fra vores egne sider: Origin skal være sat og være
// vores egen vært (browseren sender altid Origin ved POST).

export const dynamic = "force-dynamic";

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const MAKS_BYTES = 64 * 1024;

type Handling = (fd: FormData) => Promise<unknown>;

function tekst(fd: FormData, navn: string): string | undefined {
  const v = fd.get(navn);
  return typeof v === "string" ? v : undefined;
}

const HANDLINGER: Record<string, Handling> = {
  "ny-adgangskode": (fd) => gemNyAdgangskode(tekst(fd, "password") ?? ""),
  "dsa-anmeld": anmeldIndhold,
  "dsa-klage-afgoerelse": klagOverAfgoerelse,
  "dsa-klage-anmelder": klagSomAnmelder,
};

function svar(status: number, krop: unknown) {
  return NextResponse.json(krop, { status, headers: { "Cache-Control": "no-store" } });
}

function egenOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const vaert = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return !!vaert && new URL(origin).host === vaert;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ handling: string }> }) {
  const { handling } = await ctx.params;
  const fn = Object.hasOwn(HANDLINGER, handling) ? HANDLINGER[handling] : undefined;
  if (!fn) return svar(404, { fejl: GENERISK, kode: "ukendt" });
  if (!egenOrigin(req)) return svar(403, { fejl: GENERISK, kode: "ikke_tilladt" });

  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("multipart/form-data") && !type.startsWith("application/x-www-form-urlencoded")) {
    return svar(400, { fejl: GENERISK, kode: "ugyldig" });
  }
  const laengde = Number(req.headers.get("content-length") ?? "0");
  if (laengde > MAKS_BYTES) return svar(413, { fejl: GENERISK, kode: "ugyldig" });

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return svar(400, { fejl: GENERISK, kode: "ugyldig" });
  }

  try {
    return svar(200, await fn(fd));
  } catch (err) {
    console.error(`/api/offentlig/${handling} fejlede:`, err);
    return svar(500, { fejl: GENERISK, kode: "fejl" });
  }
}
