/**
 * VoxScore — Full Cloud Backend on Cloudflare Workers + D1 + Workers AI
 * ---------------------------------------------------------------------
 * Features:
 *  - Auto-initializes & migrates D1 schema (games, voice_logs) safely on cold start
 *  - Full Game Lifecycle: Start -> Extract Players -> Edit Players -> Live Utterances -> Undo -> End
 *  - 3-Tier Waterfall Engine:
 *      Layer 1: Fast Persian Regex (0 tokens, <2ms) + Voice Undo
 *      Layer 2: External Cloud API (Auto-discovered active Gemini / Groq / GitHub Models)
 *      Layer 3: Cloudflare Workers AI Fallback (Auto-selected active Cloudflare GPU models)
 *  - Diagnostic endpoint (/api/debug-ai) to verify Layer 2 & Layer 3 live
 *  - Archive & History endpoints, Aggregated Player Career Stats & Grounded Persian Q&A
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

/* =========================================================================
 * 1. AUTO SCHEMA INITIALIZATION & SAFE MIGRATION FOR CLOUDFLARE D1
 * ========================================================================= */
let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady || !db) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        title TEXT DEFAULT 'بازی دورهمی',
        status TEXT DEFAULT 'registering_players',
        players_raw_text TEXT,
        players_json TEXT DEFAULT '[]',
        scores_json TEXT DEFAULT '{}',
        winner_json TEXT DEFAULT '[]',
        summary_text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS voice_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT DEFAULT 'default',
        raw_text TEXT NOT NULL,
        log_type TEXT DEFAULT 'gameplay',
        status TEXT DEFAULT 'pending',
        parsed_json TEXT,
        processed_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    )
    .run();

  const { results: gameCols } = await db.prepare("PRAGMA table_info(games)").all();
  const gameColNames = new Set((gameCols || []).map((c) => c.name));

  if (!gameColNames.has("title")) {
    await db.prepare("ALTER TABLE games ADD COLUMN title TEXT DEFAULT 'بازی دورهمی'").run();
  }
  if (!gameColNames.has("winner_json")) {
    await db.prepare("ALTER TABLE games ADD COLUMN winner_json TEXT DEFAULT '[]'").run();
  }
  if (!gameColNames.has("summary_text")) {
    await db.prepare("ALTER TABLE games ADD COLUMN summary_text TEXT").run();
  }

  const { results: logCols } = await db.prepare("PRAGMA table_info(voice_logs)").all();
  const logColNames = new Set((logCols || []).map((c) => c.name));

  if (!logColNames.has("log_type")) {
    await db.prepare("ALTER TABLE voice_logs ADD COLUMN log_type TEXT DEFAULT 'gameplay'").run();
  }

  await db.prepare("CREATE INDEX IF NOT EXISTS idx_voice_logs_game ON voice_logs(game_id)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_voice_logs_status ON voice_logs(status)").run();

  schemaReady = true;
}

/* =========================================================================
 * 2. PERSIAN NORMALIZATION & SPOKEN NUMBER CONVERTER
 * ========================================================================= */
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

const NUMBER_WORDS = {
  "صفر": 0, "یک": 1, "یه": 1, "دو": 2, "سه": 3, "چهار": 4, "چار": 4,
  "پنج": 5, "شش": 6, "شیش": 6, "هفت": 7, "هشت": 8, "نه": 9, "ده": 10,
  "یازده": 11, "دوازده": 12, "سیزده": 13, "چهارده": 14, "پانزده": 15,
  "پونزده": 15, "شانزده": 16, "شونزده": 16, "هفده": 17, "هجده": 18,
  "هیجده": 18, "نوزده": 19, "بیست": 20, "سی": 30, "چهل": 40,
  "پنجاه": 50, "شصت": 60, "هفتاد": 70, "هشتاد": 80, "نود": 90,
  "صد": 100, "یکصد": 100, "دویست": 200, "سیصد": 300, "چهارصد": 400,
  "پانصد": 500, "پونصد": 500, "ششصد": 600, "هفتصد": 700, "هشتصد": 800,
  "نهصد": 900, "هزار": 1000,
};

function normalizePersian(input) {
  return String(input || "")
    .trim()
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ة/g, "ه")
    .replace(/[\u200c\u00a0]/g, " ")
    .replace(/[،؛؟?!]/g, " , ")
    .replace(/\s+/g, " ")
    .trim();
}

function replaceSpokenNumbers(text) {
  const words = text.split(" ");
  const out = [];
  let i = 0;

  while (i < words.length) {
    if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, words[i])) {
      let sum = NUMBER_WORDS[words[i]];
      let j = i + 1;
      while (j < words.length) {
        if (
          words[j] === "و" &&
          j + 1 < words.length &&
          Object.prototype.hasOwnProperty.call(NUMBER_WORDS, words[j + 1])
        ) {
          sum += NUMBER_WORDS[words[j + 1]];
          j += 2;
        } else if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, words[j])) {
          sum += NUMBER_WORDS[words[j]];
          j += 1;
        } else {
          break;
        }
      }
      out.push(String(sum));
      i = j;
    } else {
      out.push(words[i]);
      i++;
    }
  }
  return out.join(" ");
}

function extractJsonObject(rawText) {
  const cleaned = String(rawText || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("LLM did not return valid JSON");
    return JSON.parse(match[0]);
  }
}

/* =========================================================================
 * 3. LAYER 1: FAST PERSIAN REGEX ENGINE (0 TOKENS, INSTANT)
 * ========================================================================= */
function isUndoIntent(rawText) {
  const norm = normalizePersian(rawText);
  return /قبلی\s*رو\s*برگردون|برگردون\s*عقب|قبلی\s*اشتباه\s*شد|آندو|پشیمون\s*شدم|\bundo\b/i.test(norm);
}

function tryParseWithRegex(rawText, players) {
  if (!Array.isArray(players) || players.length === 0) return null;

  const norm = replaceSpokenNumbers(normalizePersian(rawText));

  // Escalate complex, relational, or player-editing utterances to AI (Layer 2 / Layer 3)
  const complexIndicators =
    /نصف|دو\s*برابر|سه\s*برابر|انتقال|جابجا|جابه\s*جا|تقسیم|ضرب|درصد|اگر|شرط|بده\s*به|همه\s*بجز|بقیه|جای\s*هم|تغییر\s*بده|عوض\s*کن|حذف\s*کن|اسم\s*.*\s*بذار|بازیکن\s*جدید/;
  if (complexIndicators.test(norm)) {
    return null;
  }

  const clauses = norm
    .split(/\s*,\s*|\s+و\s+/)
    .map((c) => c.trim())
    .filter(Boolean);

  const actions = [];
  const sortedPlayers = [...players].sort((a, b) => b.length - a.length);

  for (const clause of clauses) {
    const matchedPlayer = sortedPlayers.find((p) => clause.includes(normalizePersian(p)));
    if (!matchedPlayer) continue;

    const numMatch = clause.match(/(-?\d+(?:\.\d+)?)/);
    if (!numMatch) continue;

    const value = Math.abs(parseFloat(numMatch[1]));
    if (Number.isNaN(value)) continue;

    let operation = null;
    if (/کم\s*کن|کم\s*شد|منفی|منهای|کسر|جریمه|باخت|از\s+[^\s]+\s+\d+/.test(clause)) {
      operation = "SUBTRACT";
    } else if (/بشه|مساوی|برابر\s*با|تنظیم|صفر\s*کن/.test(clause)) {
      operation = "SET";
    } else if (/اضافه|مثبت|گرفت|بده|داد|برد|امتیاز|تا/.test(clause)) {
      operation = "ADD";
    }

    if (operation) {
      actions.push({ player: matchedPlayer, operation, value });
    }
  }

  if (actions.length === 0) return null;

  return {
    is_score_event: true,
    actions,
    note: "استخراج سریع با Regex (بدون مصرف توکن)",
  };
}

function fallbackExtractNames(rawText) {
  const stopWords = new Set([
    "سلام", "خب", "ما", "من", "هستیم", "هستن", "نفریم", "نفر", "بازی",
    "میکنیم", "می", "کنیم", "اسم", "اسامی", "شرکت", "کننده", "ها",
    "بازیکن", "بازیکنان", "اینا", "این", "شامل", "با", "هم", "قراره", "توی",
  ]);

  const cleaned = normalizePersian(rawText).replace(/\d+/g, " ").replace(/،/g, " و ");
  const parts = cleaned
    .split(/\s+و\s+|,/)
    .map((chunk) =>
      chunk
        .split(" ")
        .filter((w) => w.length >= 2 && !stopWords.has(w))
        .join(" ")
        .trim()
    )
    .filter((name) => name.length >= 2);

  return [...new Set(parts)];
}

/* =========================================================================
 * 4. LAYER 2 (EXTERNAL CLOUD API) + LAYER 3 (CLOUDFLARE WORKERS AI)
 * ========================================================================= */
let cachedGeminiModel = null;
let cachedCfModel = null;

function detectCloudProvider(env) {
  if (env.GEMINI_API_KEY) return "gemini";
  if (env.GROQ_API_KEY) return "groq";
  if (env.GITHUB_TOKEN) return "github_models";
  return null;
}

async function getGeminiCandidateModels(env) {
  if (env.GEMINI_MODEL) return [env.GEMINI_MODEL.trim()];
  if (cachedGeminiModel) return [cachedGeminiModel];

  const fallbackList = [
    "gemini-2.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
  ];

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}`
    );
    if (!res.ok) return fallbackList;

    const data = await res.json();
    const available = (data.models || [])
      .filter(
        (m) =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes("generateContent")
      )
      .map((m) => String(m.name || "").replace(/^models\//, ""))
      .filter(
        (name) =>
          name.startsWith("gemini-") &&
          !/embedding|tts|image|audio|vision|robotics|computer-use|live/i.test(name) &&
          name !== "gemini-2.5-flash"
      );

    const flashModels = available.filter((n) => n.includes("flash")).sort().reverse();
    const otherModels = available.filter((n) => !n.includes("flash")).sort().reverse();
    const combined = [...new Set([...flashModels, ...otherModels, ...fallbackList])];
    return combined.slice(0, 6);
  } catch {
    return fallbackList;
  }
}

async function callExternalCloudAPI(env, systemPrompt, userPrompt) {
  if (env.GEMINI_API_KEY) {
    const candidates = await getGeminiCandidateModels(env);
    let lastError = "GEMINI_NO_MODELS";

    for (const model of candidates) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        }),
      });

      if (res.ok) {
        cachedGeminiModel = model;
        const data = await res.json();
        const rawJson = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        return extractJsonObject(rawJson);
      }

      const errText = await res.text();
      lastError = `GEMINI_${model}_HTTP_${res.status}: ${errText.slice(0, 140)}`;

      // Stop immediately on invalid API key or region block; otherwise try next active model
      if (res.status === 401 || res.status === 403) {
        break;
      }
      if (cachedGeminiModel === model) cachedGeminiModel = null;
    }

    throw new Error(lastError);
  }

  if (env.GROQ_API_KEY) {
    const model = env.GROQ_MODEL || "llama-3.3-70b-versatile";
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GROQ_HTTP_${res.status}: ${errText.slice(0, 120)}`);
    }

    const data = await res.json();
    const rawJson = data?.choices?.[0]?.message?.content || "{}";
    return extractJsonObject(rawJson);
  }

  if (env.GITHUB_TOKEN) {
    const model = env.GITHUB_MODEL || "gpt-4o-mini";
    const res = await fetch("https://models.inference.ai.azure.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GITHUB_MODELS_HTTP_${res.status}: ${errText.slice(0, 120)}`);
    }

    const data = await res.json();
    const rawJson = data?.choices?.[0]?.message?.content || "{}";
    return extractJsonObject(rawJson);
  }

  throw new Error("NO_EXTERNAL_API_KEY");
}

async function callCloudflareWorkersAI(env, systemPrompt, userPrompt) {
  if (!env.AI) {
    throw new Error("WORKERS_AI_NOT_BOUND");
  }

  const candidates = [
    env.CF_AI_MODEL,
    cachedCfModel,
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/meta/llama-4-scout-17b-16e-instruct",
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "@cf/google/gemma-3-12b-it",
    "@cf/meta/llama-3.1-8b-instruct-fast",
  ].filter((m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx);

  let lastError = "CF_AI_NO_WORKING_MODEL";

  for (const model of candidates) {
    try {
      const result = await env.AI.run(model, {
        messages: [
          {
            role: "system",
            content: `${systemPrompt}\nخروجی تو باید فقط و فقط یک آبجکت JSON معتبر و بدون متن اضافه باشد.`,
          },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 380,
      });

      const content =
        result?.choices?.[0]?.message?.content ??
        result?.response ??
        "";

      const parsed =
        typeof content === "object" && content !== null
          ? content
          : extractJsonObject(content);

      cachedCfModel = model;
      return parsed;
    } catch (err) {
      lastError = `${model}: ${err.message}`;
      if (cachedCfModel === model) cachedCfModel = null;
    }
  }

  throw new Error(lastError);
}

async function runAIWithCloudflareFallback(env, systemPrompt, userPrompt) {
  if (detectCloudProvider(env)) {
    try {
      const data = await callExternalCloudAPI(env, systemPrompt, userPrompt);
      return { data, provider: "cloud_api" };
    } catch (err) {
      console.warn("Layer 2 failed, switching to Cloudflare Workers AI:", err.message);
    }
  }

  const data = await callCloudflareWorkersAI(env, systemPrompt, userPrompt);
  return { data, provider: "cloudflare_ai" };
}

/* =========================================================================
 * 5. DETERMINISTIC SCORE ENGINE, PLAYER OPS & CAREER STATS AGGREGATION
 * ========================================================================= */
function resolveCanonicalPlayer(nameFromAI, playersList) {
  if (!nameFromAI) return null;
  const normTarget = normalizePersian(nameFromAI);
  const exact = playersList.find((p) => normalizePersian(p) === normTarget);
  if (exact) return exact;

  const partial = playersList.find(
    (p) => normalizePersian(p).includes(normTarget) || normTarget.includes(normalizePersian(p))
  );
  return partial || String(nameFromAI).trim();
}

function applyPlayerChanges(currentPlayers, currentScores, changes) {
  let players = [...(currentPlayers || [])];
  const scores = { ...(currentScores || {}) };
  let changed = false;

  if (!Array.isArray(changes) || changes.length === 0) {
    return { players, scores, changed: false };
  }

  for (const ch of changes) {
    const type = String(ch.type || "").toUpperCase();

    if (type === "RENAME") {
      const targetOld = resolveCanonicalPlayer(ch.old_name, players);
      const newName = String(ch.new_name || "").trim();
      if (targetOld && newName && players.includes(targetOld) && targetOld !== newName) {
        players = [...new Set(players.map((p) => (p === targetOld ? newName : p)))];
        const prevScore = Number(scores[targetOld]) || 0;
        delete scores[targetOld];
        scores[newName] = (Number(scores[newName]) || 0) + prevScore;
        changed = true;
      }
    } else if (type === "ADD") {
      const newName = String(ch.name || ch.new_name || "").trim();
      if (newName && !players.includes(newName)) {
        players.push(newName);
        if (scores[newName] === undefined) scores[newName] = 0;
        changed = true;
      }
    } else if (type === "REMOVE") {
      const target = resolveCanonicalPlayer(ch.name || ch.old_name, players);
      if (target && players.includes(target)) {
        players = players.filter((p) => p !== target);
        delete scores[target];
        changed = true;
      }
    }
  }

  return { players, scores, changed };
}

function applyScoreActions(currentScores, actions, playersList = []) {
  const updated = { ...(currentScores || {}) };
  if (!Array.isArray(actions)) return updated;

  for (const act of actions) {
    const player = resolveCanonicalPlayer(act.player, playersList);
    const val = Number(act.value);
    if (!player || Number.isNaN(val)) continue;

    const prev = Number(updated[player]) || 0;
    const op = String(act.operation || "").toUpperCase();

    if (op === "ADD") updated[player] = prev + val;
    else if (op === "SUBTRACT") updated[player] = prev - val;
    else if (op === "SET") updated[player] = val;

    updated[player] = Math.round((updated[player] + Number.EPSILON) * 100) / 100;
  }

  return updated;
}

async function recomputeGameScores(db, gameId, players) {
  let scores = {};
  for (const p of players) scores[p] = 0;

  const { results: activeLogs } = await db
    .prepare(
      "SELECT parsed_json FROM voice_logs WHERE game_id = ? AND log_type IN ('gameplay', 'manual') AND status = 'processed' ORDER BY id ASC"
    )
    .bind(gameId)
    .all();

  for (const row of activeLogs || []) {
    try {
      const parsed = JSON.parse(row.parsed_json || "{}");
      if (parsed.is_score_event && Array.isArray(parsed.actions)) {
        scores = applyScoreActions(scores, parsed.actions, players);
      }
    } catch {
      // skip malformed log
    }
  }

  await db
    .prepare("UPDATE games SET scores_json = ? WHERE id = ?")
    .bind(JSON.stringify(scores), gameId)
    .run();

  return scores;
}

async function undoLastScoreLog(db, gameId) {
  const game = await db.prepare("SELECT * FROM games WHERE id = ?").bind(gameId).first();
  if (!game) return { ok: false, error: "Game not found" };

  const players = JSON.parse(game.players_json || "[]");
  const { results: candidateLogs } = await db
    .prepare(
      "SELECT id, raw_text, parsed_json FROM voice_logs WHERE game_id = ? AND log_type IN ('gameplay', 'manual') AND status = 'processed' ORDER BY id DESC LIMIT 20"
    )
    .bind(gameId)
    .all();

  const targetLog = (candidateLogs || []).find((row) => {
    try {
      const p = JSON.parse(row.parsed_json || "{}");
      return p.is_score_event && Array.isArray(p.actions) && p.actions.length > 0;
    } catch {
      return false;
    }
  });

  if (!targetLog) {
    return { ok: false, error: "هیچ تغییر امتیازی برای بازگشت پیدا نشد." };
  }

  await db
    .prepare("UPDATE voice_logs SET status = 'reverted' WHERE id = ?")
    .bind(targetLog.id)
    .run();

  const scores = await recomputeGameScores(db, gameId, players);
  return { ok: true, reverted_log_id: targetLog.id, reverted_text: targetLog.raw_text, scores };
}

function computeWinners(scoresObj) {
  const entries = Object.entries(scoresObj || {});
  if (entries.length === 0) return [];
  const maxScore = Math.max(...entries.map(([, val]) => Number(val) || 0));
  return entries.filter(([, val]) => (Number(val) || 0) === maxScore).map(([name]) => name);
}

async function computeAllPlayerStats(db) {
  const { results: finishedGames } = await db
    .prepare("SELECT * FROM games WHERE status = 'finished' ORDER BY created_at DESC LIMIT 200")
    .all();

  const map = {};
  for (const g of finishedGames || []) {
    const scores = JSON.parse(g.scores_json || "{}");
    let winners = [];
    try {
      winners = JSON.parse(g.winner_json || "[]");
    } catch {
      winners = [];
    }
    if (winners.length === 0) winners = computeWinners(scores);

    for (const [name, rawScore] of Object.entries(scores)) {
      const score = Number(rawScore) || 0;
      if (!map[name]) {
        map[name] = {
          name,
          total_games: 0,
          total_wins: 0,
          total_score: 0,
          highest_score: -Infinity,
        };
      }
      map[name].total_games += 1;
      map[name].total_score += score;
      if (score > map[name].highest_score) map[name].highest_score = score;
      if (winners.includes(name)) map[name].total_wins += 1;
    }
  }

  return Object.values(map)
    .map((s) => ({
      ...s,
      highest_score: s.highest_score === -Infinity ? 0 : s.highest_score,
      win_rate: s.total_games > 0 ? Math.round((s.total_wins / s.total_games) * 100) : 0,
      avg_score: s.total_games > 0 ? Math.round((s.total_score / s.total_games) * 10) / 10 : 0,
    }))
    .sort((a, b) => b.total_wins - a.total_wins || b.win_rate - a.win_rate || b.highest_score - a.highest_score);
}

/* =========================================================================
 * 6. MAIN CLOUDFLARE WORKER ROUTER
 * ========================================================================= */
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/") && env.DB) {
      try {
        await ensureSchema(env.DB);
      } catch (err) {
        return jsonResponse({ ok: false, error: "Schema init failed: " + err.message }, 500);
      }
    }

    // 1) Health Check
    if (path === "/api/health" && request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "VoxScore Full Cloud API",
        db_connected: Boolean(env.DB),
        cloud_api_provider: detectCloudProvider(env),
        active_gemini_model: cachedGeminiModel,
        workers_ai_connected: Boolean(env.AI),
        active_cf_model: cachedCfModel,
      });
    }

    // 1.5) Diagnostic Endpoint: Live Test Layer 2 (Gemini/Cloud) & Layer 3 (Workers AI)
    if (path === "/api/debug-ai" && request.method === "GET") {
      const report = {
        cloud_api_provider: detectCloudProvider(env),
        workers_ai_bound: Boolean(env.AI),
        layer2_result: null,
        layer3_result: null,
      };

      const testSys = 'فقط این JSON را برگردان: {"ok": true}';
      const testUser = "تست";

      if (report.cloud_api_provider) {
        try {
          const data = await callExternalCloudAPI(env, testSys, testUser);
          report.layer2_result = { ok: true, model: cachedGeminiModel || "configured", data };
        } catch (err) {
          report.layer2_result = { ok: false, error: err.message };
        }
      } else {
        report.layer2_result = { ok: false, error: "کلید API خارجی تنظیم نشده است" };
      }

      if (report.workers_ai_bound) {
        try {
          const data = await callCloudflareWorkersAI(env, testSys, testUser);
          report.layer3_result = { ok: true, model: cachedCfModel, data };
        } catch (err) {
          report.layer3_result = { ok: false, error: err.message };
        }
      } else {
        report.layer3_result = { ok: false, error: "بخش ai در wrangler.jsonc متصل نیست" };
      }

      return jsonResponse(report);
    }

    // 2) Start New Game
    if (path === "/api/games/start" && request.method === "POST") {
      if (!env.DB) return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      try {
        let title = "بازی دورهمی";
        try {
          const body = await request.json();
          if (body && typeof body.title === "string" && body.title.trim()) {
            title = body.title.trim().slice(0, 60);
          }
        } catch {
          // empty body is fine
        }

        const gameId = `game_${Date.now()}`;
        await env.DB.prepare(
          "INSERT INTO games (id, title, status, players_json, scores_json, winner_json) VALUES (?, ?, 'registering_players', '[]', '{}', '[]')"
        )
          .bind(gameId, title)
          .run();

        return jsonResponse(
          { ok: true, game: { id: gameId, title, status: "registering_players" } },
          201
        );
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 3) List All Games (Archive & Active History)
    if (path === "/api/games" && request.method === "GET") {
      if (!env.DB) return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      try {
        const { results } = await env.DB.prepare(
          `SELECT g.*,
             (SELECT COUNT(*) FROM voice_logs v WHERE v.game_id = g.id) AS logs_count
           FROM games g
           ORDER BY g.created_at DESC
           LIMIT 100`
        ).all();

        const games = (results || []).map((g) => {
          const scores = JSON.parse(g.scores_json || "{}");
          let winners = [];
          try {
            winners = JSON.parse(g.winner_json || "[]");
          } catch {
            winners = [];
          }
          if (g.status === "finished" && winners.length === 0) {
            winners = computeWinners(scores);
          }
          return {
            id: g.id,
            title: g.title || "بازی دورهمی",
            status: g.status,
            players: JSON.parse(g.players_json || "[]"),
            scores,
            winners,
            summary_text: g.summary_text || "",
            logs_count: g.logs_count || 0,
            created_at: g.created_at,
            ended_at: g.ended_at,
          };
        });

        return jsonResponse({ ok: true, count: games.length, games });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 4) Register & Extract Player Names via LLM
    const playersMatch = path.match(/^\/api\/games\/([^/]+)\/players$/);
    if (playersMatch && request.method === "POST") {
      if (!env.DB) return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      const gameId = decodeURIComponent(playersMatch[1]);

      try {
        const body = await request.json();
        const rawText = (body.raw_text || "").trim();
        if (!rawText) return jsonResponse({ ok: false, error: "raw_text is required" }, 400);

        let players = [];
        let extractedBy = "heuristic_fallback";

        const systemPrompt =
          'تو استخراج‌کننده اسامی بازیکنان فارسی هستی. از متن گفتاری کاربر فقط لیست اسامی تمیز و جداگانه شرکت‌کننده‌ها را استخراج کن (حتی اگر بین دو اسم «و» گفته نشده باشد، مثل «سارا علی» که دو نفر جدا یعنی «سارا» و «علی» هستند). خروجی فقط با این فرمت JSON باشد: {"players": ["اسم۱", "اسم۲"]}';

        try {
          const { data, provider } = await runAIWithCloudflareFallback(env, systemPrompt, rawText);
          if (Array.isArray(data.players) && data.players.length > 0) {
            players = [...new Set(data.players.map((p) => String(p).trim()).filter(Boolean))];
            extractedBy = provider;
          } else {
            throw new Error("EMPTY_PLAYERS");
          }
        } catch (aiErr) {
          console.warn("AI player extraction failed, using heuristic:", aiErr.message);
          players = fallbackExtractNames(rawText);
          extractedBy = "heuristic_fallback";
        }

        if (players.length === 0) {
          return jsonResponse(
            { ok: false, error: "اسمی در متن تشخیص داده نشد. لطفاً نام شرکت‌کننده‌ها را واضح‌تر بگویید." },
            400
          );
        }

        const initialScores = {};
        for (const p of players) initialScores[p] = 0;

        await env.DB.prepare(
          "UPDATE games SET status = 'active', players_raw_text = ?, players_json = ?, scores_json = ? WHERE id = ?"
        )
          .bind(rawText, JSON.stringify(players), JSON.stringify(initialScores), gameId)
          .run();

        await env.DB.prepare(
          "INSERT INTO voice_logs (game_id, raw_text, log_type, status, parsed_json, processed_by) VALUES (?, ?, 'players_init', 'processed', ?, ?)"
        )
          .bind(gameId, rawText, JSON.stringify({ players }), extractedBy)
          .run();

        return jsonResponse({
          ok: true,
          game_id: gameId,
          players,
          scores: initialScores,
          extracted_by: extractedBy,
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 4.5) Edit / Rename / Add / Remove Players Mid-Game
    if (playersMatch && request.method === "PATCH") {
      if (!env.DB) return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      const gameId = decodeURIComponent(playersMatch[1]);

      try {
        const body = await request.json();
        const game = await env.DB.prepare("SELECT * FROM games WHERE id = ?").bind(gameId).first();
        if (!game) return jsonResponse({ ok: false, error: "Game not found" }, 404);

        let players = JSON.parse(game.players_json || "[]");
        let scores = JSON.parse(game.scores_json || "{}");
        const action = body.action;

        if (action === "rename") {
          const oldName = String(body.old_name || "").trim();
          const newName = String(body.new_name || "").trim();
          if (!oldName || !newName) {
            return jsonResponse({ ok: false, error: "نام قبلی و جدید الزامی است" }, 400);
          }
          if (!players.includes(oldName)) {
            return jsonResponse({ ok: false, error: "بازیکن قبلی پیدا نشد" }, 404);
          }
          if (oldName !== newName) {
            players = [...new Set(players.map((p) => (p === oldName ? newName : p)))];
            const oldScore = Number(scores[oldName]) || 0;
            delete scores[oldName];
            scores[newName] = (Number(scores[newName]) || 0) + oldScore;
          }
        } else if (action === "add") {
          const name = String(body.name || "").trim();
          if (!name) return jsonResponse({ ok: false, error: "نام بازیکن الزامی است" }, 400);
          if (!players.includes(name)) {
            players.push(name);
            if (scores[name] === undefined) scores[name] = 0;
          }
        } else if (action === "remove") {
          const name = String(body.name || "").trim();
          players = players.filter((p) => p !== name);
          delete scores[name];
        } else if (action === "replace_all" && Array.isArray(body.players)) {
          const nextPlayers = [...new Set(body.players.map((p) => String(p).trim()).filter(Boolean))];
          const nextScores = {};
          for (const p of nextPlayers) {
            nextScores[p] = scores[p] !== undefined ? Number(scores[p]) : 0;
          }
          players = nextPlayers;
          scores = nextScores;
        } else {
          return jsonResponse({ ok: false, error: "عملیات نامعتبر است" }, 400);
        }

        await env.DB.prepare("UPDATE games SET players_json = ?, scores_json = ? WHERE id = ?")
          .bind(JSON.stringify(players), JSON.stringify(scores), gameId)
          .run();

        return jsonResponse({ ok: true, game_id: gameId, players, scores });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 5) Gameplay Utterance (3-Tier Waterfall: Regex -> Cloud API -> Cloudflare Workers AI)
    const utteranceMatch = path.match(/^\/api\/games\/([^/]+)\/utterance$/);
    if (utteranceMatch && request.method === "POST") {
      if (!env.DB) return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      const gameId = decodeURIComponent(utteranceMatch[1]);

      try {
        const body = await request.json();
        const rawText = (body.raw_text || "").trim();
        if (!rawText) return jsonResponse({ ok: false, error: "raw_text is required" }, 400);

        const game = await env.DB.prepare("SELECT * FROM games WHERE id = ?").bind(gameId).first();
        if (!game) return jsonResponse({ ok: false, error: "Game not found" }, 404);

        let players = JSON.parse(game.players_json || "[]");
        let scores = JSON.parse(game.scores_json || "{}");

        // Handle voice Undo immediately with 0 tokens
        if (isUndoIntent(rawText)) {
          const undoRes = await undoLastScoreLog(env.DB, gameId);
          await env.DB.prepare(
            "INSERT INTO voice_logs (game_id, raw_text, log_type, status, parsed_json, processed_by) VALUES (?, ?, 'undo', 'processed', ?, 'regex')"
          )
            .bind(gameId, rawText, JSON.stringify({ undo: undoRes.ok }))
            .run();

          return jsonResponse({
            ok: true,
            is_undo: true,
            undo_result: undoRes,
            processed_by: "regex",
            players,
            scores: undoRes.ok ? undoRes.scores : scores,
          });
        }

        // Always persist raw spoken text in D1 first
        const insertRes = await env.DB.prepare(
          "INSERT INTO voice_logs (game_id, raw_text, log_type, status) VALUES (?, ?, 'gameplay', 'pending')"
        )
          .bind(gameId, rawText)
          .run();
        const logId = insertRes.meta.last_row_id;

        // Layer 1: Persian Regex (0 tokens)
        let parsed = tryParseWithRegex(rawText, players);
        let processedBy = parsed ? "regex" : null;
        let finalStatus = parsed ? "processed" : "unprocessed";

        // Layer 2 (External Cloud API) -> Layer 3 (Cloudflare Workers AI)
        if (!parsed) {
          const systemPrompt =
            'تو مفسر هوشمند امتیاز و مدیریت بازیکنان بازی‌های دورهمی فارسی هستی. بر اساس لیست بازیکنان و امتیازهای فعلی، جمله کاربر را تحلیل کن.\n' +
            '۱) اگر کاربر خواست امتیاز تغییر کند، is_score_event را true بگذار و actions را پر کن (برای انتقال/نصف/درصد مقدار عددی تغییر را با ADD و SUBTRACT دقیق حساب کن).\n' +
            '۲) اگر کاربر خواست اسم بازیکنی را تغییر دهد، بازیکن جدید اضافه کند یا حذف کند، آرایه player_changes را پر کن.\n' +
            'فرمت خروجی فقط این JSON باشد: {"is_score_event": true/false, "actions": [{"player": "نام از لیست", "operation": "ADD"|"SUBTRACT"|"SET", "value": 10}], "player_changes": [{"type": "RENAME"|"ADD"|"REMOVE", "old_name": "نام قبلی", "new_name": "نام جدید", "name": "نام برای افزودن یا حذف"}], "note": "توضیح کوتاه"}. اگر جمله ربطی به امتیاز یا تغییر بازیکن نداشت همه آرایه‌ها را [] بگذار.';

          const userPrompt = JSON.stringify({
            players,
            current_scores: scores,
            spoken_text: rawText,
          });

          try {
            const aiResult = await runAIWithCloudflareFallback(env, systemPrompt, userPrompt);
            parsed = aiResult.data;
            processedBy = aiResult.provider;
            finalStatus = "processed";
          } catch (aiErr) {
            console.warn("Both Cloud API and Cloudflare AI failed:", aiErr.message);
            parsed = null;
            processedBy = "ai_unavailable";
            finalStatus = "unprocessed";
          }
        }

        let gameDirty = false;

        if (parsed && Array.isArray(parsed.player_changes) && parsed.player_changes.length > 0) {
          const resPlayers = applyPlayerChanges(players, scores, parsed.player_changes);
          if (resPlayers.changed) {
            players = resPlayers.players;
            scores = resPlayers.scores;
            gameDirty = true;
          }
        }

        if (parsed && parsed.is_score_event && Array.isArray(parsed.actions) && parsed.actions.length > 0) {
          scores = applyScoreActions(scores, parsed.actions, players);
          gameDirty = true;
        }

        if (gameDirty) {
          await env.DB.prepare("UPDATE games SET players_json = ?, scores_json = ? WHERE id = ?")
            .bind(JSON.stringify(players), JSON.stringify(scores), gameId)
            .run();
        }

        await env.DB.prepare(
          "UPDATE voice_logs SET status = ?, parsed_json = ?, processed_by = ? WHERE id = ?"
        )
          .bind(finalStatus, parsed ? JSON.stringify(parsed) : null, processedBy, logId)
          .run();

        return jsonResponse({
          ok: true,
          log_id: logId,
          status: finalStatus,
          processed_by: processedBy,
          parsed,
          players,
          scores,
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 6) Quick Manual Score Adjustment
    const manualMatch = path.match(/^\/api\/games\/([^/]+)\/manual-score$/);
    if (manualMatch && request.method === "POST") {
      if (!env.DB) return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      const gameId = decodeURIComponent(manualMatch[1]);

      try {
        const body = await request.json();
        const player = String(body.player || "").trim();
        const delta = Number(body.delta);
        if (!player || Number.isNaN(delta) || delta === 0) {
          return jsonResponse({ ok: false, error: "Valid player and non-zero delta required" }, 400);
        }

        const game = await env.DB.prepare("SELECT * FROM games WHERE id = ?").bind(gameId).first();
        if (!game) return jsonResponse({ ok: false, error: "Game not found" }, 404);

        const players = JSON.parse(game.players_json || "[]");
        const scores = JSON.parse(game.scores_json || "{}");
        const action = {
          player,
          operation: delta > 0 ? "ADD" : "SUBTRACT",
          value: Math.abs(delta),
        };
        const parsed = {
          is_score_event: true,
          actions: [action],
          note: "تغییر دستی روی کارت بازیکن",
        };
        const updatedScores = applyScoreActions(scores, [action], players);

        await env.DB.prepare("UPDATE games SET scores_json = ? WHERE id = ?")
          .bind(JSON.stringify(updatedScores), gameId)
          .run();

        await env.DB.prepare(
          "INSERT INTO voice_logs (game_id, raw_text, log_type, status, parsed_json, processed_by) VALUES (?, ?, 'manual', 'processed', ?, 'manual')"
        )
          .bind(gameId, `تغییر دستی: ${player} (${delta > 0 ? "+" : ""}${delta})`, JSON.stringify(parsed))
          .run();

        return jsonResponse({ ok: true, scores: updatedScores });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 7) Undo Last Score Action
    const undoMatch = path.match(/^\/api\/games\/([^/]+)\/undo$/);
    if (undoMatch && request.method === "POST") {
      if (!env.DB) return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      const gameId = decodeURIComponent(undoMatch[1]);

      try {
        const result = await undoLastScoreLog(env.DB, gameId);
        return jsonResponse(result, result.ok ? 200 : 400);
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 8) End Game & Compute Final Winner Summary
    const endMatch = path.match(/^\/api\/games\/([^/]+)\/end$/);
    if (endMatch && request.method === "POST") {
      if (!env.DB) return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      const gameId = decodeURIComponent(endMatch[1]);

      try {
        const game = await env.DB.prepare("SELECT * FROM games WHERE id = ?").bind(gameId).first();
        if (!game) return jsonResponse({ ok: false, error: "Game not found" }, 404);

        const scores = JSON.parse(game.scores_json || "{}");
        const winners = computeWinners(scores);
        const maxScore =
          Object.values(scores).length > 0
            ? Math.max(...Object.values(scores).map((v) => Number(v) || 0))
            : 0;
        const summaryText =
          winners.length > 0
            ? `بازی «${game.title || "بازی دورهمی"}» با پیروزی ${winners.join(" و ")} (${maxScore} امتیاز) به پایان رسید.`
            : `بازی «${game.title || "بازی دورهمی"}» به پایان رسید.`;

        await env.DB.prepare(
          "UPDATE games SET status = 'finished', winner_json = ?, summary_text = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
          .bind(JSON.stringify(winners), summaryText, gameId)
          .run();

        const unprocessedRow = await env.DB.prepare(
          "SELECT COUNT(*) AS cnt FROM voice_logs WHERE game_id = ? AND status = 'unprocessed'"
        )
          .bind(gameId)
          .first();

        return jsonResponse({
          ok: true,
          game_id: gameId,
          title: game.title || "بازی دورهمی",
          status: "finished",
          scores,
          winners,
          summary_text: summaryText,
          unprocessed_count: unprocessedRow?.cnt || 0,
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 9) Get Single Game Details + Logs (also Delete Game)
    const singleGameMatch = path.match(/^\/api\/games\/([^/]+)$/);
    if (singleGameMatch && request.method === "GET") {
      if (!env.DB) return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      const gameId = decodeURIComponent(singleGameMatch[1]);

      try {
        const game = await env.DB.prepare("SELECT * FROM games WHERE id = ?").bind(gameId).first();
        if (!game) return jsonResponse({ ok: false, error: "Game not found" }, 404);

        const { results: logs } = await env.DB.prepare(
          "SELECT * FROM voice_logs WHERE game_id = ? ORDER BY id DESC LIMIT 150"
        )
          .bind(gameId)
          .all();

        return jsonResponse({
          ok: true,
          game_id: game.id,
          title: game.title || "بازی دورهمی",
          status: game.status,
          players: JSON.parse(game.players_json || "[]"),
          scores: JSON.parse(game.scores_json || "{}"),
          winners: JSON.parse(game.winner_json || "[]"),
          summary_text: game.summary_text || "",
          created_at: game.created_at,
          ended_at: game.ended_at,
          logs: logs || [],
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (singleGameMatch && request.method === "DELETE") {
      if (!env.DB) return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      const gameId = decodeURIComponent(singleGameMatch[1]);

      try {
        await env.DB.prepare("DELETE FROM voice_logs WHERE game_id = ?").bind(gameId).run();
        await env.DB.prepare("DELETE FROM games WHERE id = ?").bind(gameId).run();
        return jsonResponse({ ok: true, deleted_game_id: gameId });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 10) Aggregated Player Career Stats
    if (path === "/api/stats" && request.method === "GET") {
      if (!env.DB) return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      try {
        const players = await computeAllPlayerStats(env.DB);
        const totalGamesRow = await env.DB.prepare(
          "SELECT COUNT(*) AS cnt FROM games WHERE status = 'finished'"
        ).first();
        const totalLogsRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM voice_logs").first();

        return jsonResponse({
          ok: true,
          total_finished_games: totalGamesRow?.cnt || 0,
          total_voice_logs: totalLogsRow?.cnt || 0,
          players,
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 11) Smart Grounded Q&A Over Game History (D1 Stats + AI Fallback)
    if (path === "/api/ask" && request.method === "POST") {
      if (!env.DB) return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);

      try {
        const body = await request.json();
        const question = (body.question || "").trim();
        if (!question) return jsonResponse({ ok: false, error: "question is required" }, 400);

        const stats = await computeAllPlayerStats(env.DB);
        const { results: recentRaw } = await env.DB.prepare(
          "SELECT id, title, scores_json, winner_json, summary_text, created_at, ended_at FROM games WHERE status = 'finished' ORDER BY created_at DESC LIMIT 25"
        ).all();

        const recentGames = (recentRaw || []).map((g) => ({
          title: g.title || "بازی دورهمی",
          scores: JSON.parse(g.scores_json || "{}"),
          winners: JSON.parse(g.winner_json || "[]"),
          summary: g.summary_text || "",
          date: g.ended_at || g.created_at,
        }));

        if (recentGames.length === 0) {
          return jsonResponse({
            ok: true,
            answered_by: "rules",
            answer: "هنوز هیچ بازی پایان‌یافته‌ای در دیتابیس ثبت نشده است. بعد از اتمام اولین بازی می‌توانید از تاریخچه سوال بپرسید.",
          });
        }

        const normQ = normalizePersian(question);
        if (/بیشتر.*برد|بیشترین\s*برد|قهرمان\s*کل/.test(normQ) && stats.length > 0) {
          const top = stats[0];
          return jsonResponse({
            ok: true,
            answered_by: "rules",
            answer: `بر اساس آمار کل دیتابیس، «${top.name}» با ${top.total_wins} برد از ${top.total_games} بازی (نرخ برد ${top.win_rate}٪) پیشتاز است.`,
          });
        }

        if (/آخرین\s*بازی|بازی\s*قبلی/.test(normQ)) {
          const last = recentGames[0];
          const scoreList = Object.entries(last.scores)
            .map(([n, sc]) => `${n}: ${sc}`)
            .join("، ");
          return jsonResponse({
            ok: true,
            answered_by: "rules",
            answer: `آخرین بازی پایان‌یافته «${last.title}» بود. برنده: ${(last.winners || []).join(" و ") || "نامشخص"} | امتیازها: ${scoreList}.`,
          });
        }

        if (/بیشترین\s*امتیاز|رکورد|بالاترین/.test(normQ) && stats.length > 0) {
          const best = [...stats].sort((a, b) => b.highest_score - a.highest_score)[0];
          return jsonResponse({
            ok: true,
            answered_by: "rules",
            answer: `بالاترین رکورد امتیاز ثبت‌شده در یک بازی متعلق به «${best.name}» با ${best.highest_score} امتیاز است.`,
          });
        }

        try {
          const systemPrompt =
            'تو دستیار تحلیلگر تاریخچه بازی‌های VoxScore هستی. فقط و فقط بر اساس داده‌های واقعی ارائه‌شده به سوال کاربر به زبان فارسی کوتاه، دقیق و مستند پاسخ بده و هیچ عددی از خودت نساز. خروجی دقیقاً با فرمت JSON باشد: {"answer": "پاسخ فارسی تو"}';
          const userPrompt = JSON.stringify({
            question,
            player_career_stats: stats,
            recent_finished_games: recentGames.slice(0, 12),
          });
          const { data, provider } = await runAIWithCloudflareFallback(env, systemPrompt, userPrompt);
          if (data && data.answer) {
            return jsonResponse({ ok: true, answered_by: provider, answer: data.answer });
          }
        } catch (aiErr) {
          console.warn("Ask AI fallback triggered:", aiErr.message);
        }

        const matchedPlayer = stats.find((s) => normQ.includes(normalizePersian(s.name)));
        if (matchedPlayer) {
          return jsonResponse({
            ok: true,
            answered_by: "rules",
            answer: `آمار «${matchedPlayer.name}»: ${matchedPlayer.total_games} بازی، ${matchedPlayer.total_wins} برد (نرخ برد ${matchedPlayer.win_rate}٪)، میانگین امتیاز ${matchedPlayer.avg_score} و رکورد ${matchedPlayer.highest_score}.`,
          });
        }

        return jsonResponse({
          ok: true,
          answered_by: "rules",
          answer: `در کل ${recentGames.length} بازی پایان‌یافته ثبت شده است. می‌توانید نام یک بازیکن یا عباراتی مثل «بیشترین برد»، «آخرین بازی» یا «رکورد امتیاز» را بپرسید.`,
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 12) List Recent Raw Voice Logs (Debugging / Inspection)
    if (path === "/api/logs" && request.method === "GET") {
      if (!env.DB) return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      try {
        const statusFilter = url.searchParams.get("status");
        const stmt = statusFilter
          ? env.DB.prepare("SELECT * FROM voice_logs WHERE status = ? ORDER BY id DESC LIMIT 50").bind(statusFilter)
          : env.DB.prepare("SELECT * FROM voice_logs ORDER BY id DESC LIMIT 50");

        const { results } = await stmt.all();
        return jsonResponse({ ok: true, count: (results || []).length, logs: results || [] });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 13) Serve Static Frontend from ./public
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404);
  },
};