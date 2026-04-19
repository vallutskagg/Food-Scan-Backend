# Frontend guide: kuva-analyysi + Gemini 2.5

Tama ohje auttaa varmistamaan, etta kuvanotto -> backend `/analyze` toimii luotettavasti, vaikka backendissa on vaihdettu malli Gemini 2.0 -> 2.5.

## 1) Mita backend odottaa frontendilta

Lahjeta `POST /analyze` JSON-rungolla, jossa on ainakin:

```json
{
  "imageBase64": "<base64 ilman tyhjaa>",
  "mealAdjustments": {
    "portionMultiplier": 1,
    "oilAdded": false,
    "servingContext": "home",
    "adjustmentPercent": 0
  },
  "mealDescription": "vapaa kuvaus",
  "profile": {
    "weight": 80,
    "height": 180,
    "goal": "lose"
  }
}
```

Hyvaksytyt kuvat:
- pelkka base64 merkkijono (`imageBase64`)
- tai data-url (`data:image/jpeg;base64,...`)

Backend palauttaa virheen 400 jos `imageBase64` on tyhja.

## 2) Frontendin minimitarkistus ennen lahetysta

Tarkista aina ennen fetchia:
- `imageBase64` on `string`
- `imageBase64.trim().length > 0`
- et laheta pelkkaa `uri` kenttaa
- header on `Content-Type: application/json`

Suositus:
- pakkaa kuvaa jo frontendissa (esim `quality: 0.5-0.7`)
- kokoa rajataan niin, etta request pysyy alle backendin 25MB JSON-rajan

## 3) Expo / React Native esimerkkipolku

```ts
import * as ImagePicker from "expo-image-picker";

export async function analyzeMealPhoto(apiBaseUrl: string) {
  const pick = await ImagePicker.launchCameraAsync({
    allowsEditing: true,
    quality: 0.6,
    base64: true,
  });

  if (pick.canceled) return { canceled: true };

  const asset = pick.assets?.[0];
  const imageBase64 = asset?.base64?.trim() || "";
  if (!imageBase64) {
    throw new Error("Kuva puuttuu tai base64 muodostus epaonnistui.");
  }

  const payload = {
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
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || data?.details || `Analyze failed (${response.status})`);
  }

  return data;
}
```

## 4) Gemini 2.0 -> 2.5 vaihto: mita frontendissa huomioida

Yleensa malli-vaihto ei vaadi frontendilta muutosta, koska frontend keskustelee backendin kanssa, ei suoraan Geminiin.

Mutta kaytannossa tarkista:
- etta UI ei oleta liian tiukkaa tekstiformaattia `result`-kentassa
- etta UI kayttaa ensisijaisesti `products` ja `totalCalories` kenttia
- etta virheviestit naytetaan myos backendin `details`-kentasta

Turvallinen lukutapa responseen:
- `result` (teksti)
- `products` (taulukko, voi olla fallbackilla geneerinen)
- `totalCalories` (numero)
- `suggestedName` (voi puuttua joissain fallbackeissa)

## 5) Nopea debug-checklist (kun analyysi epaonnistuu)

1. Tulosta frontendissa ennen lahetysta: `imageBase64.length`.
2. Tulosta backendin vastausbody aina virheessa.
3. Varmista ettei frontend trimmaa/katkaise base64 stringia vahingossa.
4. Testaa samalla payloadilla Postmanista tai curlilla.
5. Jos saat 500, tarkista backend-loki: `Gemini image analyze API error`.

## 6) Suositus tuotantoon

- Lisaa frontendiin retry (1-2 yritysta) vain 5xx virheille.
- Aseta timeout (esim 20-30s) ja nayta kayttajalle "Yritetaan uudelleen".
- Loggaa analyysivirheesta ainakin:
  - HTTP status
  - backend `error` + `details`
  - imageBase64 pituus (ei itse dataa)
