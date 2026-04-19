import assert from "node:assert/strict";
import http from "node:http";

process.env.NODE_ENV = "test";
process.env.GEMINI_API_KEY = "test-key";

const { app } = await import("../index.js");

let modelCalls = [];
let server;
let baseUrl;
const DEFAULT_MODEL_TEXT = JSON.stringify({
  foodName: "Kana-riisiannos",
  calories: 620,
  protein: 38,
  carbs: 62,
  sugar: 4,
  fat: 19,
  healthClass: "\u{1F7E2}",
});

function buildMockModelResponse(responseText = DEFAULT_MODEL_TEXT) {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              text: responseText,
            },
          ],
        },
      },
    ],
  };
}

function stubModelFetch({ responseText = DEFAULT_MODEL_TEXT } = {}) {
  modelCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    modelCalls.push({ url, options });
    return {
      ok: true,
      json: async () => buildMockModelResponse(responseText),
      text: async () => "",
    };
  };
}

function postAnalyze(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      `${baseUrl}/analyze`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          let parsedBody = data;
          try {
            parsedBody = data ? JSON.parse(data) : null;
          } catch {
            // Keep raw body if parsing fails.
          }
          resolve({
            statusCode: response.statusCode || 0,
            body: parsedBody,
          });
        });
      }
    );

    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

async function withServer(fn) {
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn();
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

await withServer(async () => {
  await runCase("1) Kuva + kaikki annostiedot -> AI-kutsu sisaltaa kaikki kentat", async () => {
    stubModelFetch();

    const response = await postAnalyze({
      imageBase64: "dGVzdGltYWdl",
      profile: { weight: 80, height: 180, goal: "lose" },
      mealAdjustments: {
        portionMultiplier: 1.2,
        oilAdded: true,
        servingContext: "restaurant",
        adjustmentPercent: 10,
        mealDescription: "ensisijainen kuvaus",
      },
      mealDescription: "varakentta kuvaus",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(modelCalls.length, 1);

    const callPayload = JSON.parse(modelCalls[0].options.body);
    const parts = callPayload?.contents?.[0]?.parts || [];
    const textPart = parts.find((part) => typeof part.text === "string")?.text || "";
    const imagePart = parts.find((part) => part.inlineData)?.inlineData;

    assert.equal(imagePart?.data, "dGVzdGltYWdl");
    assert.match(textPart, /portionMultiplier: 1\.2/);
    assert.match(textPart, /oilAdded: true/);
    assert.match(textPart, /servingContext: restaurant/);
    assert.match(textPart, /adjustmentPercent: 10/);
    assert.match(textPart, /mealDescription: "ensisijainen kuvaus"/);
    assert.doesNotMatch(textPart, /varakentta kuvaus/);
  });

  await runCase("2) Kuva ilman mealAdjustments -> kaytetaan oletuksia", async () => {
    stubModelFetch();

    const response = await postAnalyze({
      imageBase64: "dGVzdGltYWdl",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(modelCalls.length, 1);

    const callPayload = JSON.parse(modelCalls[0].options.body);
    const textPart = callPayload?.contents?.[0]?.parts?.find((part) => typeof part.text === "string")?.text || "";

    assert.match(textPart, /portionMultiplier: 1/);
    assert.match(textPart, /oilAdded: false/);
    assert.match(textPart, /servingContext: home/);
    assert.match(textPart, /adjustmentPercent: 0/);
  });

  await runCase("3) Virheellinen adjustmentPercent -> clamp toimii", async () => {
    stubModelFetch();

    const response = await postAnalyze({
      imageBase64: "dGVzdGltYWdl",
      mealAdjustments: {
        adjustmentPercent: 999,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(modelCalls.length, 1);

    const callPayload = JSON.parse(modelCalls[0].options.body);
    const textPart = callPayload?.contents?.[0]?.parts?.find((part) => typeof part.text === "string")?.text || "";
    assert.match(textPart, /adjustmentPercent: 20/);
  });

  await runCase("4) Tyhja imageBase64 -> 400", async () => {
    stubModelFetch();

    const response = await postAnalyze({
      imageBase64: "   ",
      mealAdjustments: {},
    });

    assert.equal(response.statusCode, 400);
    assert.equal(modelCalls.length, 0);
    assert.equal(response.body?.error, "imageBase64 is required and must be a non-empty string");
  });

  await runCase("5) OCR toimii vaikka mealAdjustments ja mealDescription mukana", async () => {
    stubModelFetch();

    const response = await postAnalyze({
      ocrText: "Energia 220 kcal / 100 g, Hiilihydraatit 20 g, joista sokereita 5 g",
      mealAdjustments: {
        portionMultiplier: 1.2,
      },
      mealDescription: "OCR-testi",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(modelCalls.length, 1);

    const callPayload = JSON.parse(modelCalls[0].options.body);
    const parts = callPayload?.contents?.[0]?.parts || [];
    const textPart = parts.find((part) => typeof part.text === "string")?.text || "";
    const imagePart = parts.find((part) => part.inlineData);

    assert.equal(Boolean(imagePart), false);
    assert.match(textPart, /ANALYYSIMENETELMÄ: OCR-TEKSTI|ANALYYSIMENETELMA: OCR-TEKSTI/);
  });
  await runCase("6) OCR toimii vaikka imageBase64 on tyhja", async () => {
    stubModelFetch();

    const response = await postAnalyze({
      imageBase64: "   ",
      ocrText: "Energia 180 kcal / 100 g, Hiilihydraatit 15 g, joista sokereita 4 g",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(modelCalls.length, 1);

    const callPayload = JSON.parse(modelCalls[0].options.body);
    const parts = callPayload?.contents?.[0]?.parts || [];
    const textPart = parts.find((part) => typeof part.text === "string")?.text || "";
    const imagePart = parts.find((part) => part.inlineData);

    assert.equal(Boolean(imagePart), false);
    assert.match(textPart, /OCR-TEKSTI/);
  });

  await runCase("7) text_estimate onnistuu ilman oikeaa kuvaa ja palauttaa totalCalories", async () => {
    stubModelFetch({
      responseText: JSON.stringify({
        name: "Hampurilainen",
        totalCalories: 780,
        confidence: "medium",
        reasoning: "Annoskerroin huomioitu.",
      }),
    });

    const response = await postAnalyze({
      mode: "text_estimate",
      ocrText: "Tuote: hampurilainen",
      mealAdjustments: {
        portionMultiplier: 1.4,
      },
      imageBase64:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2NgYGD4DwABBAEAe2fWJwAAAABJRU5ErkJggg==",
      data: {
        name: "hampurilainen",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(modelCalls.length, 1);
    assert.equal(response.body?.totalCalories, 780);
    assert.equal(response.body?.products?.[0]?.calories, 780);
    assert.match(response.body?.result || "", /kcal/i);

    const callPayload = JSON.parse(modelCalls[0].options.body);
    const parts = callPayload?.contents?.[0]?.parts || [];
    const textPart = parts.find((part) => typeof part.text === "string")?.text || "";
    const imagePart = parts.find((part) => part.inlineData);

    assert.equal(Boolean(imagePart), false);
    assert.match(textPart, /portionMultiplier: 1\.4/);
  });

  await runCase("8) text_estimate ilman ocrText -> 400", async () => {
    stubModelFetch();

    const response = await postAnalyze({
      mode: "text_estimate",
      ocrText: "   ",
      mealAdjustments: {
        portionMultiplier: 1.4,
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(modelCalls.length, 0);
    assert.equal(response.body?.error, "Invalid text estimate payload");
    assert.equal(response.body?.details, "ocrText is required for mode=text_estimate");
  });

  await runCase("9) text_estimate low confidence -> 422", async () => {
    stubModelFetch({
      responseText: JSON.stringify({
        name: "Hampurilainen",
        totalCalories: 780,
        confidence: "low",
        reasoning: "Not enough detail for a reliable calorie estimate",
      }),
    });

    const response = await postAnalyze({
      mode: "text_estimate",
      ocrText: "Tuote: hampurilainen",
      mealAdjustments: {
        portionMultiplier: 1.4,
      },
    });

    assert.equal(response.statusCode, 422);
    assert.equal(modelCalls.length, 1);
    assert.equal(response.body?.error, "Unable to estimate calories reliably");
  });
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
