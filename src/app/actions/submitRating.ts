"use server";

// UDFASET. Bedømmelser gives kun, når køberen godkender varen - i samme
// transaktion som godkendelsen (godkendPakke i src/app/actions/trades.ts ->
// handel_godkend_med_bedoemmelse, migration 20261003020000). Brugere kan ikke
// længere indsætte i ratings direkte; RLS og rettigheder afviser det.
//
// Handlingen afviser altid, så en gammel formular aldrig kan give en
// bedømmelse ad en anden vej. Fjernes sammen med RatingForm, når frontend har
// flyttet stjernevalget ind i godkendelsesdialogen.
export async function submitRating(formData: FormData) {
  void formData;
  return {
    error: "Du bedømmer sælgeren, når du godkender varen.",
  };
}
