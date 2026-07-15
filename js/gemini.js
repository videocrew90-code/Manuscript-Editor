const MODEL_FALLBACK_CHAIN = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
];

const ENDPOINT = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

export class GeminiError extends Error {}

function getKey() {
  return localStorage.getItem("redline_gemini_key") || "";
}

export function hasKey() {
  return Boolean(getKey());
}

export function saveKey(key) {
  localStorage.setItem("redline_gemini_key", key.trim());
}

/**
 * Sends a prompt to Gemini, falling back across models on quota/availability
 * errors, and returns the raw text response.
 */
export async function callGeminiText(prompt) {
  const key = getKey();
  if (!key) throw new GeminiError("No Gemini API key set. Add one in Settings.");

  let lastErrorMessage = "";

  for (const model of MODEL_FALLBACK_CHAIN) {
    let res;
    try {
      res = await fetch(ENDPOINT(model, key), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.5 },
        }),
      });
    } catch (networkErr) {
      lastErrorMessage = `${model}: network error (${networkErr.message})`;
      continue;
    }

    if (res.status === 429 || res.status === 404) {
      const body = await res.text().catch(() => "");
      lastErrorMessage = `${model} (${res.status}): ${body.slice(0, 200)}`;
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new GeminiError(`Gemini request failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (!text) {
      const blockReason = data?.promptFeedback?.blockReason;
      throw new GeminiError(blockReason ? `Gemini blocked the request: ${blockReason}` : "Gemini returned an empty response.");
    }
    return text;
  }

  throw new GeminiError(`All Gemini models exhausted or rate-limited. Last error: ${lastErrorMessage}`);
}

/** Same as callGeminiText, but strips markdown fences and parses JSON. */
export async function callGeminiJSON(prompt) {
  const text = await callGeminiText(prompt);
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new GeminiError("Gemini's response wasn't valid JSON. Try again.");
  }
}
