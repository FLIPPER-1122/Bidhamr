import type { Instrumentation } from "next";

// Serverfejl (rendering, route handlers, server actions, proxy), som Next selv
// fanger, logges i drift_fejl og vises på /admin/drift. Her har vi den rigtige
// fejlbesked; browseren får kun et digest, som error boundary'en rapporterer
// (samme digest tælles op på samme række).
//
// Kun stien uden query-streng, og teksten renses for persondata og
// hemmeligheder (src/lib/drift.ts). Kaster aldrig.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { logDriftFejl } = await import("@/lib/drift");
    const digest =
      typeof err === "object" && err !== null && "digest" in err
        ? String((err as { digest: unknown }).digest)
        : null;
    await logDriftFejl({
      kilde: "server",
      sti: request.path,
      hvor: `${context.routeType} ${context.routePath}`,
      fejl: err,
      digest,
    });
  } catch (e) {
    console.error("onRequestError: logning fejlede:", e);
  }
};
