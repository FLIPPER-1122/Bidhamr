import "server-only";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";

// Lille Postgres-baseret rate limiter (tabel rate_limits + funktionen
// rate_limit_tjek, kun service_role). Ingen betalt tjeneste.
//
// Fast tidsvindue: hver noegle maa bruges hoejst `maks` gange pr. `vindueSek`.
// Fejler databasen, slippes forespoergslen igennem (fail open), saa en fejl
// her ikke laaser alle ude - Supabase Auth har desuden sine egne graenser.

export const FOR_MANGE_FORSOEG =
  "Du har prøvet for mange gange. Vent lidt, og prøv så igen.";

export type Graense = { maks: number; vindueSek: number };

export const GRAENSER = {
  // Login: hvert forsøg tælles op FØR adgangskoden tjekkes (atomisk i
  // rate_limit_tjek), så loftet også holder ved mange samtidige forsøg.
  // IP-loftet er højt, fordi mange deler IP (CGNAT, arbejdspladser).
  login_ip: { maks: 50, vindueSek: 15 * 60 },
  // Noeglen er e-mail + IP, saa en fremmed ikke kan laase en bruger ude ved
  // at hamre loes paa hans e-mail fra sin egen IP. Nulstilles ved et
  // gennemfoert login.
  login_email_ip: { maks: 8, vindueSek: 15 * 60 },
  opret_ip: { maks: 5, vindueSek: 60 * 60 },
  nulstil_ip: { maks: 5, vindueSek: 60 * 60 },
  nulstil_email: { maks: 3, vindueSek: 60 * 60 },
  gensend_ip: { maks: 5, vindueSek: 60 * 60 },
  // Bekræftelsesmail ved oprettelse/gensend pr. e-mail. Supabase har
  // desuden sin egen ventetid mellem to mails.
  gensend_email: { maks: 4, vindueSek: 60 * 60 },
  // Koden fra bekræftelsesmailen (/tjek-indbakke). Alle forsøg tælles;
  // e-mail+IP nulstilles ved et gennemført forsøg, så det reelt er 5
  // forkerte pr. e-mail+IP pr. 15 min.
  signup_kode_email_ip: { maks: 5, vindueSek: 15 * 60 },
  signup_kode_ip: { maks: 30, vindueSek: 15 * 60 },
  // Pr. e-mail alene (uden IP), så mange IP'er ikke kan gætte løs på samme
  // e-mails kode. Nulstilles ikke ved succes.
  signup_kode_email: { maks: 15, vindueSek: 60 * 60 },
  // Tjek af nuværende adgangskode (skift adgangskode, slet konto) og
  // ny adgangskode efter nulstilling.
  adgangskode_bruger: { maks: 6, vindueSek: 15 * 60 },
  konto_slet_bruger: { maks: 5, vindueSek: 60 * 60 },
  // POST /api/konto/slet (appen) pr. IP, før tokenet er valideret.
  konto_slet_ip: { maks: 20, vindueSek: 60 * 60 },
  // "Nyt login"-mails pr. bruger (registrerLogin).
  nyt_login_mail: { maks: 5, vindueSek: 60 * 60 },
  // Enheder: fjern enhed / log ud andre steder.
  enheder_bruger: { maks: 30, vindueSek: 15 * 60 },
  venteliste_ip: { maks: 5, vindueSek: 60 * 60 },
  bud_bruger: { maks: 20, vindueSek: 60 },
  bud_ip: { maks: 40, vindueSek: 60 },
  // Spørg sælger. Databasen har sine egne grænser pr. bruger
  // (stil_spoergsmaal), som også gælder appen; dette er et ekstra IP-loft.
  spoergsmaal_ip: { maks: 30, vindueSek: 60 * 60 },
  // Fejlrapporter fra browserens error boundaries (/admin/drift). Derudover
  // et globalt loft på 30 nye pr. minut i drift_fejl_log.
  drift_fejl_ip: { maks: 10, vindueSek: 60 },
  // Kontaktformularen (/kontakt). Derudover honeypot og et globalt loft.
  kontakt_ip: { maks: 5, vindueSek: 60 * 60 },
  kontakt_bruger: { maks: 5, vindueSek: 60 * 60 },
  kontakt_email: { maks: 5, vindueSek: 60 * 60 },
  kontakt_alle: { maks: 300, vindueSek: 60 * 60 },
  // Søgning/"Vis flere" på /auktioner (offentlig server action). Klienten
  // venter 300 ms mellem tastetryk, så en rigtig bruger når sjældent 60 pr.
  // minut. IP-loftet er højere, fordi mange mobilbrugere deler IP (CGNAT).
  soeg_bruger: { maks: 60, vindueSek: 60 },
  soeg_ip: { maks: 120, vindueSek: 60 },
  // Anmeld ulovligt indhold (DSA, også uden login - hjemmesiden og appens
  // POST /api/dsa/anmeld). Honeypot og tidsfælde i formularen; databasen har
  // desuden 20 pr. døgn pr. anmelder og sine egne fælles lofter. IP-loftet
  // tjekkes først (før indholdet slås op). Anmeldelser om misbrug af børn
  // tæller ikke med i de fælles lofter (men har stadig IP-loftet).
  dsa_ip: { maks: 10, vindueSek: 60 * 60 },
  dsa_ip_indlogget: { maks: 30, vindueSek: 60 * 60 },
  dsa_email: { maks: 10, vindueSek: 60 * 60 },
  dsa_bruger: { maks: 20, vindueSek: 60 * 60 },
  dsa_alle_anonym: { maks: 300, vindueSek: 60 * 60 },
  dsa_alle_indlogget: { maks: 500, vindueSek: 60 * 60 },
  // Kvitteringsmails for anmeldelser: højst 3 pr. modtager pr. døgn og højst
  // 100 i alt pr. time til anmeldere uden login (e-mailen er ikke bekræftet,
  // så formularen må ikke kunne bruges til at sende mails til fremmede).
  dsa_kvittering_email: { maks: 3, vindueSek: 24 * 60 * 60 },
  dsa_kvittering_anonym: { maks: 100, vindueSek: 60 * 60 },
  // Erhvervsformularen (/erhverv). Derudover honeypot, tidsfælde og et
  // globalt loft. Pr. CVR, så samme firma ikke kan fylde admin op.
  erhverv_ip: { maks: 5, vindueSek: 60 * 60 },
  erhverv_email: { maks: 3, vindueSek: 60 * 60 },
  erhverv_cvr: { maks: 3, vindueSek: 24 * 60 * 60 },
  erhverv_bruger: { maks: 5, vindueSek: 60 * 60 },
  erhverv_alle: { maks: 300, vindueSek: 60 * 60 },
  // Admin → Erhverv: oprettelse af firmakonti/velkomstmails og CVR-opslag
  // pr. medarbejder.
  erhverv_opret_staff: { maks: 30, vindueSek: 60 * 60 },
  erhverv_velkomst_firma: { maks: 5, vindueSek: 24 * 60 * 60 },
  // Firma oversigt -> Abonnement: "Betal for din pakke" / "Skift
  // betalingskort" (hvert tryk laver et kald til Stripe).
  firma_stripe_link: { maks: 20, vindueSek: 60 * 60 },
  // Appens pakkeskift (POST /api/firma/skift-pakke) pr. IP; pr. bruger
  // begrænser databasen selv (firma_skift_pakke_server).
  firma_skift_pakke_ip: { maks: 30, vindueSek: 60 * 60 },
  // POST /api/betaling/kort (appens automatisk betaling / fjern kort) pr. IP,
  // før tokenet er valideret. Rummelig, fordi mange mobilbrugere deler IP
  // (CGNAT); den egentlige grænse er pr. bruger nedenfor.
  betaling_kort_ip: { maks: 150, vindueSek: 60 * 60 },
  // Samme endpoint pr. bruger, efter tokenet er godkendt (hvert kald rammer
  // Stripe).
  betaling_kort_bruger: { maks: 20, vindueSek: 60 * 60 },
  cvr_opslag_staff: { maks: 60, vindueSek: 60 * 60 },
  // Fragt: pakkeshop-søgning (rammer fragtfirmaets API) og handlinger
  // (leveringsvalg, label, annullering) pr. bruger; appens API pr. IP, før
  // tokenet er valideret.
  fragt_pakkeshop_bruger: { maks: 60, vindueSek: 10 * 60 },
  fragt_handling_bruger: { maks: 30, vindueSek: 10 * 60 },
  fragt_app_ip: { maks: 600, vindueSek: 60 * 60 },
  // Klager og visning af en DSA-sag via signeret link.
  dsa_klage_ip: { maks: 10, vindueSek: 60 * 60 },
} satisfies Record<string, Graense>;

export type GraenseNavn = keyof typeof GRAENSER;

// Klientens IP.
// KUN SIKKERT BAG VERCEL: Vercel overskriver x-vercel-forwarded-for og
// x-real-ip med den rigtige klient-IP, saa klienten ikke kan forfalske dem.
// x-forwarded-for bruges kun som sidste udvej (foerste vaerdi), da en klient
// selv kan saette vaerdier i den. Koerer siden et andet sted (egen proxy),
// skal denne funktion gennemgaas igen.
export async function klientIp(): Promise<string> {
  const h = await headers();
  const vercel = h.get("x-vercel-forwarded-for")?.split(",")[0].trim();
  if (vercel) return vercel;
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = h.get("x-forwarded-for")?.split(",")[0].trim();
  return fwd || "ukendt";
}

// Returnerer true, hvis forespoergslen er inden for graensen.
export async function indenForGraense(navn: GraenseNavn, id: string): Promise<boolean> {
  const g = GRAENSER[navn];
  try {
    const { data, error } = await createAdminClient().rpc("rate_limit_tjek", {
      p_noegle: `${navn}:${id.toLowerCase()}`,
      p_maks: g.maks,
      p_vindue_sek: g.vindueSek,
    });
    if (error) {
      console.error(`[rate-limit] fejl – slipper igennem (${navn}):`, error.message);
      return true;
    }
    return data !== false;
  } catch (err) {
    console.error(`[rate-limit] fejl – slipper igennem (${navn}):`, err);
    return true;
  }
}

// Tjekker flere graenser; alle skal vaere overholdt.
export async function tjekGraenser(
  tjek: [GraenseNavn, string][],
): Promise<boolean> {
  const svar = await Promise.all(tjek.map(([n, id]) => indenForGraense(n, id)));
  return svar.every(Boolean);
}

// Nulstiller en grænse (fx login pr. e-mail+IP efter et gennemført login),
// så en bruger, der har tastet forkert et par gange, starter forfra.
// Samme nøgle som indenForGraense. Kaster aldrig.
export async function nulstilGraense(navn: GraenseNavn, id: string): Promise<void> {
  try {
    const { error } = await createAdminClient().rpc("rate_limit_nulstil", {
      p_noegle: `${navn}:${id.toLowerCase()}`,
    });
    if (error) console.error(`[rate-limit] kunne ikke nulstille (${navn}):`, error.message);
  } catch (err) {
    console.error(`[rate-limit] kunne ikke nulstille (${navn}):`, err);
  }
}
