# Backend-ohje: AI-kuva + "Varmistetaan annos" + OCR-route

Tavoite:
1) Kuva-analyysissa backend saa aina kuvan ja annosvalinnat samassa pyynnossa.
2) OCR-route pysyy OCR-route-na, vaikka Vision fallbackaa imageen.

## 1) Frontend payload (AI-kuva-analyysi)

Frontend lahettaa AI-kuva-analyysissa tyypillisesti:

```json
{
  "imageBase64": "<base64-kuva>",
  "profile": { "...": "..." },
  "mealAdjustments": {
    "portionMultiplier": 1.2,
    "oilAdded": true,
    "servingContext": "restaurant",
    "adjustmentPercent": 10,
    "mealDescription": "Esim. annos nayttaa pienelta"
  },
  "mealDescription": "Esim. annos nayttaa pienelta"
}
```

Huom:
- `profile` on valinnainen.
- `mealDescription` voi olla seka `mealAdjustments.mealDescription` etta top-levelissa.
- kayta ensisijaisesti `mealAdjustments.mealDescription`.

## 2) Backend-validointi (AI-kuva-analyysi)

Tarkista ennen mallikutsua:
1. `imageBase64` pakollinen, ei-tyhja.
2. `mealAdjustments` valinnainen, mutta jos loytyy:
- `portionMultiplier`: `0.5 | 0.7 | 1 | 1.2 | 1.4`, fallback `1`
- `oilAdded`: boolean, fallback `false`
- `servingContext`: `"home" | "restaurant" | "readymeal"`, fallback `"home"`
- `adjustmentPercent`: clamp `-20...20`, fallback `0`
- `mealDescription`: trimattu string, max esim. `180`

Virheellinen payload -> `400`.

## 3) Yksi yhtenainen mallikutsu kuvalle

Ala tee erillisia AI-kutsuja kuvalle ja annoskontekstille.
Tee yksi pyynto, jossa:
1. kuva menee image-inputina
2. annoskonteksti menee tekstina
3. malli ohjeistetaan soveltamaan annosvalinnat lopulliseen arvioon

Esimerkki annoskontekstista:

```text
Kayttajan annosvalinnat:
- portionMultiplier: 1.2
- oilAdded: true
- servingContext: restaurant
- adjustmentPercent: 10
- mealDescription: "annos nayttaa pienelta"

Sovella valinnat:
1) tunnista ruoka ensisijaisesti kuvasta
2) skaalaa annoskoko portionMultiplierilla
3) huomioi oilAdded
4) huomioi servingContext kaloritiheydessa
5) sovella adjustmentPercent lopussa
```

## 4) OCR-route sopimus (erittain tarkea)

Kun kayttaja ottaa kuvan OCR-napin kautta, frontend lahettaa aina:
- `mode: "ocr"`
- `sourceRoute: "ocr_capture"`

Frontend toimii OCR:ssa:
1) yrittaa ensin Vision OCR:aa
2) jos Vision ei toimi tai palauttaa tyhjan tekstin, lahettaa `imageBase64` fallbackina backendille

Esimerkit:

Vision onnistui:

```json
{
  "mode": "ocr",
  "sourceRoute": "ocr_capture",
  "ocrText": "...",
  "ocrProvider": "vision"
}
```

Vision fallback imageen:

```json
{
  "mode": "ocr",
  "sourceRoute": "ocr_capture",
  "imageBase64": "...",
  "ocrFallbackReason": "vision_http_500 | vision_network_error | vision_empty_text | vision_key_missing"
}
```

Backendin pakollinen kaytos:
1. `mode === "ocr"` + `ocrText` -> OCR-tekstiin perustuva analyysi
2. `mode === "ocr"` + ei `ocrText`, mutta on `imageBase64` -> pura OCR-teksti backendissa kuvasta, jatka OCR-tekstianalyysiin
3. ala koskaan vaihda suoraan AI-kuva-analyysipromptiin, kun `mode === "ocr"`

Eli `mode: "ocr"` tarkoittaa aina analyysitapaa:
- OCR-teksti -> ravintoarvio
- ei suora kuva-analyysi

## 5) Suositeltu virhekasittely OCR-modessa

- `400` jos payload rakenteellisesti virheellinen
- `422` jos OCR-data ei riita luotettavaan arvioon

Esimerkki:

```json
{
  "error": "OCR analysis failed",
  "details": "No readable text from image/text payload"
}
```

## 6) Express-runko (tiivis)

```ts
app.post("/analyze", async (req, res) => {
  try {
    const body = req.body ?? {};

    if (body.mode === "ocr") {
      const ocrText =
        typeof body.ocrText === "string" ? body.ocrText.trim() : "";
      const imageBase64 =
        typeof body.imageBase64 === "string" ? body.imageBase64 : "";

      if (!ocrText && !imageBase64) {
        return res.status(400).json({
          error: "Invalid OCR payload",
          details: "Either ocrText or imageBase64 is required for mode=ocr"
        });
      }

      // mode=ocr pysyy aina OCR-polussa:
      // - jos ocrText loytyy -> analysoi se
      // - muuten pura OCR ensin imageBase64:sta, analysoi sitten teksti
      // - ala aja suoraa kuva-analyysipromptia tassa branchissa
    }

    // muu analyysi (esim. suora AI-kuva-analyysi, mode!=ocr)
  } catch (err) {
    return res.status(500).json({ error: "analysis failed" });
  }
});
```

## 7) Lokit ja testit

Loggaa (ilman koko kuvaa):
- `mode`
- `sourceRoute`
- `hasOcrText`
- `hasImageBase64`
- `ocrFallbackReason`
- `mealAdjustments` (sanitoitu)

Testaa vahintaan:
1. OCR Vision onnistuu -> backend pysyy OCR-polussa
2. OCR Vision failaa -> image fallback -> backend pysyy OCR-polussa
3. OCR payload ilman `ocrText` ja `imageBase64` -> `400`
4. OCR-data liian heikko -> `422`
