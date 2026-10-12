"use server";

// "Send påmindelse" fra Handler (handler, der hænger). Skriver til køber
// eller sælger i staff-chatten (aabnChat), men afviser en ny påmindelse til
// samme part om samme handel inden for 24 timer, medmindre staff bekræfter
// "send alligevel" - så en part ikke kan blive spammet ved et uheld.
// "Påmindelse" = enhver staff-besked til parten i en samtale om handlen
// (staff_samtaler.trade_id + staff_beskeder.fra_staff). Ingen ny tabel.
// Påmindelsen lægges ALTID i en samtale for den konkrete handel
// (sag_type 'handel', sag_id = handlen - staff_samtaler_en_aaben_idx giver én
// åben samtale pr. bruger pr. handel), aldrig i brugerens generelle samtale
// eller en samtale om en anden handel. Beskeden nævner altid varen.
// Medarbejder og op (assertRole + aabnChat tjekker selv igen).

import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { aabnChat } from "@/app/actions/staffChat";
import { sidsteStaffBeskedOmHandel } from "@/lib/admin/paamindelse";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPAERRE_MS = 24 * 60 * 60 * 1000;


type PaamindelseSvar =
  | { ok: true; samtaleId: string }
  | { fejl: string; nylig?: { sendtKl: string } };

export async function sendPaamindelse(input: {
  tradeId: string;
  part: "koeber" | "saelger";
  emne: string;
  besked: string;
  alligevel?: boolean;
}): Promise<PaamindelseSvar> {
  try {
    const { admin } = await assertRole("medarbejder");
    if (!UUID.test(input?.tradeId ?? "") || (input.part !== "koeber" && input.part !== "saelger")) {
      return { fejl: "Handlen findes ikke." };
    }
    const { data: h, error } = await admin
      .from("trades")
      .select("id, buyer_id, seller_id, auction_id")
      .eq("id", input.tradeId)
      .maybeSingle<{ id: string; buyer_id: string; seller_id: string; auction_id: string }>();
    if (error) throw new Error(error.message);
    if (!h) return { fejl: "Handlen findes ikke." };
    const brugerId = input.part === "koeber" ? h.buyer_id : h.seller_id;

    if (!input.alligevel) {
      const kort = await sidsteStaffBeskedOmHandel(admin, [{ tradeId: h.id, brugerId }]);
      if (!kort) {
        return {
          fejl: "Kunne ikke tjekke tidligere påmindelser – prøv igen eller vælg Send alligevel",
          // Tom tid = ukendt; dialogen viser "Send alligevel" uden tidspunkt.
          nylig: { sendtKl: "" },
        };
      }
      const sidste = kort.get(`${h.id}:${brugerId}`);
      if (sidste && Date.now() - new Date(sidste).getTime() < SPAERRE_MS) {
        return {
          fejl: "Der er allerede skrevet til parten om denne handel inden for det sidste døgn.",
          nylig: { sendtKl: sidste },
        };
      }
    }

    const { data: auk } = await admin.from("auctions").select("titel").eq("id", h.auction_id).maybeSingle<{ titel: string | null }>();
    const vare = auk?.titel?.trim() || "din handel";
    const kort = h.id.slice(0, 8);
    const emne = `${input.emne.trim()} – ${vare}`.slice(0, 200);
    // TODO indhold-agenten: indledningen.
    const besked = `Det drejer sig om: ${vare} (handel ${kort}).\n\n${input.besked.trim()}`.slice(0, 4000);
    const res = await aabnChat(brugerId, emne, { tradeId: h.id, sagType: "handel", sagId: h.id, besked });
    if ("fejl" in res) return { fejl: res.fejl };
    return { ok: true, samtaleId: res.samtaleId };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Du har ikke adgang til at gøre dette." };
    }
    console.error("sendPaamindelse fejlede:", err);
    return { fejl: "Noget gik galt. Prøv igen, eller kontakt en udvikler." };
  }
}
