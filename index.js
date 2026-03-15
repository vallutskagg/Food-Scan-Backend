import cors from "cors";
import dotenv from "dotenv";
import express from "express";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use((req, _res, next) => {
  if (req.path === "/analyze" || req.path === "/analyze/") {
    console.log(`[analyze] ${req.method} from ${req.ip}`);
  }
  next();
});

const API_KEY = process.env.GEMINI_API_KEY;

/* ================= AI IMAGE HELPERS ================= */

function resolveImagePayload(body = {}) {
  const rawImage = body?.imageBase64 ?? body?.image ?? body?.base64Image ?? body?.photoBase64 ?? "";
  if (typeof rawImage !== "string") {
    return { imageBase64: "", mimeType: "image/jpeg" };
  }

  const trimmed = rawImage.trim();
  if (!trimmed) {
    return { imageBase64: "", mimeType: "image/jpeg" };
  }

  const dataUrlMatch = trimmed.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i);
  if (dataUrlMatch) {
    return {
      mimeType: dataUrlMatch[1].toLowerCase(),
      imageBase64: dataUrlMatch[2].replace(/\s+/g, ""),
    };
  }

  return {
    imageBase64: trimmed.replace(/\s+/g, ""),
    mimeType: "image/jpeg",
  };
}

// Vision-mallin analyysi: tunnistaa ruokalajin ja karkeat makrot
async function analyzeImage(imageBase64, mimeType = "image/jpeg") {
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
                  mimeType,
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

function legacyNormalizeWeeklyReport(raw) {
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

function legacyBuildWeeklyReportFallback(body = {}) {
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

const LEVEL_GOOD = "🟢";
const LEVEL_OK = "🟡";
const LEVEL_WEAK = "🔴";

function scoreToLevel(score) {
  if (score >= 75) return LEVEL_GOOD;
  if (score >= 50) return LEVEL_OK;
  return LEVEL_WEAK;
}

function normalizeSuggestionList(rawSuggestions, minCount, maxCount, fallbackSuggestions) {
  const cleaned = Array.isArray(rawSuggestions)
    ? rawSuggestions
        .filter((s) => typeof s === "string")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, maxCount)
    : [];

  if (cleaned.length >= minCount) return cleaned;
  return fallbackSuggestions.slice(0, maxCount);
}

function normalizeReportResponse(raw, { minSuggestions, maxSuggestions, fallbackSummary, fallbackSuggestions, fallbackScore = 60 } = {}) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const score = Math.max(0, Math.min(100, Math.round(normalizeNumber(safe.score, fallbackScore))));
  const allowedLevels = new Set([LEVEL_GOOD, LEVEL_OK, LEVEL_WEAK]);
  const level = allowedLevels.has(safe.level) ? safe.level : scoreToLevel(score);
  const summary = typeof safe.summary === "string" && safe.summary.trim() ? safe.summary.trim() : fallbackSummary;
  const suggestions = normalizeSuggestionList(safe.suggestions, minSuggestions, maxSuggestions, fallbackSuggestions);

  return { level, score, summary, suggestions };
}

function normalizeWeeklyReport(raw) {
  return normalizeReportResponse(raw, {
    minSuggestions: 2,
    maxSuggestions: 4,
    fallbackScore: 62,
    fallbackSummary:
      "Viikon tiedot analysoitiin. Jatka tasaista energiansaantia ja pidä makrot tavoitteen mukaisina.",
    fallbackSuggestions: [
      "Pidä päivittäinen energiansaanti mahdollisimman tasaisena koko viikon ajan.",
      "Säädä proteiinia tavoitteen mukaan ja vältä suuria heilahteluja sokerin saannissa.",
    ],
  });
}

function normalizePeriodSummary(raw) {
  return normalizeReportResponse(raw, {
    minSuggestions: 3,
    maxSuggestions: 6,
    fallbackScore: 60,
    fallbackSummary:
      "Koko aikaväli analysoitiin. Jakso onnistui osittain, ja seuraavaan jaksoon kannattaa tehdä selkeät, mitattavat parannukset.",
    fallbackSuggestions: [
      "Pidä kirjausaste korkeana koko seuraavan jakson ajan.",
      "Säädä kaloreita tavoitteesi suuntaan pienin askelin viikko kerrallaan.",
      "Seuraa makrojen toteumaa viikoittain ja korjaa poikkeamat nopeasti.",
    ],
  });
}

function scoreByRatioDiff(actual, target, goodRatio = 0.08, weakRatio = 0.18, fallback = 60) {
  if (!(target > 0)) return fallback;
  const diffRatio = Math.abs(actual - target) / target;
  if (diffRatio <= goodRatio) return 88;
  if (diffRatio <= weakRatio) return 68;
  if (diffRatio <= 0.28) return 48;
  return 30;
}

function scoreByDirection(goal, weightChangeKg) {
  if (!Number.isFinite(weightChangeKg)) return 60;
  if (goal === "laihdutus") {
    if (weightChangeKg < -0.2) return 90;
    if (weightChangeKg <= 0.2) return 65;
    return 32;
  }
  if (goal === "lihasmassa") {
    if (weightChangeKg > 0.2) return 86;
    if (weightChangeKg >= -0.2) return 62;
    return 35;
  }
  if (goal === "yllapito") {
    const drift = Math.abs(weightChangeKg);
    if (drift <= 0.5) return 86;
    if (drift <= 1.0) return 66;
    return 40;
  }
  return 60;
}

function weightedScore(parts = []) {
  const valid = parts.filter((p) => Number.isFinite(p?.score) && Number.isFinite(p?.weight) && p.weight > 0);
  if (!valid.length) return 60;
  const totalWeight = valid.reduce((sum, part) => sum + part.weight, 0);
  const totalScore = valid.reduce((sum, part) => sum + part.score * part.weight, 0);
  return Math.max(0, Math.min(100, Math.round(totalScore / totalWeight)));
}

function topProductByEnergy(products = []) {
  return products
    .slice()
    .sort(
      (a, b) =>
        normalizeNumber(b?.calories) * Math.max(1, normalizeNumber(b?.count, 1)) -
        normalizeNumber(a?.calories) * Math.max(1, normalizeNumber(a?.count, 1))
    )[0];
}

function averageMacroScore(totals = {}, dailyMacroTargets = {}) {
  const pairs = [
    { actual: normalizeNumber(totals.avgCarbs), target: normalizeNumber(dailyMacroTargets.carbs) },
    { actual: normalizeNumber(totals.avgSugar), target: normalizeNumber(dailyMacroTargets.sugar) },
    { actual: normalizeNumber(totals.avgProtein), target: normalizeNumber(dailyMacroTargets.protein) },
    { actual: normalizeNumber(totals.avgFat), target: normalizeNumber(dailyMacroTargets.fat) },
  ];

  const valid = pairs.filter((p) => p.target > 0);
  if (!valid.length) return 60;
  const sum = valid.reduce((acc, p) => acc + scoreByRatioDiff(p.actual, p.target, 0.1, 0.22, 60), 0);
  return Math.round(sum / valid.length);
}

function buildWeeklyReportFallback(body = {}) {
  const data = body?.data || {};
  const totals = data.totals || {};
  const dailyMacroTargets = data.dailyMacroTargets || {};
  const goal = normalizeGoal(data.goal);
  const products = Array.isArray(data.products) ? data.products : [];
  const topProduct = topProductByEnergy(products);

  const avgCalories = normalizeNumber(totals.avgCaloriesPerDay);
  const dailyTargetCalories = normalizeNumber(data.dailyTargetCalories);
  const macroScore = averageMacroScore(totals, dailyMacroTargets);
  const calorieScore = scoreByRatioDiff(avgCalories, dailyTargetCalories, 0.08, 0.18, 62);
  const weightScore = scoreByDirection(goal, normalizeNumber(data.weightChangeKg, Number.NaN));
  const productLoadScore = topProduct ? 68 : 74;

  const score = weightedScore([
    { score: calorieScore, weight: 0.4 },
    { score: macroScore, weight: 0.25 },
    { score: weightScore, weight: 0.25 },
    { score: productLoadScore, weight: 0.1 },
  ]);
  const level = scoreToLevel(score);

  let goalHint = "Pidä energia ja makrot mahdollisimman tasaisina koko viikon ajan.";
  if (goal === "laihdutus") {
    goalHint = "Pidä kalorit tavoiterajassa ja varmista riittävä proteiini kylläisyyden tueksi.";
  } else if (goal === "lihasmassa") {
    goalHint = "Varmista riittävä kokonaisenergia ja pidä proteiinin saanti tasaisena päivän aikana.";
  } else if (goal === "yllapito") {
    goalHint = "Pidä kalorit lähellä tavoitetta ja säilytä makrojen tasapaino arjessa.";
  }

  const topProductHint = topProduct?.name
    ? `Säädä tuotteen "${topProduct.name}" viikoittaista määrää niin, että se tukee tavoitettasi paremmin.`
    : "Tarkista eniten käytettyjen tuotteiden annoskoot ja toistuvuus viikon aikana.";

  const sugarTarget = normalizeNumber(dailyMacroTargets.sugar);
  const avgSugar = normalizeNumber(totals.avgSugar);
  const sugarHint =
    sugarTarget > 0 && avgSugar > sugarTarget
      ? "Laske lisättyä sokeria sisältävien tuotteiden käyttöä ja korvaa osa niistä vähäsokerisilla vaihtoehdoilla."
      : "Pidä hiilihydraatit ja sokeri linjassa päivän kokonaisenergian kanssa.";

  const summary =
    score >= 75
      ? "Viikko oli tavoitteeseen nähden onnistunut. Energiataso, makrot ja painosuunta tukivat kokonaisuutta hyvin."
      : score >= 50
      ? "Viikko onnistui osittain. Suunta on oikea, mutta kaloreissa tai makroissa näkyy vielä korjattavaa."
      : "Viikko jäi tavoitteesta. Energiataso, makrot tai painosuunta eivät olleet vielä riittävän hyvin linjassa tavoitteen kanssa.";

  return {
    level,
    score,
    summary,
    suggestions: [goalHint, sugarHint, topProductHint].slice(0, 4),
  };
}

function buildPeriodSummaryFallback(body = {}) {
  const data = body?.data || {};
  const period = data.period || {};
  const totals = data.totals || {};
  const dailyMacroTargets = data.dailyMacroTargets || {};
  const adherence = data.adherence || {};
  const goal = normalizeGoal(data.goal);
  const products = Array.isArray(data.products) ? data.products : [];
  const topProduct = topProductByEnergy(products);

  const totalDays = Math.max(0, Math.round(normalizeNumber(period.totalDays)));
  const loggedDays = Math.max(0, Math.round(normalizeNumber(period.loggedDays)));
  const loggingRatePercent =
    normalizeNumber(period.loggingRatePercent, totalDays > 0 ? (loggedDays / totalDays) * 100 : 0);
  const calorieHitRate = normalizeNumber(adherence.calorieTargetHitRatePercent);
  const successEstimate = normalizeNumber(adherence.successEstimatePercent);

  const avgCalories = normalizeNumber(totals.avgCaloriesPerDay);
  const dailyTargetCalories = normalizeNumber(data.dailyTargetCalories);
  const calorieScore = scoreByRatioDiff(avgCalories, dailyTargetCalories, 0.08, 0.18, 62);
  const macroScore = averageMacroScore(totals, dailyMacroTargets);
  const weightScore = scoreByDirection(goal, normalizeNumber(data.weightChangeKg, Number.NaN));

  const loggingScore = Math.max(0, Math.min(100, Math.round(loggingRatePercent)));
  const consistencyScore = weightedScore([
    { score: loggingScore, weight: 0.5 },
    { score: Math.max(0, Math.min(100, Math.round(calorieHitRate || 60))), weight: 0.3 },
    { score: Math.max(0, Math.min(100, Math.round(successEstimate || 60))), weight: 0.2 },
  ]);

  const score = weightedScore([
    { score: loggingScore, weight: 0.22 },
    { score: calorieScore, weight: 0.23 },
    { score: macroScore, weight: 0.2 },
    { score: weightScore, weight: 0.22 },
    { score: consistencyScore, weight: 0.13 },
  ]);
  const level = scoreToLevel(score);

  const outcomeText =
    score >= 75 ? "onnistuit hyvin" : score >= 50 ? "onnistuit osittain" : "tavoite jäi vajaaksi";
  const summary = `Aikaväli ${outcomeText}. Kirjausaste oli ${Math.round(loggingRatePercent)} %, ja kokonaislinja arvioitiin kaloreiden, makrojen, painosuunnan sekä johdonmukaisuuden perusteella.`;

  const suggestions = [];
  if (loggingRatePercent < 80) {
    suggestions.push("Nosta kirjausastetta lisäämällä vähintään yksi merkintä jokaiselle päivälle seuraavalla jaksolla.");
  }
  if (goal === "laihdutus") {
    suggestions.push("Pidä energiataso tasaisesti tavoitteen alapuolella maltillisesti ja varmista riittävä proteiini.");
  } else if (goal === "lihasmassa") {
    suggestions.push("Nosta energiaa hallitusti treenipäivinä ja pidä proteiinin päiväsaanti tasaisena.");
  } else {
    suggestions.push("Pidä päiväkohtaiset kalorit lähellä tavoitetta, jotta paino pysyy vakaana.");
  }

  const sugarTarget = normalizeNumber(dailyMacroTargets.sugar);
  const avgSugar = normalizeNumber(totals.avgSugar);
  if (sugarTarget > 0 && avgSugar > sugarTarget) {
    suggestions.push("Vähennä korkeasokeristen tuotteiden toistuvuutta ja vaihda osa valinnoista vähäsokerisiin vaihtoehtoihin.");
  } else {
    suggestions.push("Säilytä makrojen tasapaino seuraamalla proteiinin, hiilihydraattien ja rasvan päiväkeskiarvoja viikoittain.");
  }

  if (topProduct?.name) {
    suggestions.push(`Tee tuotteelle "${topProduct.name}" selkeä annos- tai käyttöfrekvenssin säätö seuraavalle jaksolle.`);
  }

  suggestions.push("Aseta seuraavalle jaksolle yksi mitattava välitavoite ja tarkista eteneminen kerran viikossa.");

  return {
    level,
    score,
    summary,
    suggestions: suggestions.slice(0, 6),
  };
}

function parseModelJson(rawText = "") {
  let cleanedText = String(rawText || "").trim();
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
  return JSON.parse(textToParse);
}

function buildReportPrompt(mode, instructions, data) {
  if (mode === "period_summary") {
    return `${instructions.trim()}

Palauta VAIN JSON täsmälleen tällä rakenteella:
{
  "level": "🟢",
  "score": 78,
  "summary": "Koko aikavälin yhteenveto suomeksi: mitä meni hyvin ja mitä kannattaa parantaa.",
  "suggestions": [
    "Konkreettinen ehdotus 1",
    "Konkreettinen ehdotus 2",
    "Konkreettinen ehdotus 3"
  ]
}

Säännöt:
- Arvioi koko jakson onnistuminen, ei vain yksittäistä viikkoa.
- Huomioi kirjausaste (loggedDays/totalDays), kalori- ja makrotavoitteet, painosuunnan sopivuus tavoitteeseen ja jakson johdonmukaisuus.
- Taso: 🟢 = hyvä linjaus tavoitteeseen, 🟡 = kohtalainen, 🔴 = heikko.
- Yhteenvedossa kerro luonnollisella suomella onnistuiko jakso hyvin, osittain vai jäikö tavoite vajaaksi.
- Ehdotuksia 3-6, lyhyitä, konkreettisia ja turvallisia.
- Ei diagnooseja. Ei vaarallisia laihdutusohjeita.
- Ei markdownia eikä muuta tekstiä JSONin ulkopuolelle.

Data:
${JSON.stringify(data, null, 2)}`;
  }

  return `${instructions.trim()}

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
- Arvioi tuotteiden käyttö, kalorit, makrot (carbs, sugar, protein, fat), painon muutos ja tavoite.
- Taso: 🟢 = hyvä linjaus tavoitteeseen, 🟡 = kohtalainen, 🔴 = heikko.
- Ehdotuksia 2-4, lyhyitä ja konkreettisia.
- Lisää tuotekohtainen ehdotus, kun data tukee sitä.
- Sovita tavoitteeseen:
  - laihdutus: kalorien hallinta + proteiinituki
  - yllapito: tasainen saanti + monipuolinen tasapaino
  - lihasmassa: riittävä energia + proteiinituki
- Ei diagnooseja. Ei vaarallisia painonpudotusohjeita.
- Ei markdownia eikä muuta tekstiä JSONin ulkopuolelle.

Data:
${JSON.stringify(data, null, 2)}`;
}

/* ================= ANALYZE ENDPOINT ================= */
app.post("/analyze", async (req, res) => {
  try {
    const { mode, instructions, data: reportData, ocrText, profile, mealAdjustments } = req.body;
    const { imageBase64, mimeType } = resolveImagePayload(req.body);

    if (mode === "weekly_report" || mode === "period_summary") {
      if (!instructions || typeof instructions !== "string" || !reportData || typeof reportData !== "object") {
        return res.status(400).json({
          error: `Virheellinen ${mode} pyyntö: instructions ja data vaaditaan.`,
        });
      }

      const reportPrompt = buildReportPrompt(mode, instructions, reportData);

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
              contents: [{ role: "user", parts: [{ text: reportPrompt }] }],
            }),
          }
        );

        if (!response.ok) {
          throw new Error(await response.text());
        }

        const aiData = await response.json();
        const rawText = aiData.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        const parsed = parseModelJson(rawText);
        const normalized =
          mode === "period_summary" ? normalizePeriodSummary(parsed) : normalizeWeeklyReport(parsed);
        return res.status(200).json(normalized);
      } catch (err) {
        console.error(`${mode} failed, using fallback:`, err?.message || err);
        const fallback =
          mode === "period_summary" ? buildPeriodSummaryFallback(req.body) : buildWeeklyReportFallback(req.body);
        return res.status(200).json(fallback);
      }
    }

    // AI-kuva-analyysi (AI-kameranappi)
    if (imageBase64) {
      console.log("mealAdjustments from client:", mealAdjustments);
      const baseData = await analyzeImage(imageBase64, mimeType);
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
      return res.status(400).json({
        error: "OCR-teksti puuttuu",
        details: "Anna joko ocrText tai imageBase64 (myos data:image/...;base64,... kelpaa).",
      });
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
- Kayta aina per 100g/100ml ravintoarvoja ensisijaisena lahteena, kun ne loytyvat OCR-tekstista.
- Jos seka per annos etta per 100g/100ml ovat saatavilla, sivuuta per annos -arvot ja laske aina per 100g/100ml pohjalta.
- Jos OCR:sta loytyy kulutettu maara (g/ml), skaalaa per 100g/100ml arvot siihen maaraan.
- Jos kulutettua maaraa ei loydy, kayta oletuksena 100 g/ml (eli palauta per 100g/100ml arvot sellaisenaan).
- Jos tieto on epavarma, palauta best-effort arvot ja pida makrokentat mukana.
- Useamman tuotteen tapauksessa jokainen products-rivi kuvaa kulutettua entrya samassa muodossa.
- totalCalories tulee olla products-listan calories-arvojen summa.

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
- Laske carbs, sugar, protein ja fat aina per 100g/100ml arvoista.
- Jos OCR:sta loytyy kulutettu maara, skaalaa arvot siihen maaraan.
- Jos kulutettu maara puuttuu, kayta oletuksena 100 g/ml.
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
    res.status(500).json({
      error: "Jokin meni pieleen",
      details: err?.message || "Tuntematon virhe",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend käynnissä portissa ${PORT}`);
});
