import "server-only";

// GLS Danmark - STUB. Implementerer interfacet, men alle kald fejler pænt,
// indtil BidHamr har adgang til GLS (testmiljø eller firmaaftale).
//
// TODO(GLS) - det skal der til (verificér mod GLS' egen dokumentation, når
// adgangen er på plads; intet her er testet mod GLS):
//   Adgang/env: GLS_BRUGERNAVN, GLS_ADGANGSKODE, GLS_KUNDENUMMER (Customerid),
//   GLS_KONTAKT_ID (Contactid), GLS_API_URL (test/produktion) og en hemmelighed
//   til webhooks/track & trace, hvis GLS tilbyder push.
//   - opretForsendelse: GLS DK Web API "CreateShipment"
//     (https://api.gls.dk/ws/DK/V1/CreateShipment, JSON). Sender afsender
//     (Addresses.Pickup/AlternativeShipper), modtager (Addresses.Delivery),
//     Parcels[{ Weight, Reference = ForsendelseInput.reference }] og
//     ShopDelivery-service med køberens pakkeshop (ParcelShopId). Svaret har
//     ParcelNumber (= sporingsnummer), Consignment-id og PDF-labelen som
//     base64 -> Label { type: "pdf" }.
//     Pakkestørrelse -> vægt/mål: aftales med GLS (lille/mellem/stor).
//   - opretReturforsendelse: samme kald med ShopReturn-service (eller
//     afsender/modtager byttet om), så køberen kan indlevere uden printer.
//   - annullerForsendelse: GLS' "DeleteShipment"/cancel på consignment-id -
//     kun muligt, før pakken er scannet ind.
//   - hentSporing: GLS Track & Trace (GLS Group dev-portal,
//     https://dev-portal.gls-group.net - "Track And Trace"-API) på
//     ParcelNumber. Oversæt GLS' statuskoder (fx PREADVICE -> oprettet,
//     INWAREHOUSE/første scanning i pakkeshop -> afleveret, INTRANSIT ->
//     i_transit, "Available in ParcelShop" -> klar_til_afhentning,
//     DELIVERED/DELIVEREDPS -> leveret, RETURNED -> returneret, NOTDELIVERED/
//     DAMAGED -> fejl). noegle = GLS' event-id eller `${kode}:${tidspunkt}`.
//   - fortolkWebhook: kun hvis GLS tilbyder push-notifikationer; ellers
//     klarer cron-pollingen sporingen (src/lib/fragt/server.ts).
//   - beregnPris: GLS' prisliste fra aftalen (indtil da fast pris i BidHamr).
//   - ÅBENT (ROADMAP fase 2): kan GLS' målte vægt hentes via API?
import {
  type Fragtfirma,
  FragtFejl,
  FRAGT_IKKE_SAT_OP,
} from "@/lib/fragt/types";

function ikkeSatOp(): never {
  throw new FragtFejl(FRAGT_IKKE_SAT_OP, "GLS er ikke sat op endnu.");
}

export const glsFirma: Fragtfirma = {
  navn: "gls",
  visningsnavn: "GLS",
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
    return { ok: false, status: 501, fejl: "GLS er ikke sat op endnu" };
  },
};
