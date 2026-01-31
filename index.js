import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.GEMINI_API_KEY;

app.post("/analyze", async (req, res) => {
  try {
    const { ocrText, profile } = req.body;

    if (!ocrText) {
      return res.status(400).json({ error: "OCR-teksti puuttuu" });
    }

    /* ================= PROMPT ================= */

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

    /* ================= PROFILE PROMPT ================= */

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
      /* ================= BASIC PROMPT ================= */
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

    /* ================= GEMINI CALL ================= */

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
    const rawText =
      data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    /* ================= JSON PARSING ================= */

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = null;
    }

    if (payload && typeof payload === "object") {
      const products = Array.isArray(payload.products)
        ? payload.products
        : [];

      const totalCalories =
        Number.isFinite(payload.totalCalories)
          ? payload.totalCalories
          : products.reduce(
              (sum, p) => sum + (Number(p?.calories) || 0),
              0
            );

      return res.json({
        result:
          typeof payload.result === "string"
            ? payload.result.trim()
            : "Analyysi epäonnistui",
        products,
        totalCalories,
      });
    }

    /* ================= FALLBACK ================= */

    res.json({
      result: rawText || "Analyysi epäonnistui",
      products: [],
      totalCalories: 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Jokin meni pieleen" });
  }
});

/* ================= SERVER ================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend käynnissä portissa ${PORT}`);
});
