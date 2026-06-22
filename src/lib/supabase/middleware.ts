import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Routes der er tilgængelige uden login, mens resten af appen er bag
// venteliste-gaten. "/api" undtages så fx /api/venteliste stadig kan kaldes
// fra splash-siden af besøgende uden session.
const OFFENTLIGE_RUTER = ["/coming-soon", "/login", "/signup", "/api"];

function erOffentligRute(pathname: string) {
  return OFFENTLIGE_RUTER.some(
    (rute) => pathname === rute || pathname.startsWith(`${rute}/`),
  );
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

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
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { data } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;

  // Logget ind bruger på splash-siden skal videre til den rigtige forside.
  if (pathname === "/coming-soon" && data.user) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Ikke logget ind og forsøger at tilgå noget andet end de offentlige ruter
  // -> hele appen er bag venteliste-gaten, ingen adgang uden login.
  if (!erOffentligRute(pathname) && !data.user) {
    return NextResponse.redirect(new URL("/coming-soon", request.url));
  }

  return supabaseResponse;
}
