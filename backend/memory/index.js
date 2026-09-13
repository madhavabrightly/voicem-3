import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEM_DIR = path.resolve(__dirname, "../../memory");

/**
 * Rota memory store for the MVP: persists task/goal outcomes (goal -> result)
 * so the agent can later learn / recover across runs. Deliberately minimal —
 * no prediction or "dream mode" yet, per MVP scope.
 */
export class Memory {
  constructor(dir = MEM_DIR) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "tasks.jsonl");
  }

  async remember(task) {
    const line = JSON.stringify({
      id: task.id,
      goal: task.goal,
      status: task.status,
      steps: task.steps,
      updatedAt: task.updatedAt,
    });
    fs.appendFileSync(this.file, line + "\n");
    return task.id;
  }

  async recall(goal) {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    const matches = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((x) => x && x.goal === goal);
    return matches;
  }

  clear() {
    if (fs.existsSync(this.file)) fs.rmSync(this.file);
  }
}