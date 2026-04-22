# Backend-ohje: "Arvio AI:n avulla" -nappi

Tama ohje on tehty nimenomaan frontendin manuaalisen lisayksen napille:
`Kalenteri -> Lisaa manuaalisesti -> Arvio AI:n avulla`.

## 1) Mita frontend lahettaa nyt

Frontend tekee tekstimoodi-pyynnon aina niin, etta backend arvioi ensin
**normiannoksen (1.0x)** ja frontend skaalaa lopuksi kayttajan valitsemalla
kertoimella.

```json
{
  "mode": "text_estimate",
  "ocrText": "Tuote: hampurilainen\nValittu annoskerroin: 1.4x\nArvioi ensin normiannoksen (1.0x) kalorit.\nLisatiedot: ...",
  "mealAdjustments": {
    "portionMultiplier": 1,
    "oilAdded": false,
    "servingContext": "home",
    "adjustmentPercent": 0
  },
  "mealDescription": "normiannos 1.0x. ...",
  "instructions": "...",
  "data": {
    "name": "hampurilainen",
    "portionMultiplier": 1,
    "targetPortionMultiplier": 1.4,
    "details": "..."
  }
}
```

Jos tama epaonnistuu, frontend tekee fallback-pyynnon:
- sama tekstisisalto
- plus `imageBase64` data-url 1x1 PNG placeholder.

## 2) Backend-vaatimus text_estimate-moodille

Kun `mode === "text_estimate"`:
- ala vaadi oikeaa kuvaa
- hyvaksy pyynto, jos `ocrText` on ei-tyhja
- palauta **normiannoksen (1.0x)** kalorit `totalCalories`-kentassa
- ala skaalaa backendissa `targetPortionMultiplier`-arvolla
- frontend hoitaa lopullisen annoskoon skaalauksen

Hyvaksytyt kertoimet:
- `0.5 | 0.7 | 1 | 1.2 | 1.4`
- fallback: `1`

Jos input puuttuu:

```json
{
  "error": "Invalid text estimate payload",
  "details": "ocrText is required for mode=text_estimate"
}
```

Status `400`.

## 3) Vastausmuoto jonka nappi osaa lukea

Palauta ainakin yksi positiivinen kaloritieto:
- `totalCalories` (ensisijainen), tai
- `products[0].calories`, tai
- `result` jossa esiintyy `NNN kcal`

Suositeltu onnistunut vastaus:

```json
{
  "name": "Hampurilainen",
  "suggestedName": "Hampurilainen",
  "totalCalories": 780,
  "products": [
    { "name": "Hampurilainen", "calories": 780 }
  ],
  "result": "Arvioitu energiasisalto: 780 kcal",
  "confidence": "medium"
}
```

Tarkeaa:
- ala palauta `totalCalories: 0` onnistuneena arviona
- jos et saa luotettavaa arviota, palauta virhe (`422`)

Esim:

```json
{
  "error": "Unable to estimate calories reliably",
  "details": "Not enough detail for a reliable calorie estimate"
}
```

## 4) Prompt-suositus mallille

```text
Arvioi annoksen kalorit tekstin perusteella.
Palauta normiannoksen (1.0x) kalorit.
Huomioi kayttajan lisatiedot, mutta ala skaalaa targetPortionMultiplierilla.
Palauta vain JSON:
{
  "name": string,
  "totalCalories": number,
  "confidence": "low" | "medium" | "high",
  "reasoning": string
}
Saannot:
- totalCalories on positiivinen kokonaisluku (>0)
- jos arvio on liian epavarma, palauta low-confidence ja backend palauttaa 422
```

## 5) Express-runko (suositus)

```ts
app.post("/analyze", async (req, res) => {
  try {
    const body = req.body ?? {};

    if (body.mode === "text_estimate") {
      const ocrText = typeof body.ocrText === "string" ? body.ocrText.trim() : "";
      if (!ocrText) {
        return res.status(400).json({
          error: "Invalid text estimate payload",
          details: "ocrText is required for mode=text_estimate",
        });
      }

      const allowed = new Set([0.5, 0.7, 1, 1.2, 1.4]);
      const targetPmRaw = Number(body?.data?.targetPortionMultiplier ?? 1);
      const targetPortionMultiplier = allowed.has(targetPmRaw) ? targetPmRaw : 1;

      // rakenna prompt: ocrText + lisatiedot
      // pyyda mallilta normiannoksen (1.0x) totalCalories
      // kutsu Gemini
      // parse totalCalories
      // jos totalCalories <= 0 -> return 422
      // backend EI skaalaa targetPortionMultiplierilla
      // frontend skaalaa lopputuloksen itse
    }

    // muu /analyze flow (kuva/OCR)
  } catch (error) {
    return res.status(500).json({
      error: "Analyze failed",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});
```

## 6) Debug-lokit joita kannattaa lisata

Loggaa:
- request-id
- mode
- hasOcrText
- portionMultiplier
- status
- error/details

Tama nopeuttaa suoraan taman napin virheiden diagnostiikkaa.

