import { NextResponse, type NextRequest } from "next/server";
import { gemNyAdgangskode } from "@/app/actions/auth";
import { anmeldIndhold, klagOverAfgoerelse, klagSomAnmelder } from "@/app/actions/dsa";
import { sendErhvervHenvendelse, skiftFirmaPakke } from "@/app/actions/erhverv";
import { betalForPakke, skiftBetalingskort } from "@/lib/erhverv/betalingHandlinger";

// De få handlinger, som en indlogget ALMINDELIG bruger skal kunne udføre på
// en offentlig side, mens siden er lukket for alle andre end staff:
//   ny-adgangskode        /reset-password (recovery-sessionen er et login)
//   dsa-anmeld            /dsa/anmeld og anmeld-knappen (DSA art. 16)
//   dsa-klage-afgoerelse  /dsa/afgoerelse/[id] (DSA art. 20)
//   dsa-klage-anmelder    /dsa/anmeldelse/[id]
//   erhverv-henvendelse   /erhverv/formular (også uden login)
//   firma-skift-pakke     /firma (pakkeskift; firmakonti må før lancering
//                         ikke kalde server actions - se gaten)
//   firma-betal           /firma/abonnement "Betal for din pakke" -> svarer
//                         med Stripe Checkout-adressen ({ ok, url })
//   firma-betalingskort   /firma/abonnement "Skift betalingskort" -> Stripes
//                         kundeportal (kun kort og fakturaer)
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

// origin: sidens egen adresse (kontrolleret i egenOrigin), bruges som
// retur-adresse fra Stripe.
type Handling = (fd: FormData, origin: string) => Promise<unknown>;

function tekst(fd: FormData, navn: string): string | undefined {
  const v = fd.get(navn);
  return typeof v === "string" ? v : undefined;
}

const HANDLINGER: Record<string, Handling> = {
  "ny-adgangskode": (fd) => gemNyAdgangskode(tekst(fd, "password") ?? ""),
  "dsa-anmeld": anmeldIndhold,
  "dsa-klage-afgoerelse": klagOverAfgoerelse,
  "dsa-klage-anmelder": klagSomAnmelder,
  "erhverv-henvendelse": sendErhvervHenvendelse,
  // skiftFirmaPakke kræver selv login, og firma_skift_pakke afviser alle
  // andre end firmakontoen selv.
  "firma-skift-pakke": (fd) => skiftFirmaPakke(tekst(fd, "pakkeId") ?? ""),
  // Kræver login som firmakonto (src/lib/erhverv/betalingHandlinger.ts).
  "firma-betal": (_fd, origin) => betalForPakke(origin),
  "firma-betalingskort": (_fd, origin) => skiftBetalingskort(origin),
};

function svar(status: number, krop: unknown) {
  return NextResponse.json(krop, { status, headers: { "Cache-Control": "no-store" } });
}

// Læser kroppen, men højst maks bytes. "for_stor" ved mere, null ved fejl.
async function laesMedGraense(req: NextRequest, maks: number): Promise<Uint8Array<ArrayBuffer> | "for_stor" | null> {
  if (!req.body) return new Uint8Array(0);
  const laeser = req.body.getReader();
  const dele: Uint8Array[] = [];
  let ialt = 0;
  try {
    for (;;) {
      const { done, value } = await laeser.read();
      if (done) break;
      ialt += value.byteLength;
      if (ialt > maks) {
        await laeser.cancel().catch(() => {});
        return "for_stor";
      }
      dele.push(value);
    }
  } catch {
    return null;
  }
  const ud = new Uint8Array(ialt);
  let pos = 0;
  for (const d of dele) {
    ud.set(d, pos);
    pos += d.byteLength;
  }
  return ud;
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
  // Content-Length skal være der og være inden for grænsen (browsere sender
  // den altid ved fetch med FormData). Headeren kan dog lyve, så kroppen
  // læses også med en grænse - der læses aldrig mere end MAKS_BYTES ind.
  const laengdeHeader = req.headers.get("content-length");
  const laengde = laengdeHeader !== null && /^\d{1,12}$/.test(laengdeHeader.trim()) ? Number(laengdeHeader) : NaN;
  if (!Number.isFinite(laengde)) return svar(411, { fejl: GENERISK, kode: "ugyldig" });
  if (laengde > MAKS_BYTES) return svar(413, { fejl: GENERISK, kode: "ugyldig" });

  const krop = await laesMedGraense(req, MAKS_BYTES);
  if (krop === "for_stor") return svar(413, { fejl: GENERISK, kode: "ugyldig" });
  if (krop === null) return svar(400, { fejl: GENERISK, kode: "ugyldig" });

  let fd: FormData;
  try {
    // Samme Content-Type (med boundary) som den oprindelige forespørgsel.
    fd = await new Response(krop, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return svar(400, { fejl: GENERISK, kode: "ugyldig" });
  }

  try {
    return svar(200, await fn(fd, new URL(req.headers.get("origin") ?? "").origin));
  } catch (err) {
    console.error(`/api/offentlig/${handling} fejlede:`, err);
    return svar(500, { fejl: GENERISK, kode: "fejl" });
  }
}
