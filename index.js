import cors from "cors";
import dotenv from "dotenv";
import express from "express";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.GEMINI_API_KEY;

/* ================= BARCODE LOOKUP ================= */
async function fetchProductByBarcode(barcode) {
  try {
    const response = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`
    );
    
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    
    if (data.status === 0 || !data.product) {
      return null; // Tuotetta ei löytynyt
    }

    const product = data.product;
    
    // Rakenna tuotetiedot
    const productInfo = {
      name: product.product_name || "Tuntematon tuote",
      brands: product.brands || "",
      quantity: product.quantity || "",
      categories: product.categories || "",
      nutriments: product.nutriments || {},
      ingredients_text: product.ingredients_text || "",
      nutriscore_grade: product.nutriscore_grade || "",
      nova_group: product.nova_group || "",
      ecoscore_grade: product.ecoscore_grade || "",
    };

    return productInfo;
  } catch (error) {
    console.error("Viivakoodin haku epäonnistui:", error);
    return null;
  }
}

/* ================= ANALYZE ENDPOINT ================= */
app.post("/analyze", async (req, res) => {
  try {
    let { ocrText, barcode, profile } = req.body;

    /* ================= BARCODE LOOKUP ================= */
    // Jos viivakoodi annettu, hae tuotetiedot ja muunna tekstiksi
    if (barcode) {
      const product = await fetchProductByBarcode(barcode);
      
      if (!product) {
        return res.json({ notFound: true });
      }

      // Muotoile viivakoodin tiedot tekstiksi, joka käsitellään kuin OCR-teksti
      ocrText = `
TUOTE: ${product.name}${product.brands ? ` (${product.brands})` : ""}
${product.quantity ? `MÄÄRÄ: ${product.quantity}` : ""}

RAVINTOARVOT (per 100g):
Energia: ${product.nutriments.energy_value || product.nutriments["energy-kcal"] || "?"} kcal
Rasva: ${product.nutriments.fat || "?"} g
Joista tyydyttynyttä: ${product.nutriments["saturated-fat"] || "?"} g
Hiilihydraatit: ${product.nutriments.carbohydrates || "?"} g
Joista sokereita: ${product.nutriments.sugars || "?"} g
Proteiini: ${product.nutriments.proteins || "?"} g
Suola: ${product.nutriments.salt || "?"} g
${product.nutriments.fiber ? `Kuitu: ${product.nutriments.fiber} g` : ""}

${product.nutriscore_grade ? `NUTRI-SCORE: ${product.nutriscore_grade.toUpperCase()}` : ""}
${product.ingredients_text ? `\nAINESOSAT: ${product.ingredients_text}` : ""}
`.trim();
    }

    /* ================= OCR/BARCODE ANALYSIS ================= */
    if (!ocrText) {
      return res.status(400).json({ error: "OCR-teksti tai viivakoodi puuttuu" });
    }

    let prompt = `
OLET TAUSTALLA TOIMIVA ANALYYSIMOOTTORI.

⚠️ ERITTÄIN TÄRKEÄT SÄÄNNÖT:
- KÄYTTÄJÄ NÄKEE VAIN JSON-KENTÄN "result"
- ÄLÄ KOSKAAN lisää ohjeita, sääntöjä, JSON-rakennetta tai teknistä tekstiä "result"-kenttään
- "result" on PUHDASTA käyttäjälle tarkoitettua analyysitekstiä
- "products" ja "totalCalories" ovat vain sovelluksen sisäiseen käyttöön
- ÄLÄ mainitse sanoja: JSON, kenttä, ohje, prompt, analyysi, malli

PALAAUTA VASTAUS TÄSMÄLLEEN SEURAAVASSA RAKENTEESSA (EI MITÄÄN MUUTA):

{
  "result": "<vain käyttäjälle tarkoitettu teksti>",
  "products": [
    { "name": "Tuotteen nimi", "calories": 150 }
  ],
  "totalCalories": 150
}
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
