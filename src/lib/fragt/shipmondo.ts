import "server-only";

// Shipmondo - STUB. Implementerer interfacet, men alle kald fejler pænt,
// indtil Filip har holdt møde med Shipmondo og der er en konto.
//
// TODO(Shipmondo) - det skal der til (ud fra shipmondo.dev; verificér detaljer
// i API-referencen, når der er en konto):
//   Adgang/env: SHIPMONDO_API_BRUGER, SHIPMONDO_API_NOEGLE (Basic auth),
//   SHIPMONDO_API_URL (sandbox: https://sandbox.shipmondo.com/api/public/v3,
//   produktion: https://app.shipmondo.com/api/public/v3) og
//   SHIPMONDO_WEBHOOK_NOEGLE (nøglen, der indtastes ved oprettelse af webhooken).
//   - opretForsendelse: POST /shipments med product_code (fx GLS
//     pakkeshop-levering), sender, receiver, service_point (køberens
//     pakkeshop), parcels [{ weight }] og reference = ForsendelseInput.reference.
//     Svaret har id (-> forsendelsesId), pkg_no (-> sporingsnummer) og
//     labels (base64 PDF) -> Label { type: "pdf" }.
//   - opretReturforsendelse: samme kald med en returprodukt-kode
//     (afsender/modtager byttet om).
//   - annullerForsendelse: Shipmondos annullering af en shipment (se
//     API-referencen) - kun før pakken er afleveret.
//   - hentSporing: GET /shipments/{id} (eller "shipment monitor") og
//     oversæt status til de normaliserede typer.
//   - fortolkWebhook: Shipmondo sender { "data": "<JWT>" } signeret med HS256
//     og webhook-nøglen. Verificér JWT'en (afvis andre algoritmer end HS256),
//     læs headerne SMD-Resource-Type / SMD-Action, og brug resource
//     "shipment monitor" til leveringsstatus. Shipmondo kræver svar 200
//     inden for 3 sekunder - ruten skal derfor kun gemme hændelsen og lade
//     beskeder gå via cron, hvis det bliver for langsomt.
//   - beregnPris: prisen fra Shipmondo-aftalen (indtil da fast pris).
import {
  type Fragtfirma,
  FragtFejl,
  FRAGT_IKKE_SAT_OP,
} from "@/lib/fragt/types";

function ikkeSatOp(): never {
  throw new FragtFejl(FRAGT_IKKE_SAT_OP, "Shipmondo er ikke sat op endnu.");
}

export const shipmondoFirma: Fragtfirma = {
  navn: "shipmondo",
  visningsnavn: "Shipmondo",
  async beregnPris() {
    return ikkeSatOp();
  },
  async opretForsendelse() {
    return ikkeSatOp();
  },
  async opretReturforsendelse() {
    return ikkeSatOp();
  },
  async annullerForsendelse() {
    return ikkeSatOp();
  },
  async hentSporing() {
    return ikkeSatOp();
  },
  async fortolkWebhook() {
    return { ok: false, status: 501, fejl: "Shipmondo er ikke sat op endnu" };
  },
};
