# Frontend guide: kuva-analyysi ja OCR (Expo)

Tama ohje kertoo milloin tarvitset `EXPO_PUBLIC_GOOGLE_VISION_API_KEY`-avaimen ja miten frontend kytketaan backendin `/analyze` endpointtiin.

## 1) Kaksi toimivaa polkua

### Polku A (suositus): laheta kuva backendiin

Frontend lahettaa vain `imageBase64` ja backend tekee kuvan analyysin.

```json
{
  "imageBase64": "<base64>",
  "mealAdjustments": {
    "portionMultiplier": 1,
    "oilAdded": false,
    "servingContext": "home",
    "adjustmentPercent": 0
  }
}
```

Tassa polussa `EXPO_PUBLIC_GOOGLE_VISION_API_KEY` ei ole pakollinen.

### Polku B: tee OCR frontendissa Google Visionilla

Frontend lukee tekstin Vision APIlla ja lahettaa backendille `ocrText`.

```json
{
  "ocrText": "Energia 250 kcal / 100 g, Rasva 10 g, ...",
  "profile": {
    "weight": 80,
    "height": 180,
    "goal": "lose"
  }
}
```

Tassa polussa `EXPO_PUBLIC_GOOGLE_VISION_API_KEY` on pakollinen.

## 2) Expo env-asetus (Vision OCR)

Luo tai paivita frontend-projektin `.env`:

```env
EXPO_PUBLIC_GOOGLE_VISION_API_KEY=your_real_vision_key
```

Tarkista:
- nimi on tasan `EXPO_PUBLIC_GOOGLE_VISION_API_KEY`
- ei lainausmerkkeja arvon ymparilla
- avain on oikeasti Vision APIlle sallittu

Muista kaynnistaa Metro uudelleen env-muutoksen jalkeen:

```bash
npx expo start -c
```

## 3) Frontend-esimerkki (Expo): kamera -> OCR -> backend

```ts
import * as ImagePicker from "expo-image-picker";

const VISION_KEY = process.env.EXPO_PUBLIC_GOOGLE_VISION_API_KEY;

async function runVisionOcr(imageBase64: string) {
  if (!VISION_KEY) {
    throw new Error("EXPO_PUBLIC_GOOGLE_VISION_API_KEY puuttuu");
  }

  const response = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${VISION_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: imageBase64 },
            features: [{ type: "TEXT_DETECTION" }],
          },
        ],
      }),
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Vision OCR failed (${response.status})`);
  }

  return (
    data?.responses?.[0]?.fullTextAnnotation?.text ||
    data?.responses?.[0]?.textAnnotations?.[0]?.description ||
    ""
  ).trim();
}

export async function analyzeMealPhoto(apiBaseUrl: string) {
  const pick = await ImagePicker.launchCameraAsync({
    allowsEditing: true,
    quality: 0.6,
    base64: true,
  });

  if (pick.canceled) return { canceled: true };

  const imageBase64 = pick.assets?.[0]?.base64?.trim() || "";
  if (!imageBase64) throw new Error("Kuva puuttuu tai base64 muodostus epaonnistui.");

  let ocrText = "";
  try {
    ocrText = await runVisionOcr(imageBase64);
  } catch {
    // Fallback: jatketaan ilman frontend OCR:aa.
  }

  const payload = ocrText
    ? { ocrText }
    : {
        imageBase64,
        mealAdjustments: {
          portionMultiplier: 1,
          oilAdded: false,
          servingContext: "home",
          adjustmentPercent: 0,
        },
      };

  const response = await fetch(`${apiBaseUrl}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || data?.details || `Analyze failed (${response.status})`);
  }

  return data;
}
```

## 4) Miten tunnistat kummassa polussa olet

- Jos virhe on `EXPO_PUBLIC_GOOGLE_VISION_API_KEY puuttuu`, frontend yrittää Polkua B.
- Jos lahetat vain `imageBase64`, kaytossa on Polku A.
- Jos lahetat `ocrText`, backend kasittelee OCR-tekstia suoraan.

## 5) Nopea debug-checklist

1. Tulosta ennen lahetysta `Boolean(process.env.EXPO_PUBLIC_GOOGLE_VISION_API_KEY)`.
2. Tulosta `imageBase64.length` (ei itse base64-dataa).
3. Tulosta Vision-vastauksen virheviesti (`error.message`) jos OCR kaatuu.
4. Tulosta backendin `error` ja `details` jos `/analyze` palauttaa virheen.
5. Testaa ensin Polku A (vain `imageBase64`), sitten Polku B (`ocrText`).

## 6) Turvallisuus tuotantoon

- `EXPO_PUBLIC_*` muuttujat ovat asiakaspuolella luettavissa.
- Rajaa Vision-avain Google Cloudissa mahdollisimman tiukasti.
- Jos haluat pitaa avaimen kokonaan piilossa, tee OCR backendissa etka frontendissa.
