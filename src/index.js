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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/health" && request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "VoxScore API",
        db_connected: Boolean(env.DB),
        timestamp: new Date().toISOString(),
      });
    }

    if (path === "/api/logs" && request.method === "POST") {
      if (!env.DB) {
        return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      }

      try {
        const body = await request.json();
        const rawText = typeof body.raw_text === "string" ? body.raw_text.trim() : "";
        const gameId = typeof body.game_id === "string" && body.game_id.trim() ? body.game_id.trim() : "default";

        if (!rawText) {
          return jsonResponse({ ok: false, error: "raw_text is required" }, 400);
        }

        const result = await env.DB.prepare(
          "INSERT INTO voice_logs (game_id, raw_text, status) VALUES (?, ?, 'pending')"
        )
          .bind(gameId, rawText)
          .run();

        return jsonResponse(
          {
            ok: true,
            id: result.meta.last_row_id,
            game_id: gameId,
            raw_text: rawText,
            status: "pending",
          },
          201
        );
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (path === "/api/logs" && request.method === "GET") {
      if (!env.DB) {
        return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      }

      try {
        const statusFilter = url.searchParams.get("status");
        const gameIdFilter = url.searchParams.get("game_id");
        const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
        const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);

        const conditions = [];
        const params = [];

        if (statusFilter) {
          conditions.push("status = ?");
          params.push(statusFilter);
        }

        if (gameIdFilter) {
          conditions.push("game_id = ?");
          params.push(gameIdFilter);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const orderDirection = statusFilter === "pending" ? "ASC" : "DESC";
        const query = `SELECT * FROM voice_logs ${whereClause} ORDER BY id ${orderDirection} LIMIT ?`;
        params.push(limit);

        const { results } = await env.DB.prepare(query).bind(...params).all();

        return jsonResponse({
          ok: true,
          count: results.length,
          logs: results,
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    const logIdMatch = path.match(/^\/api\/logs\/(\d+)$/);

    if (logIdMatch && request.method === "PATCH") {
      if (!env.DB) {
        return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      }

      try {
        const id = Number(logIdMatch[1]);
        const body = await request.json();
        const status = body.status || "processed";
        const parsedJson =
          body.parsed_json !== undefined
            ? typeof body.parsed_json === "string"
              ? body.parsed_json
              : JSON.stringify(body.parsed_json)
            : null;
        const processedBy = body.processed_by || "unknown";

        const result = await env.DB.prepare(
          "UPDATE voice_logs SET status = ?, parsed_json = ?, processed_by = ? WHERE id = ?"
        )
          .bind(status, parsedJson, processedBy, id)
          .run();

        if (result.meta.changes === 0) {
          return jsonResponse({ ok: false, error: "Log not found" }, 404);
        }

        return jsonResponse({
          ok: true,
          id,
          status,
          processed_by: processedBy,
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (logIdMatch && request.method === "DELETE") {
      if (!env.DB) {
        return jsonResponse({ ok: false, error: "D1 database (DB) is not bound" }, 500);
      }

      try {
        const id = Number(logIdMatch[1]);
        const result = await env.DB.prepare("DELETE FROM voice_logs WHERE id = ?")
          .bind(id)
          .run();

        if (result.meta.changes === 0) {
          return jsonResponse({ ok: false, error: "Log not found" }, 404);
        }

        return jsonResponse({ ok: true, deleted_id: id });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    if (path === "/") {
      return jsonResponse({
        ok: true,
        service: "VoxScore API",
        endpoints: [
          "GET /api/health",
          "POST /api/logs",
          "GET /api/logs",
          "PATCH /api/logs/:id",
          "DELETE /api/logs/:id",
        ],
      });
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404);
  },
};