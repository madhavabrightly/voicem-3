/**
 * P3 tickets 219–231: the task graph — typed nodes with dependencies, the
 * validation that must pass before execution, and the clarification gate.
 *
 *  219. Build task graph.
 *  220. Create initial task node.
 *  221. Add action nodes.
 *  222. Add observation nodes.
 *  223. Add verification nodes.
 *  224. Add recovery nodes.
 *  225. Validate task graph.
 *  229. Request clarification.
 */
export const NODE_TYPES = {
  TASK: "task",
  ACTION: "action",
  OBSERVATION: "observation",
  VERIFICATION: "verification",
  RECOVERY: "recovery",
};

export const NODE_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  SKIPPED: "skipped",
};

/** Steps that change the screen — these get verification + recovery nodes. */
export const MUTATING_STEPS = new Set(["open_app", "click", "type", "press", "scroll"]);
const OBSERVATION_STEPS = new Set(["read_screen", "wait", "find_element", "verify"]);

function stepNodeType(type) {
  if (MUTATING_STEPS.has(type)) return NODE_TYPES.ACTION;
  if (OBSERVATION_STEPS.has(type)) return NODE_TYPES.OBSERVATION;
  return NODE_TYPES.ACTION;
}

export class TaskGraph {
  constructor({ taskId = null } = {}) {
    this.taskId = taskId;
    this.nodes = [];
  }

  addNode({ id, type, step = null, dependsOn = [], ...rest }) {
    const node = {
      id,
      type,
      step,
      dependsOn: [...dependsOn],
      status: NODE_STATUS.PENDING,
      attempts: 0,
      ...rest,
    };
    this.nodes.push(node);
    return node;
  }

  /** 220. The single initial task node every other node descends from. */
  addInitialTaskNode(spec) {
    return this.addNode({
      id: "n0_task",
      type: NODE_TYPES.TASK,
      step: null,
      dependsOn: [],
      commandType: spec.commandType,
      expectedResult: spec.expectedResult,
    });
  }

  /** 221 + 222. One node per planned step (action or observation). */
  addStepNodes(steps) {
    const added = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const type = stepNodeType(step.type);
      const id = `n${i + 1}_${type}_${step.type}`;
      added.push(
        this.addNode({
          id,
          type,
          step,
          dependsOn: i === 0 ? ["n0_task"] : [added[i - 1].id],
          index: i,
          risk: step.risk,
        })
      );
    }
    return added;
  }

  /** 223. Verification nodes — one per mutating step, attached to that step. */
  addVerificationNodes(stepNodes) {
    const added = [];
    for (const node of stepNodes) {
      if (node.type !== NODE_TYPES.ACTION || !MUTATING_STEPS.has(node.step?.type)) continue;
      added.push(
        this.addNode({
          id: `v${node.index}_verification_${node.step.type}`,
          type: NODE_TYPES.VERIFICATION,
          step: { ...node.step, type: "verify" },
          dependsOn: [node.id],
          verifies: node.id,
          index: node.index,
        })
      );
    }
    return added;
  }

  /** 224. Recovery nodes — bounded retry/re-perceive for each verified step. */
  addRecoveryNodes(stepNodes, { maxRetries = 3 } = {}) {
    const added = [];
    for (const node of stepNodes) {
      if (node.type !== NODE_TYPES.ACTION || !MUTATING_STEPS.has(node.step?.type)) continue;
      added.push(
        this.addNode({
          id: `r${node.index}_recovery_${node.step.type}`,
          type: NODE_TYPES.RECOVERY,
          step: node.step,
          dependsOn: [node.id],
          recovers: node.id,
          index: node.index,
          maxRetries,
          strategy: null, // set when a recovery actually runs
        })
      );
    }
    return added;
  }

  /** 225. Validate the graph before a single action is executed. */
  validate() {
    const errors = [];
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    const roots = this.nodes.filter((n) => n.type === NODE_TYPES.TASK);

    if (roots.length !== 1) errors.push(`expected exactly one task node, found ${roots.length}`);
    if (this.nodes.length === 0) errors.push("graph has no nodes");

    // ids unique + dependencies resolvable
    if (byId.size !== this.nodes.length) errors.push("duplicate node ids");

    for (const node of this.nodes) {
      for (const dep of node.dependsOn) {
        if (!byId.has(dep)) errors.push(`node ${node.id} depends on missing node ${dep}`);
      }
    }

    // single sequential chain: at most one predecessor per step node
    for (const node of this.nodes) {
      if (node.type !== NODE_TYPES.TASK && node.dependsOn.length === 0) {
        errors.push(`node ${node.id} is unreachable (no dependency)`);
      }
    }

    // no cycles (walk up from every node)
    for (const node of this.nodes) {
      const seen = new Set([node.id]);
      let cursor = node;
      while (cursor?.dependsOn?.length === 1) {
        const next = byId.get(cursor.dependsOn[0]);
        if (!next) break;
        if (seen.has(next.id)) {
          errors.push(`cycle detected at ${next.id}`);
          break;
        }
        seen.add(next.id);
        cursor = next;
      }
    }

    // reachability from the root
    if (roots.length === 1) {
      const reachable = new Set([roots[0].id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const node of this.nodes) {
          if (reachable.has(node.id)) continue;
          if (node.dependsOn.some((d) => reachable.has(d))) {
            reachable.add(node.id);
            grew = true;
          }
        }
      }
      for (const node of this.nodes) {
        if (!reachable.has(node.id)) errors.push(`node ${node.id} is not reachable from the task node`);
      }
    }

    // every mutating action must be both verified and recoverable
    for (const node of this.nodes) {
      if (node.type !== NODE_TYPES.ACTION || !MUTATING_STEPS.has(node.step?.type)) continue;
      if (!this.nodes.some((n) => n.type === NODE_TYPES.VERIFICATION && n.verifies === node.id)) {
        errors.push(`action ${node.id} has no verification node`);
      }
      if (!this.nodes.some((n) => n.type === NODE_TYPES.RECOVERY && n.recovers === node.id)) {
        errors.push(`action ${node.id} has no recovery node`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /** The next node to execute: pending, in order, with its dependencies done. */
  nextRunnable({ skipTypes = [NODE_TYPES.VERIFICATION, NODE_TYPES.RECOVERY] } = {}) {
    const done = new Set(this.nodes.filter((n) => n.status === NODE_STATUS.DONE).map((n) => n.id));
    return (
      this.nodes.find(
        (n) =>
          n.status === NODE_STATUS.PENDING &&
          !skipTypes.includes(n.type) &&
          n.dependsOn.every((d) => done.has(d))
      ) || null
    );
  }

  getNode(id) {
    return this.nodes.find((n) => n.id === id) || null;
  }

  nodesOfType(type) {
    return this.nodes.filter((n) => n.type === type);
  }

  verificationFor(nodeId) {
    return this.nodes.find((n) => n.type === NODE_TYPES.VERIFICATION && n.verifies === nodeId) || null;
  }

  recoveryFor(nodeId) {
    return this.nodes.find((n) => n.type === NODE_TYPES.RECOVERY && n.recovers === nodeId) || null;
  }

  toJSON() {
    return {
      taskId: this.taskId,
      nodes: this.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        step: n.step ? { type: n.step.type, target: n.step.target ?? null } : null,
        dependsOn: n.dependsOn,
        status: n.status,
        attempts: n.attempts,
      })),
    };
  }
}

/**
 * 219. Build the complete task graph for a spec.
 */
export function buildTaskGraph({ taskId, spec, maxRetries = 3 }) {
  const graph = new TaskGraph({ taskId });
  graph.addInitialTaskNode(spec);
  const stepNodes = graph.addStepNodes(spec.actionSequence);
  graph.addVerificationNodes(stepNodes);
  graph.addRecoveryNodes(stepNodes, { maxRetries });
  return graph;
}

/**
 * 229. Turn detected issues into a clarification request. Only asked when a
 * task truly cannot proceed (228) — never as a conversation starter.
 */
export function buildClarification({ missing = [], ambiguous = [], impossible = null } = {}) {
  if (impossible) {
    return { needed: false, terminal: true, reason: impossible.reason, question: null, candidates: [] };
  }
  const issue = ambiguous[0] || missing[0];
  if (!issue) return { needed: false, terminal: false, question: null, candidates: [] };
  return {
    needed: true,
    terminal: false,
    field: issue.field ?? "reference",
    question: issue.question,
    candidates: issue.candidates ?? [],
  };
}
