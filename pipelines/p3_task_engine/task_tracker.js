/**
 * P3 tickets 232–243: the running task's own bookkeeping — which node it is on,
 * what has completed/failed/skipped, retries, timing, and the application/screen
 * context it is working against.
 *
 *  232. Track current node.
 *  233. Track completed nodes.
 *  234. Track failed nodes.
 *  235. Track skipped nodes.
 *  236. Track retry count.
 *  237. Track task timestamps.
 *  238. Track task duration.
 *  239. Track current application.
 *  240. Track current screen.
 *  241. Track expected screen.
 *  242. Track expected UI element.
 *  243. Track expected state.
 */
export class TaskTracker {
  /**
   * @param {object} p
   * @param {string} p.taskId
   * @param {() => number} [p.clock] injectable clock (deterministic tests)
   */
  constructor({ taskId = null, clock = () => Date.now() } = {}) {
    this.taskId = taskId;
    this.clock = clock;

    this.currentNodeId = null; // 232
    this.completed = []; // 233
    this.failed = []; // 234
    this.skipped = []; // 235
    this.retries = {}; // 236 node/step key -> count

    this.createdAt = null; // 237
    this.startedAt = null;
    this.finishedAt = null;

    this.currentApplication = null; // 239
    this.currentDocument = null; // P4
    this.currentScreen = null; // 240
    this.currentEnvironment = null; // P4
    this.currentIdentity = null; // P4
    this.screenHash = null; // P4
    this.capturedAt = null; // P4
    this.ownership = null; // P4
    this.staleness = null; // P4

    this.expectedScreen = null; // 241
    this.expectedElement = null; // 242
    this.expectedState = null; // 243
    this.expectedEnvironment = null; // P4
    this.expectedApplication = null; // P4
    this.expectedWindow = null; // P4
    this.expectedDocument = null; // P4
    this.expectedBrowser = null; // P4
    this.expectedTab = null; // P4
  }

  /** 237. Task timestamps. */
  markCreated() {
    this.createdAt = this.clock();
    return this.createdAt;
  }

  markStarted() {
    this.startedAt = this.clock();
    return this.startedAt;
  }

  markFinished() {
    this.finishedAt = this.clock();
    return this.finishedAt;
  }

  /** 238. Task duration (live value while running). */
  get durationMs() {
    if (this.startedAt === null) return 0;
    const end = this.finishedAt ?? this.clock();
    return Math.max(0, end - this.startedAt);
  }

  /** 232. Track current node. */
  setCurrentNode(nodeId) {
    this.currentNodeId = nodeId;
    return nodeId;
  }

  /** 233. Track completed nodes. */
  completeNode(nodeId) {
    this.completed.push(nodeId);
    if (this.currentNodeId === nodeId) this.currentNodeId = null;
    return this.completed.length;
  }

  /** 234. Track failed nodes. */
  failNode(nodeId, reason = "") {
    this.failed.push({ nodeId, reason });
    if (this.currentNodeId === nodeId) this.currentNodeId = null;
    return this.failed.length;
  }

  /** 235. Track skipped nodes. */
  skipNode(nodeId, reason = "") {
    this.skipped.push({ nodeId, reason });
    if (this.currentNodeId === nodeId) this.currentNodeId = null;
    return this.skipped.length;
  }

  /** 236. Track retry count (per node, plus the task total). */
  recordRetry(key) {
    this.retries[key] = (this.retries[key] || 0) + 1;
    return this.retries[key];
  }

  retriesFor(key) {
    return this.retries[key] || 0;
  }

  get totalRetries() {
    return Object.values(this.retries).reduce((sum, n) => sum + n, 0);
  }

  /** 239–240. Track the live application/screen context. */
  observeContext({
    application = null,
    document = null,
    screen = null,
    environment = null,
    identity = null,
    hash = null,
    capturedAt = null,
    ownership = null,
    staleness = null,
  } = {}) {
    if (application) this.currentApplication = application;
    if (document) this.currentDocument = document;
    if (screen) this.currentScreen = screen;
    if (environment) this.currentEnvironment = environment;
    if (identity) this.currentIdentity = identity;
    if (hash) this.screenHash = hash;
    if (capturedAt) this.capturedAt = capturedAt;
    if (ownership) this.ownership = ownership;
    if (staleness) this.staleness = staleness;
    return {
      application: this.currentApplication,
      document: this.currentDocument,
      screen: this.currentScreen,
      environment: this.currentEnvironment,
      identity: this.currentIdentity,
      hash: this.screenHash,
      capturedAt: this.capturedAt,
      ownership: this.ownership,
      staleness: this.staleness,
    };
  }

  /** 241–243. Track what the task EXPECTS to see. */
  expect({
    screen = null,
    element = null,
    state = null,
    environment = null,
    expectedApplication = null,
    application = null,
    expectedWindow = null,
    window = null,
    expectedDocument = null,
    document = null,
    expectedBrowser = null,
    browser = null,
    expectedTab = null,
    tab = null,
  } = {}) {
    if (screen) this.expectedScreen = screen;
    if (element) this.expectedElement = element;
    if (state) this.expectedState = state;
    if (environment) this.expectedEnvironment = environment;
    if (expectedApplication || application) this.expectedApplication = expectedApplication || application;
    if (expectedWindow || window) this.expectedWindow = expectedWindow || window;
    if (expectedDocument || document) this.expectedDocument = expectedDocument || document;
    if (expectedBrowser !== null || browser !== null) this.expectedBrowser = expectedBrowser ?? browser;
    if (expectedTab || tab) this.expectedTab = expectedTab || tab;

    return {
      screen: this.expectedScreen,
      element: this.expectedElement,
      state: this.expectedState,
      environment: this.expectedEnvironment,
      expectedApplication: this.expectedApplication,
      expectedWindow: this.expectedWindow,
      expectedDocument: this.expectedDocument,
      expectedBrowser: this.expectedBrowser,
      expectedTab: this.expectedTab,
    };
  }

  toJSON() {
    return {
      taskId: this.taskId,
      currentNodeId: this.currentNodeId,
      completed: [...this.completed],
      failed: this.failed.map((f) => ({ ...f })),
      skipped: this.skipped.map((s) => ({ ...s })),
      retries: { ...this.retries },
      totalRetries: this.totalRetries,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationMs: this.durationMs,
      currentApplication: this.currentApplication,
      currentDocument: this.currentDocument,
      currentScreen: this.currentScreen,
      currentEnvironment: this.currentEnvironment,
      currentIdentity: this.currentIdentity,
      screenHash: this.screenHash,
      capturedAt: this.capturedAt,
      ownership: this.ownership,
      staleness: this.staleness,
      expectedScreen: this.expectedScreen,
      expectedElement: this.expectedElement,
      expectedState: this.expectedState,
      expectedEnvironment: this.expectedEnvironment,
      expectedApplication: this.expectedApplication,
      expectedWindow: this.expectedWindow,
      expectedDocument: this.expectedDocument,
      expectedBrowser: this.expectedBrowser,
      expectedTab: this.expectedTab,
    };
  }

  /** 296. Task state persistence — restore an exported snapshot. */
  static fromJSON(snapshot, { clock = () => Date.now() } = {}) {
    const tracker = new TaskTracker({ taskId: snapshot?.taskId ?? null, clock });
    if (!snapshot) return tracker;
    tracker.currentNodeId = snapshot.currentNodeId ?? null;
    tracker.completed = [...(snapshot.completed || [])];
    tracker.failed = (snapshot.failed || []).map((f) => ({ ...f }));
    tracker.skipped = (snapshot.skipped || []).map((s) => ({ ...s }));
    tracker.retries = { ...(snapshot.retries || {}) };
    tracker.createdAt = snapshot.createdAt ?? null;
    tracker.startedAt = snapshot.startedAt ?? null;
    tracker.finishedAt = snapshot.finishedAt ?? null;
    tracker.currentApplication = snapshot.currentApplication ?? null;
    tracker.currentDocument = snapshot.currentDocument ?? null;
    tracker.currentScreen = snapshot.currentScreen ?? null;
    tracker.currentEnvironment = snapshot.currentEnvironment ?? null;
    tracker.currentIdentity = snapshot.currentIdentity ?? null;
    tracker.screenHash = snapshot.screenHash ?? null;
    tracker.capturedAt = snapshot.capturedAt ?? null;
    tracker.ownership = snapshot.ownership ?? null;
    tracker.staleness = snapshot.staleness ?? null;
    tracker.expectedScreen = snapshot.expectedScreen ?? null;
    tracker.expectedElement = snapshot.expectedElement ?? null;
    tracker.expectedState = snapshot.expectedState ?? null;
    tracker.expectedEnvironment = snapshot.expectedEnvironment ?? null;
    tracker.expectedApplication = snapshot.expectedApplication ?? null;
    tracker.expectedWindow = snapshot.expectedWindow ?? null;
    tracker.expectedDocument = snapshot.expectedDocument ?? null;
    tracker.expectedBrowser = snapshot.expectedBrowser ?? null;
    tracker.expectedTab = snapshot.expectedTab ?? null;
    return tracker;
  }
}
