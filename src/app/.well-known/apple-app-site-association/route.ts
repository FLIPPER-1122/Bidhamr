import { APP_LINKS_HEADERE, appleAppSiteAssociation } from "@/lib/appLinks";

// Universal links (iOS). Apple henter filen uden filendelse, uden redirect og
// uden login - se src/lib/appLinks.ts.
export function GET() {
  return new Response(JSON.stringify(appleAppSiteAssociation()), { headers: APP_LINKS_HEADERE });
}
