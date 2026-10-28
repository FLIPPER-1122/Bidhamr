// BidHamr-bot - småting fra review (27.-28. okt. 2026):
//   - App Store-reglen: botten må aldrig sige "køb point på bidhamr.dk" eller
//     nævne pointpriser i appen (systemprompt + filter for samtaler fra appen)
//   - svar_i_gang som dansk fejl
//   - skønnet pr. runde hævet til 60.000 input-tokens og advarslen på
//     /admin/bot, når ét svar kan koste mere end loftet pr. bruger
import { describe, expect, it } from "vitest";
import { APP_ERSTATNING, appSikkerTekst, erForbudtIApp, lavAppFilter, lavOrdFilter } from "@/lib/bot/filter";
import { BOT_SKOEN_INPUT_PR_RUNDE, botMaksPrisUsd, botSvarOverBrugerLoft, loftFejl } from "@/lib/bot/konfig";
import { botSystemprompt } from "@/lib/bot/viden";

describe("App Store-reglen: filteret", () => {
  it("fanger køb af point på hjemmesiden og pointpriser", () => {
    for (const s of [
      "Du kan købe point på bidhamr.dk.",
      "Køb boost-point på hjemmesiden, så er det billigere.",
      "Point kan købes i din browser.",
      "100 point koster 49 kr.",
      "En pointpakke koster 99,- i appen.",
      "Boost koster kr. 29 pr. auktion.",
      "Gå ind på www.bidhamr.dk og køb point.",
      "Det er billigst at købe point på din computer.",
    ]) {
      expect(erForbudtIApp(s), s).toBe(true);
    }
  });

  it("lader almindelige svar være", () => {
    for (const s of [
      "Du kan følge din pakke under Mine handler.",
      "Buddet skal være mindst 10 kr. højere.",
      "Læs mere om BidHamr Beskyttelse på hjemmesiden.",
      "Boost gør din auktion mere synlig.",
      "Du har 120 point.",
    ]) {
      expect(erForbudtIApp(s), s).toBe(false);
    }
  });

  it("erstatter den første forbudte sætning og fjerner de næste", () => {
    const ud = appSikkerTekst(
      "Boost gør din auktion synlig. Du kan købe point på bidhamr.dk. 100 point koster 49 kr. Spørg endelig igen.",
    );
    expect(ud).toBe(`Boost gør din auktion synlig. ${APP_ERSTATNING} Spørg endelig igen.`);
    expect(ud).not.toMatch(/bidhamr\.dk|49 kr/);
  });

  it("deler ikke ved 'kr. på' - hele sætningen fanges", () => {
    const ud = appSikkerTekst("Du kan købe 100 point for 49 kr. på bidhamr.dk lige nu.");
    expect(ud).toBe(APP_ERSTATNING);
  });

  it("virker, når svaret streames i små bidder (også over sætningsgrænser)", () => {
    const tekst = "Hej! Køb point på bidhamr.dk, det er nemt. Ellers kan en medarbejder hjælpe.\nGod dag.";
    for (const stoerrelse of [1, 2, 3, 7, 50]) {
      const f = lavAppFilter();
      let ud = "";
      for (let i = 0; i < tekst.length; i += stoerrelse) ud += f.skub(tekst.slice(i, i + stoerrelse));
      ud += f.toem();
      expect(ud, `bidder på ${stoerrelse}`).toBe(`Hej! ${APP_ERSTATNING} Ellers kan en medarbejder hjælpe.\nGod dag.`);
    }
  });

  it("sammen med ordfilteret (forsikring) - som i motor.ts", () => {
    const ord = lavOrdFilter();
    const app = lavAppFilter();
    let ud = "";
    for (const bid of ["Din forsik", "ring hedder ", "BidHamr Beskyttelse. Point koster ", "10 kr. på web."]) ud += app.skub(ord.skub(bid));
    ud += app.skub(ord.toem()) + app.toem();
    expect(ud).toBe(`Din BidHamr Beskyttelse hedder BidHamr Beskyttelse. ${APP_ERSTATNING}`);
  });

  it("systemprompten forbyder køb af point uden for appen og pointpriser", () => {
    const p = botSystemprompt();
    expect(p).toMatch(/ALDRIG, at man kan eller skal købe point eller boost på bidhamr\.dk/);
    expect(p).toMatch(/nævn aldrig priser på point/);
  });
});

describe("svar_i_gang og skønnet", () => {
  it("svar_i_gang er en 409 med en dansk tekst (samtalen er ikke ødelagt)", () => {
    const f = loftFejl("svar_i_gang");
    expect(f.status).toBe(409);
    expect(f.kode).toBe("svar_i_gang");
    expect(f.fejl).toMatch(/svarer stadig/);
  });

  it("skønnet er 60.000 input-tokens pr. runde", () => {
    expect(BOT_SKOEN_INPUT_PR_RUNDE).toBe(60_000);
    // Haiku: 4 runder * (60.000 * 0,1 + 4.000 * 0,5) / 1e6 = 0,032 USD.
    expect(botMaksPrisUsd("claude-haiku-5-5")).toBeCloseTo(0.032, 6);
    // Opus: 4 * (60.000 * 4 + 4.000 * 20) / 1e6 = 1,28 USD.
    expect(botMaksPrisUsd("claude-opus-5-5")).toBeCloseTo(1.28, 6);
  });

  it("advarslen på /admin/bot: ét svar kan koste mere end loftet pr. bruger", () => {
    expect(botSvarOverBrugerLoft("claude-haiku-5-5", 0.25)).toBe(false);
    expect(botSvarOverBrugerLoft("claude-opus-5-5", 0.25)).toBe(true);
    expect(botSvarOverBrugerLoft("claude-sonnet-5-5", 0.25)).toBe(true);
    expect(botSvarOverBrugerLoft("claude-opus-5-5", 2)).toBe(false);
  });
});
