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
    // 🔥 TÄRKEIN MUUTOS: vastaanotetaan koko OCR-teksti
    const { ocrText } = req.body;

    if (!ocrText) {
      return res.status(400).json({ error: "OCR-teksti puuttuu" });
    }

    const prompt = `
Seuraava teksti on luettu elintarvikepakkauksesta OCR:llä.

TEKSTI:
"""
${ocrText}
"""

TEHTÄVÄ:
1. Tunnista tekstistä ravintoarvot per 100 g / 100 ml TAI per annos.
   - energia (kcal)
   - rasva (g)
   - joista sokerit (g)
   - proteiini (g)
   - suola (g)

2. Jos pakkauksessa on ilmoitettu:
   - koko (esim. 250 g, 330 ml)
   - annosten määrä  
   → LASKE KOKO TUOTTEEN RAVINTOARVOT YHTEENSÄ.

3. Jos tietoja puuttuu, tee paras mahdollinen arvio ja kerro epävarmuus.

4. Palauta tulos SELKEÄSTI seuraavassa muodossa:

RAVINTOARVOT YHTEENSÄ:
- Energia: X kcal
- Rasva: X g
- Joista sokerit: X g
- Proteiini: X g
- Suola: X g

ARVIO:
- Terveellisyysluokka: terveellinen / kohtalainen / satunnaisesti nautittava
- Perustelu lyhyesti

JOHTOPÄÄTÖS:
Yksi selkeä lause käyttäjälle.
`;

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
              parts: [{ text: prompt }],
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API-virhe: ${text}`);
    }

    const data = await response.json();
    const result =
      data.candidates?.[0]?.content?.parts?.[0]?.text ??
      "Analyysi epäonnistui";

    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Jokin meni pieleen" });
  }
});

app.listen(3000, () => {
  console.log("Backend käynnissä");
});
