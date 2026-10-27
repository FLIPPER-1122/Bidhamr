import { connection } from "next/server";
import { APP_LINKS_HEADERE, assetLinks } from "@/lib/appLinks";

// App Links (Android). Fingeraftrykket læses ved hver forespørgsel fra
// ANDROID_SHA256_FINGERPRINTS, så det virker uden nyt build - se src/lib/appLinks.ts.
export async function GET() {
  await connection();
  return new Response(JSON.stringify(assetLinks(process.env.ANDROID_SHA256_FINGERPRINTS)), {
    headers: APP_LINKS_HEADERE,
  });
}
