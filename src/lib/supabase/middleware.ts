import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { erTestdatabase } from "@/lib/miljoe";

// Routes der er tilgængelige uden login, mens resten af appen er bag
// venteliste-gaten. Kun API-ruter med egen adgangskontrol undtages:
// /api/waitlist (offentlig tilmelding fra splash-siden), /api/webhooks
// (Stripe-signatur) og /api/cron (CRON_SECRET, fail closed). Alle andre
// /api-ruter kræver login + rolle som resten af appen.
const OFFENTLIGE_RUTER = [
  "/coming-soon",
  "/login",
  "/glemt-adgangskode",
  "/nulstil-adgangskode",
  "/reset-password",
  "/auth",
  "/api/waitlist",
  "/api/webhooks",
  "/api/cron",
];

// Inden launch er appen lukket for almindelige brugere. Kun disse roller
// slipper igennem - alle andre (også indloggede) sendes til splash-siden.
const ROLLER_MED_ADGANG = ["chef", "admin", "medarbejder"];

function erOffentligRute(pathname: string) {
  return OFFENTLIGE_RUTER.some(
    (rute) => pathname === rute || pathname.startsWith(`${rute}/`),
  );
}

// ekstraHeadere (fx CSP-nonce fra src/proxy.ts) sendes med til renderingen.
// Headerne bygges fra request.headers hver gang, saa opdaterede cookies kommer med.
export async function updateSession(
  request: NextRequest,
  ekstraHeadere: Record<string, string> = {},
) {
  const naeste = () => {
    const headers = new Headers(request.headers);
    for (const [k, v] of Object.entries(ekstraHeadere)) headers.set(k, v);
    return NextResponse.next({ request: { headers } });
  };
  let supabaseResponse = naeste();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = naeste();
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { pathname } = request.nextUrl;

  // Offentlige ruter skal aldrig redirecte, uanset login-status.
  if (erOffentligRute(pathname)) {
    return supabaseResponse;
  }

  const { data } = await supabase.auth.getUser();

  // Ikke logget ind og forsøger at tilgå noget andet end de offentlige ruter
  // -> hele appen er bag venteliste-gaten, ingen adgang uden login.
  if (!data.user) {
    return NextResponse.redirect(new URL("/coming-soon", request.url));
  }

  // På testdatabasen (kun npm run dev via .env.local) må alle indloggede
  // brugere komme forbi gaten, så almindelige testbrugere kan bruge siden.
  // Admin er stadig beskyttet af rolle-tjekket i src/app/admin/layout.tsx.
  // erTestdatabase() er fail closed, så produktion er uændret.
  if (erTestdatabase()) {
    return supabaseResponse;
  }

  // Logget ind er ikke nok inden launch: rollen skal give adgang.
  // rolle er ikke laesbar via kolonne-grants; min_rolle() bruger auth.uid().
  const { data: rolle } = await supabase.rpc("min_rolle");

  if (typeof rolle !== "string" || !ROLLER_MED_ADGANG.includes(rolle)) {
    return NextResponse.redirect(new URL("/coming-soon", request.url));
  }

  return supabaseResponse;
}
