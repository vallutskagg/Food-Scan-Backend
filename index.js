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

    // 🔹 Jos profiili käytössä, käytä "personalisoitua" promptia
    let prompt;

    if (profile && profile.weight && profile.height) {
      prompt = `
KÄYTTÄJÄN TIEDOT:
- Paino: ${profile.weight} kg
- Pituus: ${profile.height} cm
- Tavoite: ${profile.goal ?? "ei asetettu"}
- Aikajänne: ${profile.timeframe ?? "ei asetettu"} kuukautta

TUOTTEEN OCR-TEKSTI:
"""
${ocrText}
"""

TEHTÄVÄ:
1. Arvioi päivittäinen energiantarve (BMR + kevyt aktiivisuus).
2. Huomioi käyttäjän tavoite.
3. Arvioi kuinka paljon tuotetta sopii:
- kerralla
- päivän aikana
- viikon aikana

PALAUTA TULOS TÄSMÄLLEEN SEURAAVASSA MUODOSSA:

👤 SINULLE SOPIVA MÄÄRÄ:
- 🍽 Suositeltu annos: X g / ml
- 🟢 terveellinen  
  🟡 kohtalainen  
  🔴 satunnaisesti nautittava  
  👉 Käytä AINOASTAAN valitun luokan emojia ja nimeä.  
  👉 Älä listaa muita vaihtoehtoja.
- 📆 Kuinka usein: X

📌 PERUSTELU LYHYESTI:
Yksi perustelu.

🎯 JOHTOPÄÄTÖS  
Yksi selkeä lause.
`;
    } else {
      // 🔹 Jos profiilia ei ole, käytä normaalia ravintoarvopromptia
      prompt = `
Seuraava teksti on luettu elintarvikepakkauksesta OCR:llä.

TEKSTI:
"""
${ocrText}
"""

TEHTÄVÄ:
1️⃣ Tunnista tekstistä ravintoarvot per 100 g / 100 ml TAI per annos:
  🍽️ Energia (kcal)  
  🥑 Rasva (g)  
  🍬 Joista sokerit (g)  
  🍗 Proteiini (g)  
  🧂 Suola (g)  

---

2️⃣ Jos pakkauksessa on mainittu:
   - koko (esim. 250 g, 330 ml)
   - annosten määrä  
   → LASKE KOKO TUOTTEEN RAVINTOARVOT YHTEENSÄ.

---

3️⃣ Jos jokin tieto puuttuu tai on epäselvä:
- tee paras mahdollinen arvio
- mainitse epävarmuus lyhyesti

---

4️⃣ Palauta tulos SELKEÄSTI seuraavassa muodossa:

📊 RAVINTOARVOT YHTEENSÄ  
🔥 Energia: X kcal  
🥑 Rasva: X g  
🍬 Joista sokerit: X g  
🍗 Proteiini: X g  
🧂 Suola: X g  

---

📝 ARVIO  
Terveellisyysluokka (VALITSE VAIN YKSI):

🟢 terveellinen  
🟡 kohtalainen  
🔴 satunnaisesti nautittava  

👉 Käytä AINOASTAAN valitun luokan emojia ja nimeä.  
👉 Älä listaa muita vaihtoehtoja.

---

🎯 JOHTOPÄÄTÖS  
Yksi selkeä ja käyttäjälle ymmärrettävä lause.
`;
    }

    // 🔹 Lähetä prompt AI:lle
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
            { role: "user", parts: [{ text: prompt }] },
          ],
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API-virhe: ${text}`);
    }

    const data = await response.json();
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "Analyysi epäonnistui";

    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Jokin meni pieleen" });
  }
});


app.listen(3000, () => {
  console.log("Backend käynnissä");
});
