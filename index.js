import cors from "cors";
import dotenv from "dotenv";
import express from "express";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.GEMINI_API_KEY;

/* ================= AI IMAGE HELPERS ================= */

// Vision-mallin analyysi: tunnistaa ruokalajin ja karkeat makrot
async function analyzeImage(imageBase64) {
  const prompt = `Analysoi kuva ruoka-annoksesta ja palauta arvio NORMAALISTA annoskoosta (noin 300–400 g) seuraavassa JSON-muodossa:

{
  "foodName": "Ruoan nimi",
  "calories": 650,
  "protein": 40,
  "carbs": 60,
  "fat": 20,
  "healthClass": "🟢"
}

- foodName: lyhyt, arkikielinen ruokalajin nimi (esim. "Kana-riisiannos")
- calories, protein, carbs, fat: karkea arvio yhdestä normaalista annoksesta
- healthClass: 🟢 (pääosin terveellinen), 🟡 (ok arjessa), 🔴 (raskas/epäterveellinen)

Palauta VAIN JSON, ei mitään muuta tekstiä.`;

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: imageBase64,
                },
              },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Vision-analyysi epäonnistui");
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  let cleanedText = rawText.trim();
  if (cleanedText.startsWith("```json")) {
    cleanedText = cleanedText.replace(/^```json\s*/i, "");
  } else if (cleanedText.startsWith("```")) {
    cleanedText = cleanedText.replace(/^```\s*/, "");
  }
  if (cleanedText.endsWith("```")) {
    cleanedText = cleanedText.replace(/\s*```$/, "");
  }

  const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
  const result = JSON.parse(jsonMatch ? jsonMatch[0] : cleanedText);

  return {
    foodName: result.foodName || "Tuntematon annos",
    calories: Number(result.calories) || 0,
    protein: Number(result.protein) || 0,
    carbs: Number(result.carbs) || 0,
    fat: Number(result.fat) || 0,
    healthClass: result.healthClass || "🟡",
  };
}

// Annoskokosäädöt: annoskoko, lisätty öljy, ravintola
function applyMealAdjustments(baseData, portionSize, addedOil, isRestaurant) {
  const adjusted = { ...baseData };

  // Annoskoko (oletus 1 = normaali annos)
  let factor = 1;
  if (portionSize === 0.5) factor = 0.5;
  if (portionSize === 1.5) factor = 1.5;

  adjusted.calories = Math.round(adjusted.calories * factor);
  adjusted.protein = Math.round(adjusted.protein * factor);
  adjusted.carbs = Math.round(adjusted.carbs * factor);
  adjusted.fat = Math.round(adjusted.fat * factor);

  // Lisätty öljy (~1 rkl)
  if (addedOil) {
    adjusted.calories += 100;
    adjusted.fat += 11;
  }

  // Ravintola-annos: tyypillisesti raskaampi
  if (isRestaurant) {
    adjusted.calories = Math.round(adjusted.calories * 1.2);
    adjusted.protein = Math.round(adjusted.protein * 1.1);
    adjusted.carbs = Math.round(adjusted.carbs * 1.1);
    adjusted.fat = Math.round(adjusted.fat * 1.2);
  }

  return adjusted;
}

// Ylläpitokaloritarve (BMR + aktiivisuus)
function calculateDailyCalories(profile) {
  if (!profile?.weight || !profile?.height) return null;

  const weight = Number(profile.weight);
  const height = Number(profile.height);
  const age = Number(profile.age ?? 30);
  const gender = profile.gender ?? "other";

  let bmr = 10 * weight + 6.25 * height - 5 * age;
  if (gender === "male") bmr += 5;
  else if (gender === "female") bmr -= 161;

  const activityMultipliers = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    veryActive: 1.9,
  };

  const multiplier = activityMultipliers[profile.activity] || 1.5;
  return Math.round(bmr * multiplier);
}

// Profiilitietoinen palaute
function buildProfileAwareText(adjusted, profile) {
  const dailyCalories = calculateDailyCalories(profile);
  if (!dailyCalories) {
    return buildGenericText(adjusted);
  }

  const ratio = adjusted.calories / dailyCalories;
  const percentage = Math.round(ratio * 100);

  let goalLabel = "ylläpito";
  if (profile.goal === "lose") goalLabel = "laihdutus";
  if (profile.goal === "gain") goalLabel = "lihasmassan kasvu";

  let comment;
  if (profile.goal === "lose") {
    if (ratio > 0.5) {
      comment = "Iso pala päivän kaloreista, syö varoen tai jaa pienempiin annoksiin.";
    } else if (ratio >= 0.2 && ratio <= 0.3) {
      comment = "Hyvä osuuspala päivän kaloreista, sopii hyvin pääateriaksi.";
    } else {
      comment = "Kohtuullinen annos laihdutukseen.";
    }
  } else if (profile.goal === "gain") {
    comment = `Hyvä proteiinimäärä (${adjusted.protein} g) lihasmassan kasvuun – huolehdi myös riittävästä kokonaisenergiasta.`;
  } else {
    comment = "Sopii osaksi tasapainoista ylläpitoruokavaliota.";
  }

  return `${adjusted.foodName} (arvio n. ${adjusted.calories} kcal, ${adjusted.protein} g proteiinia, ${adjusted.carbs} g hiilihydraatteja, ${adjusted.fat} g rasvaa).

Tämä on noin ${percentage}% päivän ${goalLabel}tavoitteesi kaloreista.

${comment} ${adjusted.healthClass}`;
}

// Yleinen palaute ilman profiilia
function buildGenericText(adjusted) {
  let healthComment;

  if (adjusted.healthClass === "🟢") {
    healthComment = "Pääosin terveellinen annos – paljon proteiinia ja/tai kuitua.";
  } else if (adjusted.healthClass === "🟡") {
    healthComment = "Kohtuullisen terveellinen arkiruoka – sisältää proteiinia, mutta myös jonkin verran rasvaa tai sokeria.";
  } else {
    healthComment = "Raskas annos – paras satunnaiseen herkutteluun runsaamman energiamäärän vuoksi.";
  }

  return `${adjusted.foodName} (arvio n. ${adjusted.calories} kcal, ${adjusted.protein} g proteiinia, ${adjusted.carbs} g hiilihydraatteja, ${adjusted.fat} g rasvaa).

${adjusted.healthClass} ${healthComment}`;
}

/* ================= ANALYZE ENDPOINT ================= */
app.post("/analyze", async (req, res) => {
  try {
    const { ocrText, profile, imageBase64, portionSize, addedOil, isRestaurant } = req.body;

    // AI-kuva-analyysi (AI-kameranappi)
    if (imageBase64) {
      const baseData = await analyzeImage(imageBase64);
      const adjusted = applyMealAdjustments(baseData, portionSize, addedOil, isRestaurant);
      const hasProfile = profile?.weight && profile?.height;
      const resultText = hasProfile
        ? buildProfileAwareText(adjusted, profile)
        : buildGenericText(adjusted);

      return res.json({
        result: resultText,
        foodName: adjusted.foodName,
        calories: adjusted.calories,
        protein: adjusted.protein,
        carbs: adjusted.carbs,
        fat: adjusted.fat,
        healthClass: adjusted.healthClass,
      });
    }

    /* ================= OCR ANALYSIS ================= */
    if (!ocrText) {
      return res.status(400).json({ error: "OCR-teksti puuttuu" });
    }

    let prompt = `
OLET TAUSTALLA TOIMIVA ANALYYSIMOOTTORI.

⚠️ ERITTÄIN TÄRKEÄT SÄÄNNÖT:
- KÄYTTÄJÄ NÄKEE VAIN JSON-KENTÄN "result"
- ÄLÄ KOSKAAN lisää ohjeita, sääntöjä, JSON-rakennetta tai teknistä tekstiä "result"-kenttään
- "result" on PUHDASTA käyttäjälle tarkoitettua analyysitekstiä
- "products" ja "totalCalories" ovat vain sovelluksen sisäiseen käyttöön
- ÄLÄ mainitse sanoja: JSON, kenttä, ohje, prompt, analyysi, malli

⚠️ KRIITTINEN SÄÄNTÖ KALOREISTA:
- KAIKKI kalorit TÄYTYY AINA olla per 100g tai per 100ml muodossa
- JOS tuote on esim. 500ml ja sisältää 152 kcal yhteensä:
  → Laske: 152 ÷ (500 ÷ 100) = 30.4 kcal per 100ml
  → Palauta calories: 30.4
- JOS ravintotaulukko näyttää jo "per 100g: 520 kcal":
  → Palauta calories: 520 (sellaisenaan)
- ÄLÄ KOSKAAN palauta tuotteen kokonaiskaloreja
- Useamman tuotteen tapauksessa: jokainen calories per 100g/100ml, totalCalories on summa

PALAAUTA VASTAUS TÄSMÄLLEEN SEURAAVASSA RAKENTEESSA (EI MITÄÄN MUUTA):

{
  "result": "<vain käyttäjälle tarkoitettu teksti>",
  "products": [
    { "name": "Tuotteen nimi", "calories": 150 }
  ],
  "totalCalories": 150
}

HUOM: calories ja totalCalories AINA per 100g/100ml!
`;

    if (profile?.weight && profile?.height) {
      prompt += `

KÄYTTÄJÄN TERVEYSPROFIILI:
- Paino: ${profile.weight} kg
- Pituus: ${profile.height} cm
- Tavoite: ${profile.goal}
${profile.targetWeight ? `- Tavoitepaino: ${profile.targetWeight} kg` : ""}
${profile.targetMuscle ? `- Tavoite lihasmassa: ${profile.targetMuscle} kg` : ""}
${profile.timeframe ? `- Aikajänne: ${profile.timeframe} kuukautta` : ""}

TUOTTEEN OCR-TEKSTI:
"""
${ocrText}
"""

KÄYTTÄJÄLLE NÄYTETTÄVÄ TEKSTI ("result"):

👤 SINULLE SOPIVA MÄÄRÄ:
- 🍽 Suositeltu annos: X g / ml
- 🟢 / 🟡 / 🔴
- 📆 Kuinka usein: X kertaa viikossa / päivässä

📌 PERUSTELU:
1–2 lausetta, joissa mainitaan käyttäjän tavoite ja aikaväli.

🎯 JOHTOPÄÄTÖS:
Yksi selkeä ja suora lause.
`;
    } else {
      prompt += `

TUOTTEEN OCR-TEKSTI:
"""
${ocrText}
"""

KÄYTTÄJÄLLE NÄYTETTÄVÄ TEKSTI ("result"):

🟰 RAVINTOARVOT YHTEENSÄ  
🔥 Energia: X kcal  
🥑 Rasva: X g  
🍬 Joista sokerit: X g  
🍗 Proteiini: X g  
🧂 Suola: X g  

📝 ARVIO  
🟢 / 🟡 / 🔴 – lyhyt selitys (1–2 lausetta)

🎯 JOHTOPÄÄTÖS  
Yksi selkeä lause.
`;
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text);
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    let cleanedText = rawText.trim();
    if (cleanedText.startsWith("```json")) {
      cleanedText = cleanedText.replace(/^```json\s*/i, "");
    } else if (cleanedText.startsWith("```")) {
      cleanedText = cleanedText.replace(/^```\s*/, "");
    }
    if (cleanedText.endsWith("```")) {
      cleanedText = cleanedText.replace(/\s*```$/, "");
    }

    const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
    const textToParse = jsonMatch ? jsonMatch[0] : cleanedText;

    let payload;
    try {
      payload = JSON.parse(textToParse);
    } catch {
      payload = null;
    }

    if (payload && typeof payload === "object") {
      const products = Array.isArray(payload.products) ? payload.products : [];

      const totalCalories = Number.isFinite(payload.totalCalories)
        ? payload.totalCalories
        : products.reduce((sum, p) => sum + (Number(p?.calories) || 0), 0);

      let suggestedName = "";
      if (products.length === 1) {
        suggestedName = products[0].name || "";
      } else if (products.length > 1) {
        suggestedName = products.map((p) => p.name).filter(Boolean).join(", ");
      }

      return res.json({
        result:
          typeof payload.result === "string"
            ? payload.result.trim()
            : "Analyysi epäonnistui",
        products,
        totalCalories,
        suggestedName,
      });
    }

    res.json({
      result: "❌ Analyysi epäonnistui. Yritä uudelleen tai skannaa selkeämpi kuva.",
      products: [],
      totalCalories: 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Jokin meni pieleen" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend käynnissä portissa ${PORT}`);
});