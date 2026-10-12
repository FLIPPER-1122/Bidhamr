import AdminFaner from "./AdminFaner";
import { getStaffRole, harMindstRolle } from "@/lib/adminAuth";
import { hentStaffTal } from "@/lib/admin/taellere";

// Faner under "Brugere": søg, mistænkelig aktivitet og (admin og chef)
// forslag om kontolukning. Siderne tjekker selv adgangen.
export default async function BrugereFaner({ aktiv }: { aktiv: "soeg" | "mistaenkelig" | "kontolukninger" }) {
  const rolle = await getStaffRole();
  const admin = !!rolle && harMindstRolle(rolle, "admin");
  const tal = admin ? await hentStaffTal() : null;
  return (
    <AdminFaner
      label="Brugere"
      aktiv={aktiv}
      faner={[
        { id: "soeg", label: "Søg bruger", href: "/admin/brugere" },
        { id: "mistaenkelig", label: "Mistænkelig aktivitet", href: "/admin/brugere/mistaenkelig" },
        ...(admin
          ? [{ id: "kontolukninger", label: "Kontolukninger", href: "/admin/kontolukninger", antal: tal?.kontolukninger, tone: "gul" as const }]
          : []),
      ]}
    />
  );
}
