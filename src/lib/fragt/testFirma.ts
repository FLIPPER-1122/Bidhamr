import "server-only";

// Fiktivt testfragtfirma, så hele fragtflowet kan prøves uden GLS.
//
// - Faste priser: lille 35 kr, mellem 49 kr, stor 69 kr.
// - Sporingsnummer `TEST` + 12 tegn, afledt af BidHamrs forsendelses-id
//   (deterministisk - et genforsøg giver samme nummer).
// - Label: simpel PDF med sporingsnummer og QR-kode (testLabel.ts).
// - Sporing styres af tabellen fragt_test_sporing: /dev/fragt indsætter
//   rækker for at "rykke" pakken frem. hentSporing() læser tabellen.
// - Webhook: JSON signeret med HMAC-SHA256 og FRAGT_TEST_WEBHOOK_SECRET
//   (header x-bidhamr-fragt-signatur: t=<unix-sek>,v1=<hex>). Hændelsens
//   nøgle er rækkens id i fragt_test_sporing, så webhook og sporing giver
//   samme hændelse (idempotent).
//
// Må kun bruges, når testErTilladt() (se index.ts) - aldrig i produktion,
// medmindre FRAGTFIRMA=test er sat eksplicit.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { lavTestLabelPdf } from "@/lib/fragt/testLabel";
import {
  type Fragtfirma,
  type ForsendelseInput,
  type OprettetForsendelse,
  type Pakkestoerrelse,
  type Sporingshaendelse,
  type WebhookHaendelse,
  type WebhookResultat,
  FragtFejl,
  erSporingsType,
} from "@/lib/fragt/types";

export const TEST_PRISER_OERE: Record<Pakkestoerrelse, number> = {
  lille: 3500,
  mellem: 4900,
  stor: 6900,
};

const SIGNATUR_HEADER = "x-bidhamr-fragt-signatur";
const TOLERANCE_SEK = 5 * 60;
const SPORING = /^TEST[0-9A-Z]{12}$/;

export function testSporingsnummer(reference: string): string {
  return "TEST" + createHash("sha256").update(reference).digest("hex").slice(0, 12).toUpperCase();
}

function hemmelighed(): string | null {
  const s = process.env.FRAGT_TEST_WEBHOOK_SECRET;
  return s && s.length >= 16 ? s : null;
}

function hmac(secret: string, t: string, body: string): string {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

// Bruges af /dev/fragt til at sende en signeret testwebhook.
export function signerTestWebhook(body: string): { header: string; vaerdi: string } | null {
  const secret = hemmelighed();
  if (!secret) return null;
  const t = String(Math.floor(Date.now() / 1000));
  return { header: SIGNATUR_HEADER, vaerdi: `t=${t},v1=${hmac(secret, t, body)}` };
}

function signaturGyldig(header: string | null, body: string): boolean {
  const secret = hemmelighed();
  // Fail closed: uden hemmelighed afvises alt.
  if (!secret || !header) return false;
  const dele = Object.fromEntries(
    header.split(",").map((d) => {
      const i = d.indexOf("=");
      return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
    }),
  );
  const t = dele.t;
  const v1 = dele.v1;
  if (!t || !v1 || !/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SEK) return false;
  const forventet = Buffer.from(hmac(secret, t, body), "hex");
  const givet = Buffer.from(v1, "hex");
  return forventet.length === givet.length && timingSafeEqual(forventet, givet);
}

async function opret(input: ForsendelseInput, retur: boolean): Promise<OprettetForsendelse> {
  const sporingsnummer = testSporingsnummer(input.reference);
  const qrKode = `BIDHAMR-TEST:${sporingsnummer}`;
  const pdf = lavTestLabelPdf({
    sporingsnummer,
    qrData: qrKode,
    afsender: input.afsender,
    modtager: input.modtager,
    pakkestoerrelse: input.pakkestoerrelse,
    titel: input.handel.titel,
    retur,
  });

  // "Oprettet"-hændelsen registrerer BidHamr selv (server.ts). Resten af
  // sporingen indsættes i fragt_test_sporing fra /dev/fragt.
  return {
    forsendelsesId: `test_${input.reference}`,
    sporingsnummer,
    label: { type: "pdf", data: pdf },
    qrKode,
    prisOere: TEST_PRISER_OERE[input.pakkestoerrelse],
  };
}

export const testFirma: Fragtfirma = {
  navn: "test",
  visningsnavn: "Testfragt",

  async beregnPris(pakkestoerrelse) {
    return TEST_PRISER_OERE[pakkestoerrelse];
  },

  opretForsendelse: (input) => opret(input, false),
  opretReturforsendelse: (input) => opret(input, true),

  async annullerForsendelse(forsendelsesId) {
    if (!forsendelsesId.startsWith("test_")) {
      throw new FragtFejl("Forsendelsen findes ikke hos testfragt.");
    }
  },

  async hentSporing(sporingsnummer): Promise<Sporingshaendelse[]> {
    if (!SPORING.test(sporingsnummer)) return [];
    const { data, error } = await createAdminClient()
      .from("fragt_test_sporing")
      .select("id, type, tidspunkt, beskrivelse")
      .eq("sporingsnummer", sporingsnummer)
      .order("tidspunkt", { ascending: true })
      .limit(100);
    if (error) throw new Error(`fragt_test_sporing: ${error.message}`);
    return (data ?? [])
      .filter((r) => erSporingsType(r.type))
      .map((r) => ({
        type: r.type,
        tidspunkt: r.tidspunkt as string,
        noegle: `test:${r.id}`,
        beskrivelse: (r.beskrivelse as string | null) ?? null,
        raa: { id: r.id, type: r.type },
      }));
  },

  async fortolkWebhook(request): Promise<WebhookResultat> {
    const body = await request.text();
    if (body.length > 20_000) return { ok: false, status: 413, fejl: "For stor" };
    if (!signaturGyldig(request.headers.get(SIGNATUR_HEADER), body)) {
      return { ok: false, status: 401, fejl: "Ugyldig signatur" };
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { ok: false, status: 400, fejl: "Ugyldig JSON" };
    }
    const liste = Array.isArray((json as { haendelser?: unknown })?.haendelser)
      ? ((json as { haendelser: unknown[] }).haendelser)
      : [json];
    const ud: WebhookHaendelse[] = [];
    for (const h of liste.slice(0, 50)) {
      if (!h || typeof h !== "object") continue;
      const { id, sporingsnummer, type, tidspunkt, beskrivelse } = h as Record<string, unknown>;
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) continue;
      if (typeof sporingsnummer !== "string" || !SPORING.test(sporingsnummer)) continue;
      if (!erSporingsType(type)) continue;
      const tid = typeof tidspunkt === "string" && !Number.isNaN(Date.parse(tidspunkt))
        ? new Date(tidspunkt).toISOString()
        : new Date().toISOString();
      ud.push({
        sporingsnummer,
        type,
        tidspunkt: tid,
        noegle: `test:${id}`,
        beskrivelse: typeof beskrivelse === "string" ? beskrivelse.slice(0, 300) : null,
        raa: { id, type },
      });
    }
    return { ok: true, haendelser: ud };
  },
};
