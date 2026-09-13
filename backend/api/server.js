import http from "node:http";
import { loadEnv } from "../core/env.js";
import { createPerception } from "../perception/screenai.js";
import { ToolBox } from "../tools/index.js";
import { PlatformDriver } from "../tools/platform_driver.js";
import { Orchestrator } from "../agent/orchestrator.js";
import { Memory } from "../memory/index.js";

// Load PORT/HOST/ASSEMBLYAI_* from env/.env (real env vars win) before reading them.
loadEnv();

/**
 * Builds the full agent stack (perception + tools + orchestrator + memory)
 * from injectable pieces. Used by the HTTP server and by tests/demos.
 */
export function buildAgent({ platformImpl = {}, uiaModel = null, ocrDetect = null, visionAnalyze = null, config = {} } = {}) {
  const perception = createPerception({ uiaModel, ocrDetect, visionAnalyze }, config);
  const driver = new PlatformDriver(platformImpl);
  const toolBox = new ToolBox({ driver, perception });
  const memory = new Memory();
  const orchestrator = new Orchestrator({ perception, toolBox }, config);
  return { orchestrator, memory, perception, toolBox };
}

export function createServer(deps, { port = Number(process.env.PORT || 3000), host = process.env.HOST || "127.0.0.1" } = {}) {
  const app = buildAgent(deps);
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/run") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { goal } = JSON.parse(body || "{}");
        if (!goal) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "missing goal" }));
          return;
        }
        const result = await app.orchestrator.run(goal);
        await app.memory.remember(result.task);
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
  return { server, port, host };
}

// Standalone run: `node backend/api/server.js`
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const { server, port, host } = createServer();
  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`Voice Agent API listening on http://${host}:${port}`);
  });
}
