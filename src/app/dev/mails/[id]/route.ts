// Viser én mail som rå HTML (?tekst=1 giver tekstudgaven). Kun i dev.
import { mailEksempler } from "../eksempler";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (process.env.NODE_ENV === "production") {
    return new Response("Ikke fundet", { status: 404 });
  }
  const { id } = await ctx.params;
  const eksempel = mailEksempler().find((e) => e.id === id);
  if (!eksempel) return new Response("Ikke fundet", { status: 404 });

  const visTekst = new URL(request.url).searchParams.get("tekst") === "1";
  return new Response(visTekst ? eksempel.mail.text : eksempel.mail.html, {
    headers: {
      "Content-Type": visTekst ? "text/plain; charset=utf-8" : "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
