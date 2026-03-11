// ============================================================
// INSTABOOTH FAQ CHATBOT — BACKEND SERVER (v2)
// ============================================================
// Improved matching logic:
// - Location names (town names) get 3x weight
// - Multi-word keyword matches get 2x weight
// - Pricing questions check for event-specific FAQs first
// - Better handling of multi-topic questions
// ============================================================

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

// ---- CONFIGURATION ----
const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ---- LOCATION KEYWORDS ----
// These are specific place names that should carry heavy weight
// because if someone mentions a town, they're almost certainly
// asking about travel/delivery, not about that town's wedding prices.
const LOCATION_KEYWORDS = [
  "nipigon", "terrace bay", "schreiber", "kenora", "dryden",
  "marathon", "sioux lookout", "geraldton", "longlac",
  "winnipeg", "sault ste marie", "sudbury", "timmins",
  "wawa", "white river", "hearst", "kapuskasing",
  "fort frances", "atikokan", "red lake", "pickle lake"
];

// ---- INITIALIZE ----
const app = express();
app.use(cors());
app.use(express.json());

// ---- LOAD FAQ DATABASE ----
function loadFAQs() {
  const raw = fs.readFileSync(
    path.join(__dirname, "faq-database.json"),
    "utf-8"
  );
  return JSON.parse(raw);
}

// ---- IMPROVED KEYWORD MATCHING ----
// Smarter scoring system:
// - Standard keyword match: 1 point
// - Multi-word keyword match (e.g. "out of town"): 2 points
// - Location/town name match: 3 points (these are very specific signals)
// - Question word overlap bonus: 0.5 points
function findBestFAQMatch(userQuestion, faqData) {
  const questionLower = userQuestion.toLowerCase();
  const words = questionLower.split(/\s+/);

  // ---- STEP 1: Check for location keywords first ----
  // If someone mentions a specific town, they're asking about travel.
  // This overrides everything else.
  const mentionedLocation = LOCATION_KEYWORDS.find(loc =>
    questionLower.includes(loc)
  );

  // Also check locations in the FAQ database keywords — but ONLY actual place names,
  // not generic phrases like "how far" or "out of town" which could match other questions
  const GENERIC_TRAVEL_PHRASES = [
    "travel", "remote", "delivery", "deliver", "pickup", "rent",
    "out of town", "outside thunder bay", "self serve", "come to",
    "drive to", "how far", "far", "distance", "ship"
  ];
  const faq006 = faqData.faqs.find(f => f.id === "faq_006");
  const dbLocationMatch = faq006 ? faq006.keywords.find(kw =>
    kw.length > 4 && questionLower.includes(kw) &&
    !GENERIC_TRAVEL_PHRASES.includes(kw)
  ) : null;

  if (mentionedLocation || dbLocationMatch) {
    // Someone mentioned a specific place — return the travel FAQ
    if (faq006) {
      console.log(`[LOCATION] Detected location: "${mentionedLocation || dbLocationMatch}" — returning travel FAQ`);
      return {
        matched: true,
        isPricing: false,
        answer: faq006.answer,
        confidence: 0.95,
        faqId: faq006.id,
        faqQuestion: faq006.question,
      };
    }
  }

  // ---- STEP 2: Check for pricing questions ----
  // But FIRST check if the question also mentions a specific event type.
  // "How much does a wedding cost?" should go to FAQ 001, not the generic pricing redirect.
  const hasPricingKeyword = faqData.pricing_keywords.some(
    (keyword) => questionLower.includes(keyword)
  );

  if (hasPricingKeyword) {
    // Check if an event-specific FAQ matches too
    const eventFAQs = faqData.faqs.filter(f =>
      ["faq_001", "faq_002", "faq_003", "faq_004", "faq_005"].includes(f.id)
    );

    let bestEventMatch = null;
    let bestEventScore = 0;

    for (const faq of eventFAQs) {
      let score = 0;
      for (const keyword of faq.keywords) {
        if (questionLower.includes(keyword.toLowerCase())) {
          score += 1;
        }
      }
      if (score > bestEventScore) {
        bestEventScore = score;
        bestEventMatch = faq;
      }
    }

    // If we found a specific event type, return that FAQ (with the specific price)
    if (bestEventScore >= 1 && bestEventMatch) {
      console.log(`[PRICING+EVENT] Matched event-specific FAQ: ${bestEventMatch.id}`);
      return {
        matched: true,
        isPricing: false,
        answer: bestEventMatch.answer,
        confidence: 0.9,
        faqId: bestEventMatch.id,
        faqQuestion: bestEventMatch.question,
      };
    }

    // No specific event type detected — return generic pricing summary
    return {
      matched: true,
      isPricing: true,
      answer: faqData.pricing_redirect,
      confidence: 1.0,
      faqId: "pricing_redirect",
    };
  }

  // ---- STEP 3: General keyword matching for all other questions ----
  let bestMatch = null;
  let bestScore = 0;

  for (const faq of faqData.faqs) {
    let score = 0;

    for (const keyword of faq.keywords) {
      if (questionLower.includes(keyword.toLowerCase())) {
        // Multi-word keywords are more specific, so they get extra weight
        if (keyword.includes(" ")) {
          score += 2;
        } else {
          score += 1;
        }
      }
    }

    // Bonus: check if the user's question words appear in the FAQ question
    const faqQuestionLower = faq.question.toLowerCase();
    for (const word of words) {
      if (word.length > 3 && faqQuestionLower.includes(word)) {
        score += 0.5;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = faq;
    }
  }

  // Require at least 2 keyword hits for a confident match
  if (bestScore >= 2 && bestMatch) {
    return {
      matched: true,
      isPricing: false,
      answer: bestMatch.answer,
      confidence: Math.min(bestScore / bestMatch.keywords.length, 1.0),
      faqId: bestMatch.id,
      faqQuestion: bestMatch.question,
    };
  }

  return { matched: false, confidence: 0 };
}

// ---- CLAUDE API FALLBACK ----
// Only called when keyword matching doesn't find a confident match.
// Claude is given the ENTIRE FAQ database as context and told to ONLY
// use information from it. This prevents hallucination.
async function askClaudeWithFAQContext(userQuestion, faqData) {
  if (!ANTHROPIC_API_KEY) {
    return {
      answer: faqData.fallback_response,
      source: "fallback_no_api_key",
    };
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Build the FAQ context string
  const faqContext = faqData.faqs
    .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
    .join("\n\n");

  const systemPrompt = `You are the FAQ assistant for Instabooth, a digital photo booth rental company in Thunder Bay, Ontario. 

STRICT RULES — YOU MUST FOLLOW THESE:
1. ONLY answer using information from the FAQ database provided below. Do NOT make up information.
2. If the question is about pricing, costs, rates, packages, or fees AND mentions a specific event type, give the price for that event type from the FAQ.
3. If the question is about pricing but does NOT mention a specific event type, respond with EXACTLY: "${faqData.pricing_redirect}"
4. If you cannot confidently answer from the FAQ database, respond with EXACTLY: "${faqData.fallback_response}"
5. NEVER make promises or commitments not explicitly stated in the FAQ.
6. NEVER invent features, services, or details.
7. Keep answers concise — 2 to 5 sentences maximum.
8. Tone: Friendly, confident, professional. Think wedding-vendor energy.
9. If someone asks about availability or booking, direct them to contact us.
10. If someone mentions a specific town or location outside Thunder Bay, they are asking about travel/delivery. Use the travel FAQ to answer.

FAQ DATABASE:
${faqContext}

Remember: When in doubt, use the fallback response. It is ALWAYS better to direct someone to contact us than to make something up.`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userQuestion }],
    });

    const answer = response.content[0].text;
    return { answer, source: "claude_api" };
  } catch (error) {
    console.error("Claude API error:", error.message);
    return { answer: faqData.fallback_response, source: "fallback_api_error" };
  }
}

// ---- LOGGING SYSTEM ----
function logUnansweredQuestion(userQuestion, attemptedMatch) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    question: userQuestion,
    attemptedMatch: attemptedMatch,
  };

  const logPath = path.join(__dirname, "unanswered-questions.json");

  let logs = [];
  if (fs.existsSync(logPath)) {
    try {
      logs = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    } catch {
      logs = [];
    }
  }

  logs.push(logEntry);
  fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
  console.log(`[LOG] Unanswered question: "${userQuestion}"`);
}

// ============================================================
// API ENDPOINT
// ============================================================
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "Message is required" });
  }

  if (message.length > 500) {
    return res.status(400).json({ error: "Message too long" });
  }

  const faqData = loadFAQs();
  const userQuestion = message.trim();

  // STEP 1: Try keyword matching first (fast, free, no API call)
  const keywordMatch = findBestFAQMatch(userQuestion, faqData);

  if (keywordMatch.matched) {
    console.log(
      `[MATCH] FAQ match found: ${keywordMatch.faqId} (confidence: ${keywordMatch.confidence})`
    );
    return res.json({
      answer: keywordMatch.answer,
      source: keywordMatch.isPricing ? "pricing_redirect" : "faq_database",
      faqId: keywordMatch.faqId,
      confidence: keywordMatch.confidence,
    });
  }

  // STEP 2: No confident keyword match — ask Claude with FAQ context
  console.log(`[CLAUDE] No keyword match for: "${userQuestion}"`);
  const claudeResult = await askClaudeWithFAQContext(userQuestion, faqData);

  // STEP 3: Log the question if it wasn't a direct FAQ match
  logUnansweredQuestion(userQuestion, {
    claudeAnswer: claudeResult.answer,
    source: claudeResult.source,
  });

  return res.json({
    answer: claudeResult.answer,
    source: claudeResult.source,
    confidence: 0,
  });
});

// ---- HEALTH CHECK ----
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ---- ADMIN: View unanswered questions ----
app.get("/api/admin/unanswered", (req, res) => {
  const logPath = path.join(__dirname, "unanswered-questions.json");
  if (fs.existsSync(logPath)) {
    const logs = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    res.json(logs);
  } else {
    res.json([]);
  }
});

// ---- START SERVER ----
app.listen(PORT, () => {
  console.log(`\n🤖 Instabooth FAQ Chatbot v2 server running on port ${PORT}`);
  console.log(`   POST /api/chat          — Chat endpoint`);
  console.log(`   GET  /api/health        — Health check`);
  console.log(`   GET  /api/admin/unanswered — View unanswered questions\n`);
});
