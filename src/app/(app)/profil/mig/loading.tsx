import { ProfilSkelet } from "@/components/Skeletter";

// /profil/mig sender videre til /profil/<id>. Skelettet vises med det samme
// ved klik i menuen, mens serveren finder brugerens id.
export default function Loading() {
  return <ProfilSkelet />;
}
