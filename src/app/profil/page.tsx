import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LogoutButton from "@/components/LogoutButton";

export default async function ProfilPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("users")
    .select("navn, email, telefon, rating")
    .eq("id", authData.user.id)
    .single();

  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold">Min profil</h1>

        <div className="mt-6 space-y-3 text-sm">
          <p>
            <span className="font-medium">Navn:</span> {profile?.navn}
          </p>
          <p>
            <span className="font-medium">Email:</span> {profile?.email}
          </p>
          <p>
            <span className="font-medium">Telefon:</span>{" "}
            {profile?.telefon || "—"}
          </p>
          <p>
            <span className="font-medium">Rating:</span>{" "}
            {profile?.rating ?? 0} ⭐
          </p>
        </div>

        <div className="mt-8">
          <LogoutButton />
        </div>
      </div>
    </main>
  );
}
