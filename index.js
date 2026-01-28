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
      // 🔹 Rakenna profiilin kuvaus dynaamisesti
      let profileText = `KÄYTTÄJÄN TERVEYSPROFIILI:
- Paino: ${profile.weight} kg
- Pituus: ${profile.height} cm`;

      if (profile.goal) {
        profileText += `\n- Tavoite: ${profile.goal}`;
        
        if (profile.goal === "laihdutus" && profile.targetWeight) {
          profileText += `\n  → Tavoitepaino: ${profile.targetWeight} kg`;
        } else if (profile.goal === "lihasmassa" && profile.targetMuscle) {
          profileText += `\n  → Tavoite lihasmassa: ${profile.targetMuscle} kg`;
        }
      }

      if (profile.timeframe) {
        profileText += `\n- Aikajänne: ${profile.timeframe} kuukautta`;
      }

      if (profile.startDate || profile.endDate) {
        if (profile.startDate) profileText += `\n- Alkamispäivä: ${profile.startDate}`;
        if (profile.endDate) profileText += `\n- Päättymispäivä: ${profile.endDate}`;
      }

      prompt = `
${profileText}

TUOTTEEN OCR-TEKSTI:
"""
${ocrText}
"""

TEHTÄVÄSI ON ANALYSOIDA RUOKATUOTE YKSILÖLLISESTI KÄYTTÄJÄN PROFIILIN PERUSTEELLA.

KÄYTTÄJÄN TIEDOT:
- Paino: {{weight}} kg
- Pituus: {{height}} cm
- Tavoite: {{goal}} (laihdutus / ylläpito / lihasmassa)
- Tavoitepaino tai lihasmassa: {{targetWeightOrMuscle}} kg (jos annettu)
- Aikaväli: {{timeframe}} kuukautta
- Alkupäivä: {{startDate}}
- Loppupäivä: {{endDate}}

TOIMI AINA NÄIN:

1️⃣MÄÄRITÄ ENERGIASTRATEGIA VAIN KÄYTTÄJÄN VALITSEMAN TAVOITTEEN PERUSTEELLA:

JOS tavoite = "laihdutus":
- Käytä päivittäistä energiavajetta 300–500 kcal
- ÄLÄ ehdota energiatasausta tai ylijäämää

JOS tavoite = "ylläpito":
- Käytä energiatasausta (0 kcal vaje / ylijäämä)
- ÄLÄ ehdota kalorivajetta tai ylijäämää

JOS tavoite = "lihasmassa":
- Käytä päivittäistä energian ylijäämää 250–400 kcal
- ÄLÄ ehdota kalorivajetta tai ylläpitoa

⚠️ SÄÄNNÖT:
- ÄLÄ analysoi, mainitse tai vertaile muita tavoitteita
- Käytä vain käyttäjän valitsemaa tavoitetta koko analyysissä

2️⃣ ANALYSOI TUOTE:
- Kaloritiheys
- Proteiinipitoisuus
- Sokerit ja rasvat
- Kuinka hyvin tuote tukee käyttäjän valittua tavoitetta

3️⃣ ANNA KONKREETTINEN SUOSITUS:
- Annoskoko grammoina tai millilitroina
- Kuinka usein tuotetta voi käyttää tavoitteen puitteissa
- Luokittele tuote terveellisyysasteikolla:
  🟢 terveellinen
  🟡 kohtalainen
  🔴 vain satunnaiseen käyttöön

⚠️ TÄRKEÄÄ:
- ÄLÄ anna yleisiä neuvoja
- ÄLÄ käytä sanoja "yleisesti", "riippuu" tai "muissa tapauksissa"
- Annoskoko ja käyttötiheys on aina sidottava käyttäjän tavoitteeseen ja aikaväliin
- Jos tuote hidastaa tavoitetta, rajoita käyttö selkeästi

PALAUTA TULOS TÄSMÄLLEEN SEURAAVASSA MUODOSSA (ÄLÄ LISÄÄ MITÄÄN MUUTA):

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
