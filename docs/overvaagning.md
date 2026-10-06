# Overvågning af bidhamr.dk

Siden holder selv øje med sine fejl og sender en mail, når noget går galt
(se "1. Alarmer fra siden"). Men hvis hele siden eller Vercel er nede, kan den
ikke selv sige det. Derfor skal der også være en ekstern tjeneste, der kalder
siden udefra (punkt 2), og Vercels og Supabases egne mails (punkt 3 og 4).

Tager ca. 15 minutter i alt.

---

## 1. Alarmer fra siden (DRIFT_ALARM_MAIL)

Hvert 5. minut tjekker siden fejlloggen (`/admin/drift`) og sender én samlet
mail, hvis der er:

- en ny slags fejl,
- over 20 fejl på 15 minutter,
- fejl i cron (betalings-cron fejler, hænger eller er holdt op, et pg_cron-job
  fejler, eller kaldet til cron-ruten fejler),
- webhook-fejl (Stripe).

Højst én mail pr. slags pr. 30 minutter. Mailen indeholder ingen persondata,
kun fejltekst, sti og et link til `/admin/drift`.

**Det skal du gøre:**

1. Kør migrationen `supabase/migrations/20261008010000_drift_alarmer.sql` på
   produktionsdatabasen (den opretter også pg_cron-jobbet `drift-alarm`).
2. Vercel → projektet → Settings → Environment Variables → tilføj
   `DRIFT_ALARM_MAIL` = din e-mail (Production). Flere adresser kan
   kommasepareres. Redeploy bagefter.
3. Intet nyt i Supabase Vault: jobbet bruger `cron_url` og `cron_secret`, som
   allerede står der (stien `/api/cron/afslut-auktioner` skiftes automatisk ud
   med `/api/cron/drift-alarm`). Vil du pege et andet sted hen, kan du lægge en
   `drift_alarm_url` i Vault.
4. Tjek på `/admin/drift` under "Alarmer", at der står "Modtager: Sat", og at
   "Sidste tjek" er under 5 minutter gammelt.

Er `DRIFT_ALARM_MAIL` ikke sat, sendes intet; det står så på `/admin/drift`
og i Vercels log.

---

## 2. Ekstern overvågning: Better Stack (gratis)

Vi bruger **Better Stack Uptime** (betterstack.com, firma i Prag, EU). Gratis
plan: 10 monitorer og alarmer på e-mail og Slack. SMS og opkald kræver betalt
plan, men Better Stacks app kan give push-besked på telefonen.

UptimeRobot er fravalgt: deres gratis plan må siden oktober 2024 ikke bruges
til kommercielle sider.

Better Stack kalder den gratis plan "personal projects" – tjek vilkårene, når
du opretter kontoen. Kræver de betaling for erhverv, er det billigste betalte
abonnement nok.

**Opsætning:**

1. Opret en konto på https://betterstack.com/uptime (vælg region Europe, hvis
   du bliver spurgt).
2. **Create monitor**:
   - Type: *URL becomes unavailable* (eller "Alert us when URL becomes
     unavailable")
   - URL: `https://bidhamr.dk/api/helbred`
   - Check frequency: **5 minutes** (3 min er også fint)
   - Request timeout: 15 sekunder
   - Hvis der er felt for forventet svar: statuskode 200 eller nøgleordet
     `"ok":true`
3. **On-call / notifications**: slå e-mail til (din adresse). Installér
   Better Stack-appen på telefonen og slå push til, hvis du vil have besked
   uden for mailen.
4. Opret gerne en monitor mere på `https://bidhamr.dk` (forsiden), så du også
   får besked, hvis selve siden fejler, mens databasen er ok.
5. Test: sæt URL'en midlertidigt til `https://bidhamr.dk/api/findes-ikke` →
   du skal få en mail inden for få minutter. Sæt den tilbage bagefter.

**Hvad `/api/helbred` svarer:**

| Svar | Betyder |
|---|---|
| `200 {"ok":true}` | Siden og databasen svarer |
| `503 {"ok":false}` | Siden kører, men databasen svarer ikke inden for 3 sekunder |
| `429` | For mange kald fra samme IP (over 30 pr. minut) |
| Ingen svar / 5xx | Siden eller Vercel er nede |

Svaret indeholder aldrig detaljer eller hemmeligheder.

---

## 3. Vercel: fejl ved deploy

1. Vercel → dit avatar → **Account Settings → Notifications** (eller Team
   Settings → Notifications).
2. Slå **e-mail** til for:
   - *Deployment Failed* (produktion)
   - *Usage / Spend alerts* og *Domain / certificate*-advarsler, hvis de findes
3. Gerne også Vercel-appen eller Slack-integrationen, hvis du bruger dem.

---

## 4. Supabase: database-problemer

1. Supabase → **Organization settings → Team**: tjek at din e-mail er Owner –
   Supabase sender mails om nedetid, pause, fuld disk og sikkerhed til ejerne.
2. Projektet **Hamr** → **Settings → Billing/Usage**: slå advarsel om forbrug
   til (fx når databasen nærmer sig grænsen).
3. Abonnér på https://status.supabase.com (knappen "Subscribe to updates") –
   vælg region **eu-west-1** – så du får mail, når Supabase selv har problemer.
4. Gør det samme på https://www.vercel-status.com og
   https://status.stripe.com, hvis du vil.

---

## Når der kommer en alarm

1. Åbn `https://bidhamr.dk/admin/drift` – her ses fejl, cron-kørsler,
   pg_cron-jobs og pg_net-svar.
2. Er siden helt nede: tjek Vercel → Deployments (fejlet deploy? rul tilbage
   med "Promote to Production" på den forrige) og status-siderne ovenfor.
