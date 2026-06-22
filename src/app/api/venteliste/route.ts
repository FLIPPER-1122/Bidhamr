import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const { email } = await req.json();

  if (typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    return NextResponse.json(
      { error: "Indtast en gyldig e-mailadresse." },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("venteliste")
    .insert({ email: email.trim().toLowerCase() });

  // Unik-constraint-fejl (allerede tilmeldt) behandles som succes – ingen
  // grund til at fortælle en besøgende at deres email allerede er på listen.
  if (error && error.code !== "23505") {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
