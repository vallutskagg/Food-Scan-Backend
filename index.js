import cors from "cors";
import dotenv from "dotenv";
import express from "express";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const API_KEY = process.env.GEMINI_API_KEY;

/* ================= AI IMAGE HELPERS ================= */

// Vision-mallin analyysi: tunnistaa ruokalajin ja karkeat makrot
async function analyzeImage(imageBase64) {
  const prompt = `Analysoi KUVA ruoka-annoksesta (AI-kuva-analyysi, ei OCR-tekstiä) ja palauta arvio NORMAALISTA annoskoosta (noin 300–400 g) seuraavassa JSON-muodossa:

{
  "foodName": "Ruoan nimi",
  "calories": 650,
  "protein": 40,
  "carbs": 60,
  "sugar": 0,
  "fat": 20,
  "healthClass": "🟢",
  "source": "image-ai"
}

- foodName: lyhyt, arkikielinen ruokalajin nimi (esim. "Kana-riisiannos")
- calories, protein, carbs, fat: karkea arvio yhdestä normaalista annoksesta
- sugar: arvioitu sokerin määrä grammoina samasta annoksesta (0 jos ei tiedossa)
- healthClass: 🟢 (pääosin terveellinen), 🟡 (ok arjessa), 🔴 (raskas/epäterveellinen)
- source: merkkijono, jonka arvon tulee olla täsmälleen "image-ai" (vain sisäiseen käyttöön)

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
    console.error("Gemini image analyze API error:", response.status, text);
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
    sugar: Number(result.sugar) || 0,
    fat: Number(result.fat) || 0,
    healthClass: result.healthClass || "🟡",
  };
}

// Annoskokosäädöt: frontin mealAdjustments-olio
// mealAdjustments: { portionMultiplier, oilAdded, servingContext, adjustmentPercent }
function applyMealAdjustments(baseData, mealAdjustments = {}) {
  const adjusted = { ...baseData };

  const {
    portionMultiplier = 1,
    oilAdded = false,
    servingContext = "home",
    adjustmentPercent = 0,
  } = mealAdjustments || {};

  // Annoskoko (esim. 0.5, 0.7, 1, 1.2, 1.4)
  const portionFactor = Number(portionMultiplier) || 1;

  adjusted.calories = Math.round(adjusted.calories * portionFactor);
  adjusted.protein = Math.round(adjusted.protein * portionFactor);
  adjusted.carbs = Math.round(adjusted.carbs * portionFactor);
  adjusted.sugar = Math.round((adjusted.sugar || 0) * portionFactor);
  adjusted.fat = Math.round(adjusted.fat * portionFactor);

  // Lisätty öljy (~1 rkl)
  if (oilAdded) {
    adjusted.calories += 100;
    adjusted.fat += 11;
  }

  // Tarjoilukonteksti: valmisruoka ja ravintola-annos hieman raskaampia
  if (servingContext === "readymeal") {
    adjusted.calories = Math.round(adjusted.calories * 1.1);
    adjusted.protein = Math.round(adjusted.protein * 1.1);
    adjusted.carbs = Math.round(adjusted.carbs * 1.1);
    adjusted.sugar = Math.round((adjusted.sugar || 0) * 1.1);
    adjusted.fat = Math.round(adjusted.fat * 1.1);
  } else if (servingContext === "restaurant") {
    adjusted.calories = Math.round(adjusted.calories * 1.2);
    adjusted.protein = Math.round(adjusted.protein * 1.1);
    adjusted.carbs = Math.round(adjusted.carbs * 1.1);
    adjusted.sugar = Math.round((adjusted.sugar || 0) * 1.1);
    adjusted.fat = Math.round(adjusted.fat * 1.2);
  }

  // Manuaalinen %-säätö (-20 … +20)
  const percent = Number(adjustmentPercent) || 0;
  if (percent !== 0) {
    const factor = 1 + percent / 100;
    adjusted.calories = Math.round(adjusted.calories * factor);
    adjusted.protein = Math.round(adjusted.protein * factor);
    adjusted.carbs = Math.round(adjusted.carbs * factor);
    adjusted.sugar = Math.round((adjusted.sugar || 0) * factor);
    adjusted.fat = Math.round(adjusted.fat * factor);
  }

  adjusted.calories = Math.max(0, adjusted.calories || 0);
  adjusted.protein = Math.max(0, adjusted.protein || 0);
  adjusted.carbs = Math.max(0, adjusted.carbs || 0);
  adjusted.fat = Math.max(0, adjusted.fat || 0);
  adjusted.sugar = Math.max(0, Math.min(adjusted.sugar || 0, adjusted.carbs || 0));

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

  let improvementSuggestion = "";
  if (adjusted.healthClass === "🔴") {
    let focus;
    if (adjusted.fat > adjusted.carbs && adjusted.fat > adjusted.protein) {
      focus = "rasvan määrä";
    } else if (adjusted.carbs >= adjusted.fat && adjusted.carbs > adjusted.protein) {
      focus = "hiilihydraattien ja sokerin määrä";
    } else {
      focus = "annoksen kokonaisenergiatiheys";
    }

    improvementSuggestion = `

💡 PAREMPI VAIHTOEHTO
Jos haluat pitää kiinni ${goalLabel}tavoitteestasi, kokeile samantyyppistä mutta kevyempää versiota:
- pienempi annoskoko tai puolet annoksesta
- korvaa osa lisukkeista vihanneksilla tai salaatilla
- valitse vähärasvaisempi proteiininlähde tai vähemmän lisättyä kastiketta

Tavoitteena on keventää erityisesti ${focus} ilman, että ruoan tyyli muuttuu täysin.`;
  }

  return `${adjusted.foodName}

🟰 ARVIOITU ANNOS
🔥 Energia: noin ${adjusted.calories} kcal / annos  
🍗 Proteiini: ${adjusted.protein} g  
🍞 Hiilihydraatit: ${adjusted.carbs} g  
🥑 Rasva: ${adjusted.fat} g  

👤 VAIKUTUS PÄIVÄN TAVOITTEESEEN
Tämä annos on noin ${percentage}% päivän ${goalLabel}tavoitteesi kaloreista.

📝 ARVIO
${comment} ${adjusted.healthClass}${improvementSuggestion}

🔍 Perustuu: AI-kuvaan (annoskuvasta arvioidut ravintoarvot).`;
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
  return `${adjusted.foodName}

🟰 ARVIOITU ANNOS
🔥 Energia: noin ${adjusted.calories} kcal / annos  
🍗 Proteiini: ${adjusted.protein} g  
🍞 Hiilihydraatit: ${adjusted.carbs} g  
🥑 Rasva: ${adjusted.fat} g  

📝 ARVIO
${adjusted.healthClass} ${healthComment}

🔍 Perustuu: AI-kuvaan (annoskuvasta arvioidut ravintoarvot).`;
}

/* ================= WEEKLY REPORT HELPERS ================= */
function normalizeNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.replace(",", ".").match(/-?\d+(?:\.\d+)?/);
    if (match) {
      const num = Number(match[0]);
      if (Number.isFinite(num)) return num;
    }
  }
  return fallback;
}

function sanitizeMacros(product = {}, fallbackName = "Tuntematon tuote") {
  const calories = Math.max(0, normalizeNumber(product?.calories));
  const protein = Math.max(0, normalizeNumber(product?.protein));
  const carbs = Math.max(0, normalizeNumber(product?.carbs));
  const fat = Math.max(0, normalizeNumber(product?.fat));
  const sugarRaw = Math.max(0, normalizeNumber(product?.sugar));
  const sugar = Math.min(sugarRaw, carbs);
  const name =
    typeof product?.name === "string" && product.name.trim()
      ? product.name.trim()
      : fallbackName;

  return { ...product, name, calories, protein, carbs, sugar, fat };
}

function buildOcrFallbackResult(products = []) {
  const first = Array.isArray(products) && products.length ? products[0] : null;
  if (!first) return "OCR-analyysi tehtiin, mutta vastaus oli puutteellinen. Kokeile selkeämpää kuvaa.";

  return `🟰 RAVINTOARVOT YHTEENSÄ
🔥 Energia: ${first.calories} kcal
🥑 Rasva: ${first.fat} g
🍬 Joista sokerit: ${first.sugar} g
🍗 Proteiini: ${first.protein} g

📝 ARVIO
Ravintosisältö tunnistettiin OCR-tekstistä, mutta sanallinen arvio jäi vajaaksi.

🎯 JOHTOPÄÄTÖS
Tuote tunnistettiin, ja arvot voi tallentaa.`;
}

function extractOcrResultText(payload, rawText, products) {
  if (payload && typeof payload === "object") {
    const candidateFields = ["result", "summary", "text", "analysis", "message"];
    for (const key of candidateFields) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }

  if (typeof rawText === "string" && rawText.trim()) {
    const cleaned = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    if (cleaned) return cleaned;
  }

  return buildOcrFallbackResult(products);
}

function normalizeGoal(goal) {
  return typeof goal === "string" ? goal.trim().toLowerCase() : "";
}

function isWeightLossGoal(profile = {}) {
  const goal = normalizeGoal(profile?.goal);
  const weightLossGoals = new Set(["lose", "weight_loss", "laihdutus", "fatloss", "cut", "cutting"]);
  if (weightLossGoals.has(goal)) return true;

  // If goal string is unclear, infer from target weight if it is clearly below current weight.
  const weight = normalizeNumber(profile?.weight, Number.NaN);
  const targetWeight = normalizeNumber(profile?.targetWeight, Number.NaN);
  if (Number.isFinite(weight) && Number.isFinite(targetWeight) && targetWeight < weight - 0.2) {
    return true;
  }

  return false;
}

function shouldAddOcrProcessingScale(profile = {}) {
  const hasProfileData = Boolean(profile?.weight && profile?.height);
  // Show OCR processing scale only when health profile is effectively off.
  return !hasProfileData;
}

function normalizeProcessingLevel(value) {
  const parsed = Math.round(normalizeNumber(value, 0));
  return parsed >= 1 && parsed <= 4 ? parsed : null;
}

function processingLabelFromLevel(level) {
  if (level === 1) return "prosessoimaton";
  if (level === 2) return "minimiprosessoitu";
  if (level === 3) return "prosessoitu";
  if (level === 4) return "ultraprosessoitu";
  return "";
}

function normalizeProcessingLabel(label) {
  if (typeof label !== "string") return "";
  const normalized = label.trim().toLowerCase();
  const allowed = new Set(["prosessoimaton", "minimiprosessoitu", "prosessoitu", "ultraprosessoitu"]);
  return allowed.has(normalized) ? normalized : "";
}

function processingLevelFromLabel(label) {
  if (label === "prosessoimaton") return 1;
  if (label === "minimiprosessoitu") return 2;
  if (label === "prosessoitu") return 3;
  if (label === "ultraprosessoitu") return 4;
  return null;
}

function normalizeWeeklyReport(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const suggestions = Array.isArray(safe.suggestions)
    ? safe.suggestions
        .filter((s) => typeof s === "string")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 4)
    : [];

  const level = ["🟢", "🟡", "🔴"].includes(safe.level) ? safe.level : "🟡";
  const score = Math.min(100, Math.max(0, Math.round(normalizeNumber(safe.score, 60))));
  const summary =
    typeof safe.summary === "string" && safe.summary.trim()
      ? safe.summary.trim()
      : "Viikon tiedot on analysoitu. Keskity tasaiseen energiansaantiin ja tavoitteeseen sopivaan proteiinin määrään.";

  const fallbackSuggestions = [
    "Pidä päivittäinen energiansaanti mahdollisimman tasaisena koko viikon ajan.",
    "Säädä proteiinia tavoitteen mukaan ja vältä suuria heilahteluja sokerin saannissa.",
  ];

  return {
    level,
    score,
    summary,
    suggestions: suggestions.length >= 2 ? suggestions : fallbackSuggestions,
  };
}

function buildWeeklyReportFallback(body = {}) {
  const goal = body?.data?.goal;
  const totals = body?.data?.totals || {};
  const products = Array.isArray(body?.data?.products) ? body.data.products : [];
  const topProduct = products
    .slice()
    .sort((a, b) => normalizeNumber(b?.calories) * normalizeNumber(b?.count, 1) - normalizeNumber(a?.calories) * normalizeNumber(a?.count, 1))[0];

  let level = "🟡";
  let score = 65;
  const avgCalories = normalizeNumber(totals.avgCaloriesPerDay);
  const dailyTargetCalories = normalizeNumber(body?.data?.dailyTargetCalories);
  const avgProtein = normalizeNumber(totals.avgProtein);
  const targetProtein = normalizeNumber(body?.data?.dailyMacroTargets?.protein);

  if (goal === "laihdutus" && dailyTargetCalories > 0) {
    if (avgCalories <= dailyTargetCalories && avgProtein >= targetProtein * 0.85) {
      level = "🟢";
      score = 82;
    } else if (avgCalories > dailyTargetCalories * 1.1) {
      level = "🔴";
      score = 42;
    }
  } else if (goal === "lihasmassa") {
    if (avgProtein >= targetProtein * 0.9) {
      level = "🟢";
      score = 80;
    } else if (avgProtein < targetProtein * 0.75) {
      level = "🔴";
      score = 45;
    }
  } else if (goal === "yllapito" && dailyTargetCalories > 0) {
    const diffRatio = Math.abs(avgCalories - dailyTargetCalories) / dailyTargetCalories;
    if (diffRatio <= 0.08) {
      level = "🟢";
      score = 84;
    } else if (diffRatio > 0.18) {
      level = "🔴";
      score = 46;
    }
  }

  const topProductHint = topProduct?.name
    ? `Tarkista tuotteen "${topProduct.name}" viikkokäyttöä ja säädä määrää tavoitteeseesi sopivaksi.`
    : "Säädä eniten käytettyjen tuotteiden määriä tavoitteesi suuntaan.";

  let goalHint = "Pidä energia ja makrot tasaisina viikon eri päivinä.";
  if (goal === "laihdutus") {
    goalHint = "Pidä kalorit hallinnassa ja varmista riittävä proteiini kylläisyyden tueksi.";
  } else if (goal === "lihasmassa") {
    goalHint = "Nosta tarvittaessa energiaa ja varmista riittävä proteiini lihasmassan tueksi.";
  } else if (goal === "yllapito") {
    goalHint = "Pidä kokonaisenergia lähellä tavoitetta ja säilytä makrojen tasapaino.";
  }

  return {
    level,
    score,
    summary: "Viikkoraportti muodostettiin varamenetelmällä. Kokonaisuus on arvioitu kaloreiden, makrojen, painokehityksen ja tuotekohtaisen käytön perusteella.",
    suggestions: [goalHint, topProductHint],
  };
}

/* ================= ANALYZE ENDPOINT ================= */
app.post("/analyze", async (req, res) => {
  try {
    const { mode, instructions, data: weeklyData, ocrText, profile, imageBase64, mealAdjustments } = req.body;

    if (mode === "weekly_report") {
      if (!instructions || typeof instructions !== "string" || !weeklyData || typeof weeklyData !== "object") {
        return res.status(400).json({ error: "Virheellinen weekly_report pyyntö: instructions ja data vaaditaan." });
      }

      const weeklyPrompt = `${instructions.trim()}

Palauta VAIN JSON täsmälleen tällä rakenteella:
{
  "level": "🟢",
  "score": 82,
  "summary": "Viikkotason yhteenveto suomeksi.",
  "suggestions": [
    "Konkreettinen ehdotus 1",
    "Konkreettinen ehdotus 2"
  ]
}

Säännöt:
- Arvioi tuotteiden käyttö, kalorit, makrot (carbs, sugar, protein, fat), painon muutos ja käyttäjän tavoite.
- Taso: 🟢 hyvä linjaus tavoitteeseen, 🟡 kohtalainen, 🔴 heikko.
- Ehdotuksia 2-4, lyhyitä ja konkreettisia.
- Lisää tuotekohtainen ehdotus, jos data tukee sitä.
- Sovita tavoitteen mukaan:
  - laihdutus: kalorien hallinta + proteiini
  - yllapito: tasainen saanti + monipuolinen tasapaino
  - lihasmassa: riittävä energia + proteiini
- Ei diagnooseja. Ei vaarallisia painonpudotusohjeita.

Data:
${JSON.stringify(weeklyData, null, 2)}`;

      try {
        const response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-goog-api-key": API_KEY,
            },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: weeklyPrompt }] }],
            }),
          }
        );

        if (!response.ok) {
          throw new Error(await response.text());
        }

        const aiData = await response.json();
        const rawText = aiData.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

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
        const parsed = JSON.parse(textToParse);
        return res.status(200).json(normalizeWeeklyReport(parsed));
      } catch (err) {
        console.error("weekly_report failed, using fallback:", err?.message || err);
        return res.status(200).json(buildWeeklyReportFallback(req.body));
      }
    }

    // AI-kuva-analyysi (AI-kameranappi)
    if (imageBase64) {
      console.log("mealAdjustments from client:", mealAdjustments);
      const baseData = await analyzeImage(imageBase64);
      const adjusted = applyMealAdjustments(baseData, mealAdjustments);
      const hasProfile = profile?.weight && profile?.height;
      const resultText = hasProfile
        ? buildProfileAwareText(adjusted, profile)
        : buildGenericText(adjusted);

      return res.json({
        // Käyttäjälle näytettävä analyysiteksti
        result: resultText,

        // Taaksepäinyhteensopivuus (vanha malli)
        foodName: adjusted.foodName,
        calories: adjusted.calories,
        protein: adjusted.protein,
        carbs: adjusted.carbs,
        sugar: adjusted.sugar,
        fat: adjusted.fat,
        healthClass: adjusted.healthClass,

        // Uusi malli: products + totalCalories, jota appi odottaa
        products: [
          {
            name: adjusted.foodName,
            calories: adjusted.calories,
            protein: adjusted.protein,
            carbs: adjusted.carbs,
            sugar: adjusted.sugar,
            fat: adjusted.fat,
          },
        ],
        totalCalories: adjusted.calories,
        suggestedName: adjusted.foodName,
      });
    }

    /* ================= OCR ANALYSIS ================= */
    if (!ocrText) {
      return res.status(400).json({ error: "OCR-teksti puuttuu" });
    }

    const includeOcrProcessingScale = shouldAddOcrProcessingScale(profile);

    let prompt = `
  OLET TAUSTALLA TOIMIVA ANALYYSIMOOTTORI.

  ANALYYSIMENETELMÄ: OCR-TEKSTI (ravintosisältö on luettu pakkauksesta; tämä ei ole kuva-analyysi).

⚠️ ERITTÄIN TÄRKEÄT SÄÄNNÖT:
- KÄYTTÄJÄ NÄKEE VAIN JSON-KENTÄN "result"
- ÄLÄ KOSKAAN lisää ohjeita, sääntöjä, JSON-rakennetta tai teknistä tekstiä "result"-kenttään
- "result" on PUHDASTA käyttäjälle tarkoitettua analyysitekstiä
- "products" ja "totalCalories" ovat vain sovelluksen sisäiseen käyttöön
- ÄLÄ mainitse sanoja: JSON, kenttä, ohje, prompt, analyysi, malli

⚠️ KRIITTINEN SÄÄNTÖ KALOREISTA JA MAKROISTA:
- Palauta AINA calories ja makrot muodossa per 100 g TAI per 100 ml (ei kulutetun annoksen mukaan)
- Jos taulukossa on sekä per annos että per 100g/100ml, käytä aina per 100g/100ml arvoja
- Jos taulukossa näkyy vain annoskohtainen arvo, muunna se per 100g/100ml muotoon, jos annoskoko on pääteltävissä
- Jos tieto on epävarma, palauta silti best-effort per 100g/100ml numeeriset arvot
- Useamman tuotteen tapauksessa: jokainen products-rivi on per 100g/100ml samassa muodossa
- totalCalories tulee olla products-listan calories-arvojen summa (eli per-100-arvojen summa)

PALAAUTA VASTAUS TÄSMÄLLEEN SEURAAVASSA RAKENTEESSA (EI MITÄÄN MUUTA):

{
  "result": "<vain käyttäjälle tarkoitettu teksti>",
  "products": [
    {
      "name": "Tuotteen nimi",
      "calories": 150,
      "protein": 5,
      "carbs": 20,
      "sugar": 8,
      "fat": 10
    }
  ],
  "totalCalories": 150${includeOcrProcessingScale ? `,
  "processingLevel": 3,
  "processingLabel": "prosessoitu",
  "processingReason": "Perustelu vain OCR-tekstistä."
` : ""}
}

HUOM:
- carbs = total carbohydrates (Hiilihydraatit / Carbohydrate / Carbohydrates)
- sugar = sugars subset (joista sokereita / Sugars / of which sugars)
- Jos sugar-arvo puuttuu, palauta sugar: 0 (älä jätä kenttää pois)
- Tunnista desimaalit sekä muodossa 12.5 g että 12,5 g
- Palauta arvot aina per 100g tai per 100ml (ei kulutettua annosta)
- Jos OCR kertoo sekä painon/tilavuuden että kokonaissisällön, laske tarvittaessa per 100g/100ml
- Validointi: kaikki makrot >= 0, sugar <= carbs; jos sugar > carbs, aseta sugar = carbs
- Sugar-indikaattorit: joista sokereita, sokerit, sokeria, sugars, of which sugars
- Carbs-indikaattorit: hiilihydraatit, carbohydrate, carbohydrates
${includeOcrProcessingScale ? `
- Arvioi prosessointiaste vain OCR-tekstin perusteella (ei kuvan ulkonäköä, väriä tai brändioletuksia).
- Prosessointiasteikko:
  1 = prosessoimaton
  2 = minimiprosessoitu
  3 = prosessoitu
  4 = ultraprosessoitu
- Lisää vastaukseen myös kentät:
  "processingLevel": 1-4,
  "processingLabel": "prosessoimaton|minimiprosessoitu|prosessoitu|ultraprosessoitu",
  "processingReason": "lyhyt OCR-perusteinen perustelu"
` : ""}
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
${includeOcrProcessingScale ? `- 🏭 Prosessointiaste (OCR): X/4 - prosessoimaton|minimiprosessoitu|prosessoitu|ultraprosessoitu` : ""}

📌 PERUSTELU:
1–2 lausetta, joissa mainitaan käyttäjän tavoite ja aikaväli.

🎯 JOHTOPÄÄTÖS:
Yksi selkeä ja suora lause.

💡 PAREMPI VAIHTOEHTO:
- LISÄÄ TÄMÄ OSIO VAIN JOS ARVIOIT TUOTTEEN LUOKKAAN 🔴 (raskas / epäterveellinen)
- ÄLÄ LISÄÄ TÄTÄ OSIOTA, JOS TUOTE ON 🟢 TAI 🟡
- Anna konkreettinen vaihtoehto tai vaihto, esim.:
  - vaihda täysrasvainen versio vähärasvaiseen
  - vaihda sokerillinen juoma sokerittomaan
  - vaihda osa tuotteesta kasvis-/salaattilisukkeeseen
  - valitse pienempi pakkauskoko
Kirjoita lyhyesti ja konkreettisesti, mitä käyttäjä voi vaihtaa mihin.
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
${includeOcrProcessingScale ? `🏭 Prosessointiaste (OCR): X/4 - prosessoimaton|minimiprosessoitu|prosessoitu|ultraprosessoitu` : ""}

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
      const rawProducts = Array.isArray(payload.products) ? payload.products : [];

      const products = rawProducts.length
        ? rawProducts.map((p) => sanitizeMacros(p))
        : [
            sanitizeMacros({
              name: payload.name || payload.foodName || "Tuntematon tuote",
              calories: payload.calories,
              protein: payload.protein,
              carbs: payload.carbs,
              sugar: payload.sugar,
              fat: payload.fat,
            }),
          ];

      const totalCalories = Number.isFinite(payload.totalCalories)
        ? Math.max(0, normalizeNumber(payload.totalCalories))
        : products.reduce((sum, p) => sum + (p.calories || 0), 0);

      let suggestedName = "";
      if (products.length === 1) {
        suggestedName = products[0].name || "";
      } else if (products.length > 1) {
        suggestedName = products.map((p) => p.name).filter(Boolean).join(", ");
      }

      const normalizedProcessingLabel = normalizeProcessingLabel(payload.processingLabel);
      let processingLevel = normalizeProcessingLevel(payload.processingLevel);
      if (!processingLevel && normalizedProcessingLabel) {
        processingLevel = processingLevelFromLabel(normalizedProcessingLabel);
      }
      const processingLabel = processingLevel ? processingLabelFromLevel(processingLevel) : "";
      const processingReason =
        typeof payload.processingReason === "string" ? payload.processingReason.trim() : "";
      const resultText = extractOcrResultText(payload, rawText, products);

      return res.json({
        result: resultText,
        products,
        totalCalories,
        suggestedName,
        ...(includeOcrProcessingScale && processingLevel
          ? {
              processingLevel,
              processingLabel,
              processingReason,
            }
          : {}),
      });
    }

    const fallbackProducts = [
      sanitizeMacros({
        name: "Tuntematon tuote",
        calories: 0,
        carbs: 0,
        sugar: 0,
        protein: 0,
        fat: 0,
      }),
    ];

    res.json({
      result: extractOcrResultText(null, rawText, fallbackProducts),
      products: fallbackProducts,
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
