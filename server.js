// ============================================================
// INSTABOOTH FAQ CHATBOT — BACKEND SERVER (v3)
// ============================================================
// What's new in v3:
// - Full analytics logging (every question, not just unanswered)
// - Daily usage counter
// - FAQ popularity tracking
// - /api/admin/stats endpoint for a quick summary
// - /api/admin/log endpoint for full conversation history
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

// ---- FILE PATHS ----
const FAQ_PATH = path.join(__dirname, "faq-database.json");
const ANALYTICS_PATH = path.join(__dirname, "analytics-log.json");
const UNANSWERED_PATH = path.join(__dirname, "unanswered-questions.json");

// ---- LOAD FAQ DATABASE ----
function loadFAQs() {
  const raw = fs.readFileSync(FAQ_PATH, "utf-8");
  return JSON.parse(raw);
}

// ---- ANALYTICS LOGGING ----
// Logs EVERY question with timestamp, what was asked, which FAQ matched,
// the source (faq_database, pricing_redirect, claude_api, fallback), and confidence.
function logConversation(userQuestion, result) {
  const entry = {
    timestamp: new Date().toISOString(),
    date: new Date().toISOString().split("T")[0],
    question: userQuestion,
    matchedFaqId: result.faqId || null,
    source: result.source || "unknown",
    confidence: result.confidence || 0,
  };

  let logs = [];
  if (fs.existsSync(ANALYTICS_PATH)) {
    try {
      logs = JSON.parse(fs.readFileSync(ANALYTICS_PATH, "utf-8"));
    } catch {
      logs = [];
    }
  }

  logs.push(entry);
  fs.writeFileSync(ANALYTICS_PATH, JSON.stringify(logs, null, 2));
  console.log(`[ANALYTICS] ${entry.date} | Source: ${entry.source} | FAQ: ${entry.matchedFaqId} | Q: "${userQuestion}"`);
}

// ---- UNANSWERED QUESTION LOGGING ----
function logUnansweredQuestion(userQuestion, attemptedMatch) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    question: userQuestion,
    attemptedMatch: attemptedMatch,
  };

  let logs = [];
  if (fs.existsSync(UNANSWERED_PATH)) {
    try {
      logs = JSON.parse(fs.readFileSync(UNANSWERED_PATH, "utf-8"));
    } catch {
      logs = [];
    }
  }

  logs.push(logEntry);
  fs.writeFileSync(UNANSWERED_PATH, JSON.stringify(logs, null, 2));
  console.log(`[LOG] Unanswered question: "${userQuestion}"`);
}

// ---- IMPROVED KEYWORD MATCHING ----
function findBestFAQMatch(userQuestion, faqData) {
  const questionLower = userQuestion.toLowerCase();
  const words = questionLower.split(/\s+/);

  // STEP 1: Check for location keywords first
  const mentionedLocation = LOCATION_KEYWORDS.find(loc =>
    questionLower.includes(loc)
  );

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

  // STEP 2: Check for pricing questions
  const hasPricingKeyword = faqData.pricing_keywords.some(
    (keyword) => questionLower.includes(keyword)
  );

  if (hasPricingKeyword) {
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

    return {
      matched: true,
      isPricing: true,
      answer: faqData.pricing_redirect,
      confidence: 1.0,
      faqId: "pricing_redirect",
    };
  }

  // STEP 3: General keyword matching
  let bestMatch = null;
  let bestScore = 0;

  for (const faq of faqData.faqs) {
    let score = 0;

    for (const keyword of faq.keywords) {
      if (questionLower.includes(keyword.toLowerCase())) {
        if (keyword.includes(" ")) {
          score += 2;
        } else {
          score += 1;
        }
      }
    }

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
async function askClaudeWithFAQContext(userQuestion, faqData) {
  if (!ANTHROPIC_API_KEY) {
    return {
      answer: faqData.fallback_response,
      source: "fallback_no_api_key",
    };
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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

// ============================================================
// MAIN CHAT ENDPOINT
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

  // STEP 1: Try keyword matching first
  const keywordMatch = findBestFAQMatch(userQuestion, faqData);

  if (keywordMatch.matched) {
    console.log(`[MATCH] FAQ match found: ${keywordMatch.faqId} (confidence: ${keywordMatch.confidence})`);

    // Log to analytics
    logConversation(userQuestion, {
      faqId: keywordMatch.faqId,
      source: keywordMatch.isPricing ? "pricing_redirect" : "faq_database",
      confidence: keywordMatch.confidence,
    });

    return res.json({
      answer: keywordMatch.answer,
      source: keywordMatch.isPricing ? "pricing_redirect" : "faq_database",
      faqId: keywordMatch.faqId,
      confidence: keywordMatch.confidence,
    });
  }

  // STEP 2: No confident keyword match — ask Claude
  console.log(`[CLAUDE] No keyword match for: "${userQuestion}"`);
  const claudeResult = await askClaudeWithFAQContext(userQuestion, faqData);

  // Log to analytics
  logConversation(userQuestion, {
    faqId: null,
    source: claudeResult.source,
    confidence: 0,
  });

  // Log to unanswered questions
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

// ============================================================
// ADMIN ENDPOINTS
// ============================================================

// ---- Health Check ----
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ---- View unanswered questions ----
app.get("/api/admin/unanswered", (req, res) => {
  if (fs.existsSync(UNANSWERED_PATH)) {
    const logs = JSON.parse(fs.readFileSync(UNANSWERED_PATH, "utf-8"));
    res.json(logs);
  } else {
    res.json([]);
  }
});

// ---- View full conversation log ----
app.get("/api/admin/log", (req, res) => {
  if (fs.existsSync(ANALYTICS_PATH)) {
    const logs = JSON.parse(fs.readFileSync(ANALYTICS_PATH, "utf-8"));
    res.json(logs);
  } else {
    res.json([]);
  }
});

// ---- Stats dashboard ----
// Visit: instabooth-chatbot-2-production.up.railway.app/api/admin/stats
app.get("/api/admin/stats", (req, res) => {
  if (!fs.existsSync(ANALYTICS_PATH)) {
    return res.json({
      message: "No data yet — waiting for first chatbot conversation!",
      totalQuestions: 0,
    });
  }

  const logs = JSON.parse(fs.readFileSync(ANALYTICS_PATH, "utf-8"));

  // ---- Total questions all time ----
  const totalQuestions = logs.length;

  // ---- Questions today ----
  const today = new Date().toISOString().split("T")[0];
  const todayQuestions = logs.filter(l => l.date === today).length;

  // ---- Questions by day (last 14 days) ----
  const dailyCounts = {};
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  logs.forEach(l => {
    if (new Date(l.date) >= fourteenDaysAgo) {
      dailyCounts[l.date] = (dailyCounts[l.date] || 0) + 1;
    }
  });

  // Sort by date
  const dailyUsage = Object.entries(dailyCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, questions: count }));

  // ---- Source breakdown ----
  const sourceCounts = {};
  logs.forEach(l => {
    sourceCounts[l.source] = (sourceCounts[l.source] || 0) + 1;
  });

  // ---- FAQ popularity (which FAQs get hit most) ----
  const faqCounts = {};
  logs.forEach(l => {
    if (l.matchedFaqId) {
      faqCounts[l.matchedFaqId] = (faqCounts[l.matchedFaqId] || 0) + 1;
    }
  });

  // Sort by popularity
  const faqPopularity = Object.entries(faqCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([faqId, count]) => ({ faqId, timesTriggered: count }));

  // ---- Unanswered count ----
  let unansweredCount = 0;
  if (fs.existsSync(UNANSWERED_PATH)) {
    try {
      const unanswered = JSON.parse(fs.readFileSync(UNANSWERED_PATH, "utf-8"));
      unansweredCount = unanswered.length;
    } catch {
      unansweredCount = 0;
    }
  }

  // ---- Recent questions (last 10) ----
  const recentQuestions = logs.slice(-10).reverse().map(l => ({
    time: l.timestamp,
    question: l.question,
    source: l.source,
    faqId: l.matchedFaqId,
  }));

  // ---- Build response ----
  res.json({
    summary: {
      totalQuestionsAllTime: totalQuestions,
      questionsToday: todayQuestions,
      unansweredQuestions: unansweredCount,
      faqMatchRate: totalQuestions > 0
        ? Math.round((logs.filter(l => l.source === "faq_database").length / totalQuestions) * 100) + "%"
        : "0%",
    },
    dailyUsage,
    sourceBreakdown: sourceCounts,
    faqPopularity,
    recentQuestions,
  });
});

// ---- START SERVER ----
app.listen(PORT, () => {
  console.log(`\n🤖 Instabooth FAQ Chatbot v3 server running on port ${PORT}`);
  console.log(`   POST /api/chat              — Chat endpoint`);
  console.log(`   GET  /api/health            — Health check`);
  console.log(`   GET  /api/admin/unanswered  — View unanswered questions`);
  console.log(`   GET  /api/admin/log         — Full conversation history`);
  console.log(`   GET  /api/admin/stats       — Analytics dashboard\n`);
});
