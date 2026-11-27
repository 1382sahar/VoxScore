# VoxScore-Smart Voice-Driven Board Game Scorekeeper

**VoxScore** is a 100% cloud-native web application built on **Cloudflare Workers** that automates score tracking, dynamic player management, and match history analytics for tabletop and party games (such as Mafia, Backgammon, UNO, and card games) using colloquial Persian voice commands.

---

## Key Features

* **3-Tier Waterfall AI Processing:** Combines zero-token deterministic rules (**Regex**), external cloud LLMs (**Gemini / Groq / GitHub Models**), and Cloudflare's serverless GPU inference (**Cloudflare Workers AI**).
* **Multi-Sentence & Multi-Command Speech Support:** Aggregates consecutive spoken utterances using a **1.4-second debounce buffer** and dispatches them via a **sequential queue** to prevent race conditions and score overwrites.
* **Dynamic Voice & Manual Player Management:** Extracts player names automatically at game start, and supports mid-game renaming (preserving scores), adding, or removing players via both voice commands and UI controls.
* **Deterministic Undo:** Supports voice (*"قبلی رو برگردون"* / *"Undo the last one"*) and manual rollback by marking the last valid score log as `reverted` and deterministically recomputing scores from active logs.
* **Match Archive, Career Stats, Backup & Atomic Reset:** Persists games and full utterance histories in **Cloudflare D1**, aggregates player win rates and high scores, answers natural-language questions over match history, exports JSON backups, and performs atomic database resets.

---

## Project Structure

```text
voxscore/
├── public/
│   └── index.html          # Single-page dashboard (Live Game, History Archive, Stats & Q&A)
├── src/
│   └── index.js            # Complete Cloudflare Worker backend, 3-tier engine, D1 auto-migration & APIs
├── docs/
│   └── final_proposal.md   # Technical proposal and system documentation
├── wrangler.jsonc          # Worker configuration, D1 database binding, and Workers AI binding
└── README.md               # Architecture, database schema, secrets, and deployment guide
```

---

## End-to-End Data Flow & Processing Architecture

Every spoken command flows from the browser microphone to the D1 database through **5 sequential stages**:

1. **Speech Capture, Debounce Buffering & Queueing (`public/index.html`):**
   * The browser's `Web Speech API` (`fa-IR`) transcribes live speech into text.
   * Finalized speech chunks are accumulated in `speechBuffer` rather than sent immediately. Each new phrase resets a **1400 ms** timer; once the speaker pauses, the merged utterance enters `utteranceQueue` and is sent strictly one request at a time to prevent concurrent database write conflicts.
2. **Raw Log Persistence (`POST /api/games/:id/utterance`):**
   * Before any parsing occurs, the backend inserts the raw spoken text into `voice_logs` with `status = 'pending'` so no input is lost if an upstream API times out.
   * Short undo commands (`isUndoIntent`) bypass AI completely, revert the last score-modifying log, and recompute scores immediately.
3. **Tier 1 - Strict Persian Regex Engine (0 tokens, under 2 ms):**
   * Normalizes Persian/Arabic digits and converts spoken number words (e.g., *"بیست و پنج"* → `25`).
   * Processes short (up to 12 words), single-command utterances directly with `processed_by = 'regex'`. Multi-clause, relational (transfers, halves, percentages), or player-management utterances are escalated to Tier 2.
4. **Tier 2 & Tier 3 - Cloud LLM with Automatic Workers AI Fallback:**
   * **Tier 2 (`cloud_api`):** When `GEMINI_API_KEY` (or `GROQ_API_KEY` / `GITHUB_TOKEN`) is configured, the Worker auto-discovers active text models and parses multi-sentence instructions into structured JSON actions.
   * **Tier 3 (`cloudflare_ai`):** If no external key is set or a rate-limit/network error (`429`, `5xx`) occurs, the Worker seamlessly falls back to Cloudflare's GPU binding (`env.AI`), iterating through active models (`Llama 3.3 70B`, `Llama 4 Scout`, `Mistral Small 3.1`, `Gemma 3 12B`).
5. **Deterministic State Update & UI Sync:**
   * Player mutations (`player_changes`: `RENAME`, `ADD`, `REMOVE`) are applied first so subsequent score actions in the same utterance target updated player names.
   * Score deltas (`actions`: `ADD`, `SUBTRACT`, `SET`) are applied and saved to `games`, and the corresponding `voice_logs` row is updated to `processed`.

---

## Database Schema (Cloudflare D1 - SQLite)

The Worker automatically initializes and safely migrates (`ALTER TABLE`) the schema on the first `/api/*` request.

### 1. `games` Table (Match State & Results)

```sql
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,                           -- Unique ID (e.g., game_1795496551006)
  title TEXT DEFAULT 'بازی دورهمی',              -- Custom game title
  status TEXT DEFAULT 'registering_players',     -- Lifecycle state: registering_players | active | finished
  players_raw_text TEXT,                         -- Raw spoken text from initial player registration
  players_json TEXT DEFAULT '[]',                -- JSON array of active player names
  scores_json TEXT DEFAULT '{}',                 -- JSON object mapping player names to numeric scores
  winner_json TEXT DEFAULT '[]',                 -- JSON array of final winner(s)
  summary_text TEXT,                             -- Human-readable end-of-game summary
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, -- Game creation timestamp (UTC)
  ended_at DATETIME                              -- Game completion timestamp (NULL while open/active)
);
```

* **Example `players_json`:** `["سارا", "علی", "شاهین"]`
* **Example `scores_json`:** `{"سارا": 25, "علی": 10, "شاهین": -5}`

### 2. `voice_logs` Table (Utterance & Event Audit Trail)

```sql
CREATE TABLE IF NOT EXISTS voice_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT DEFAULT 'default',                -- Foreign key referencing games.id
  raw_text TEXT NOT NULL,                        -- Raw spoken transcript or manual action description
  log_type TEXT DEFAULT 'gameplay',              -- Event type: players_init | gameplay | manual | player_edit | undo
  status TEXT DEFAULT 'pending',                 -- Processing state: pending | processed | unprocessed | reverted
  parsed_json TEXT,                              -- Structured JSON output from Regex or LLM
  processed_by TEXT,                             -- Processor: regex | cloud_api | cloudflare_ai | manual | heuristic_fallback | ai_unavailable
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_logs_game ON voice_logs(game_id);
CREATE INDEX IF NOT EXISTS idx_voice_logs_status ON voice_logs(status);
```

* **Example `parsed_json`:**
```json
{
  "is_score_event": true,
  "actions": [
    { "player": "سارا", "operation": "ADD", "value": 10 },
    { "player": "شاهین", "operation": "SUBTRACT", "value": 5 }
  ],
  "player_changes": [
    { "type": "ADD", "name": "علی" }
  ],
  "note": "افزودن ۱۰ امتیاز به سارا، کسر ۵ امتیاز از شاهین و اضافه شدن علی"
}
```

---

## Keys, Variables & Infrastructure Bindings

### 1. Cloudflare Resource Bindings (`wrangler.jsonc`)

```jsonc
{
  "name": "voxscore",
  "main": "src/index.js",
  "compatibility_date": "2026-11-01",
  "assets": {
    "directory": "./public"
  },
  "ai": {
    "binding": "AI"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "voxscore-db",
      "database_id": "YOUR_D1_DATABASE_ID"
    }
  ]
}
```

| Binding Name | Cloudflare Service | Role |
| :--- | :--- | :--- |
| `DB` | Cloudflare D1 | Persistent relational storage for `games` and `voice_logs` |
| `AI` | Cloudflare Workers AI | Serverless GPU inference for Tier 3 fallback (`env.AI.run`) |
| `ASSETS` | Static Assets | Serves the frontend dashboard from `./public` |

### 2. Encrypted Secrets (Cloudflare Dashboard)

Configure these under **Workers & Pages → Your Worker → Settings → Variables and Secrets** with type **Secret** (never commit API keys to source control):

| Secret Name | Priority | Source & Purpose |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Recommended (Primary Tier 2) | Free API key from [Google AI Studio](https://aistudio.google.com/apikey). Automatically discovers active `Flash` models enabled for your key. |
| `GROQ_API_KEY` | Optional (Alternative Tier 2) | Used for fast Llama inference if `GEMINI_API_KEY` is not set. |
| `GITHUB_TOKEN` | Optional (Alternative Tier 2) | GitHub Personal Access Token for GitHub Models (`gpt-4o-mini`). |

### 3. Optional Model Override Variables (Plaintext)

| Variable Name | Default Behavior | Description |
| :--- | :--- | :--- |
| `GEMINI_MODEL` | Auto-discovered active model | Pin a specific Gemini model (e.g., `gemini-2.5-flash-lite`) |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Override the Groq model ID |
| `GITHUB_MODEL` | `gpt-4o-mini` | Override the GitHub Models ID |
| `CF_AI_MODEL` | Auto-selected from fallback list | Pin a specific Cloudflare Workers AI model ID |

---

## API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Checks `DB` connection, active Tier 2 provider, and `Workers AI` binding |
| `GET` | `/api/debug-ai` | Runs a live diagnostic test against Tier 2 and Tier 3 and reports active model IDs or errors |
| `POST` | `/api/games/start` | Creates a new game session with an optional `title` in `registering_players` state |
| `GET` | `/api/games` | Lists the 100 most recent games with scores, winners, and log counts |
| `DELETE` | `/api/games?confirm=true` | Atomically wipes all games and logs (append `&only_finished=true` to keep active games) |
| `GET` | `/api/games/:id` | Retrieves full game metadata, scores, and up to 150 utterance logs |
| `DELETE` | `/api/games/:id` | Deletes a single game and its associated logs |
| `POST` | `/api/games/:id/players` | Extracts player names from spoken text via LLM and transitions game to `active` |
| `PATCH` | `/api/games/:id/players` | Mid-game player management (`action`: `rename` / `add` / `remove` / `replace_all`) |
| `POST` | `/api/games/:id/utterance` | Processes a spoken or typed command through the 3-tier waterfall engine |
| `POST` | `/api/games/:id/manual-score` | Applies a quick manual delta (`+1`, `+5`, `+10`, `-5`) and records an audit log |
| `POST` | `/api/games/:id/undo` | Reverts the last valid score event and deterministically recomputes scores |
| `POST` | `/api/games/:id/end` | Marks the game as `finished`, determines winner(s), and records `ended_at` |
| `GET` | `/api/stats` | Returns aggregated career statistics (games played, wins, win rate, average & high score) |
| `POST` | `/api/ask` | Answers Persian natural-language questions grounded strictly in D1 match history |

---

## Setup, Deployment & Testing

1. **Push to GitHub (triggers Cloudflare automatic build & deploy):**
   ```bash
   git add wrangler.jsonc src/index.js public/index.html README.md
   git commit -m "docs: add complete English README with schema, data flow, and API docs"
   git push
   ```
2. **Verify Infrastructure After Deployment:**
   * Open `/api/health` and confirm `db_connected: true` and `workers_ai_connected: true`.
   * Open `/api/debug-ai` to confirm live responses from both Tier 2 and Tier 3 models.
3. **Browser Compatibility:**
   * Continuous voice recognition relies on `Web Speech API`; use **Google Chrome** or **Microsoft Edge** for live microphone input.
