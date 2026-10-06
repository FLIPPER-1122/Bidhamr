import type { TekstFelt, VaelgFelt } from "@/components/admin/ConfirmDialog";
import { REGEL_VALG } from "@/lib/dsa/regler";

// De felter, staff udfylder ved et indgreb (DSA art. 17): hvilken regel/lov,
// fakta til brugeren og en intern note. Samme felter alle steder, hvor indhold
// fjernes/skjules eller en konto suspenderes. Feltnavnene matcher server
// actions: regel, fakta, aarsag (intern).
export function indgrebFelter(opts: {
  faktaPlaceholder: string;
  standardRegel?: string;
}): { vaelgFelter: VaelgFelt[]; tekstFelter: TekstFelt[] } {
  return {
    vaelgFelter: [
      {
        name: "regel",
        label: "Hvilken regel eller lov bryder det?",
        valg: REGEL_VALG,
        standard: opts.standardRegel,
        hjaelp: "Står i begrundelsen til brugeren.",
      },
    ],
    tekstFelter: [
      {
        name: "fakta",
        label: "Begrundelse til brugeren (vises for brugeren)",
        placeholder: opts.faktaPlaceholder,
        required: true,
        maxLength: 2000,
        hjaelp:
          "Skriv konkret, hvad brugeren har gjort. Brugeren får teksten på mail og kan klage. Skriv aldrig, hvem der har anmeldt.",
      },
      {
        name: "aarsag",
        label: "Intern note (kun staff)",
        placeholder: "Fx henvisning til rapport eller sag",
        required: false,
        maxLength: 2000,
        hjaelp: "Ses kun af medarbejdere.",
      },
    ],
  };
}
