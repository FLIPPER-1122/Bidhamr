// Universal links (iOS) og App Links (Android): links til bidhamr.dk åbner
// appen i stedet for hjemmesiden, når den er installeret. Kun auktioner
// (/auktion/<id>, også med ?ven=KODE) og forsiden med ?ven=KODE (Henvis en
// ven) - aldrig /admin, /konto, betaling, /auth osv.
//
// Filerne serveres fra src/app/.well-known/* og er offentlige i gaten
// (OFFENTLIGE_RUTER i src/lib/supabase/middleware.ts), også før lancering.

// Team-id (eas.json, appleTeamId) + bundle-id (app.json).
export const IOS_APP_ID = "ZSNR827X8C.dk.bidhamr.app";
export const ANDROID_PAKKE = "dk.bidhamr.app";

// apple-app-site-association (iOS 13+, "components"). Reglerne læses oppefra,
// og den første, der passer, vinder - derfor står undtagelserne først.
// "*" matcher også "/", så "/auktion/*/*" fanger /auktion/<id>/rediger og
// delebilledet. "?*" i query betyder "mindst ét tegn".
export function appleAppSiteAssociation() {
  return {
    applinks: {
      details: [
        {
          appIDs: [IOS_APP_ID],
          components: [
            { "/": "/auktion/*/*", exclude: true, comment: "Ikke rediger, delebillede osv." },
            { "/": "/auktion/*", comment: "En auktion, også med ?ven=KODE" },
            { "/": "/", "?": { ven: "?*" }, comment: "Forsiden med henvisningskode" },
          ],
        },
      ],
    },
  };
}

// SHA-256-fingeraftryk af appens signeringsnøgle, kommasepareret i
// ANDROID_SHA256_FINGERPRINTS (eas credentials -> Android -> "SHA256
// Fingerprint"). Kun gyldige aftryk (32 hex-par adskilt af ":") tages med.
const AFTRYK = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function androidFingeraftryk(raa: string | undefined): string[] {
  if (!raa) return [];
  const ud = raa
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => AFTRYK.test(s));
  return [...new Set(ud)];
}

// assetlinks.json. Uden fingeraftryk: en tom liste (ingen app er knyttet til
// domænet, links åbner hjemmesiden som før).
export function assetLinks(raa: string | undefined) {
  const aftryk = androidFingeraftryk(raa);
  if (aftryk.length === 0) return [];
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: ANDROID_PAKKE,
        sha256_cert_fingerprints: aftryk,
      },
    },
  ];
}

export const APP_LINKS_HEADERE = {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=3600",
};
