// ============================================================
// INSTABOOTH FAQ CHATBOT — BACKEND SERVER
// ============================================================
// This is the brain of your chatbot. It:
// 1. Receives questions from the frontend widget
// 2. Searches the FAQ database for a match
// 3. If no match, asks Claude API to answer using ONLY the FAQ data
// 4. Logs unanswered questions for you to review
// ============================================================

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

// ---- CONFIGURATION ----
const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // Set this in your environment

// ---- INITIALIZE ----
const app = express();
app.use(cors()); // Allow requests from your Squarespace site
app.use(express.json());

// ---- LOAD FAQ DATABASE ----
function loadFAQs() {
  const raw = fs.readFileSync(
    path.join(__dirname, "faq-database.json"),
    "utf-8"
  );
  return JSON.parse(raw);
}

// ---- KEYWORD MATCHING ----
// This is the first line of defense — fast, local, no API call needed.
// It scores each FAQ based on how many keywords match the user's question.
function findBestFAQMatch(userQuestion, faqData) {
  const questionLower = userQuestion.toLowerCase();
  const words = questionLower.split(/\s+/);

  // Check if it's a pricing question first
  const isPricing = faqData.pricing_keywords.some(
    (keyword) => questionLower.includes(keyword)
  );
  if (isPricing) {
    return {
      matched: true,
      isPricing: true,
      answer: faqData.pricing_redirect,
      confidence: 1.0,
      faqId: "pricing_redirect",
    };
  }

  // Score each FAQ by keyword overlap
  let bestMatch = null;
  let bestScore = 0;

  for (const faq of faqData.faqs) {
    let score = 0;

    for (const keyword of faq.keywords) {
      if (questionLower.includes(keyword.toLowerCase())) {
        score += 1;
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
2. If the question is about pricing, costs, rates, packages, or fees, ALWAYS respond with EXACTLY: "${faqData.pricing_redirect}"
3. If you cannot confidently answer from the FAQ database, respond with EXACTLY: "${faqData.fallback_response}"
4. NEVER make promises or commitments not explicitly stated in the FAQ.
5. NEVER invent features, services, or details.
6. Keep answers concise — 2 to 5 sentences maximum.
7. Tone: Friendly, confident, professional. Think wedding-vendor energy.
8. If someone asks about availability or booking, direct them to contact us.

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
// Logs unanswered questions so you can review them and add new FAQs.
// Check this file weekly — it's your chatbot's "suggestion box."
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
// API ENDPOINT — This is what the frontend widget calls
// ============================================================
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "Message is required" });
  }

  // Rate limiting: basic protection (in production, use a proper rate limiter)
  // For now, just limit message length
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
// In production, protect this with authentication!
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
  console.log(`\n🤖 Instabooth FAQ Chatbot server running on port ${PORT}`);
  console.log(`   POST /api/chat          — Chat endpoint`);
  console.log(`   GET  /api/health        — Health check`);
  console.log(`   GET  /api/admin/unanswered — View unanswered questions\n`);
});
