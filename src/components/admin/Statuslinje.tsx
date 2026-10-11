// Udfaset: kvitteringen hedder nu <Kvittering /> og står i admin/layout.tsx,
// så den virker på alle sider. Filen bliver kun stående, så grene, der
// flettes senere og stadig importerer Statuslinje, ikke går i stykker.
// Komponenten tegner intet - ellers ville kvitteringen stå to gange.
export { visKvittering } from "@/components/admin/Kvittering";

export default function Statuslinje() {
  return null;
}
