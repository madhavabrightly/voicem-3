/**
 * P4 Tickets 336, 383: Browser Target & Selected Tab Resolution
 *
 *  336. Detect browser controls.
 *  383. Detect browser state.
 *
 * Browser targeting priority:
 *   1. UIA TabItem + IsSelected first.
 *   2. Correlate selected tab with browser window title.
 *   3. CDP (Chrome DevTools Protocol) only as optional accelerator.
 *   4. If identity cannot be proven, return UNKNOWN rather than inventing it.
 */

export const KNOWN_BROWSER_PROCESSES = new Set([
  "opera",
  "chrome",
  "msedge",
  "firefox",
  "brave",
  "arc",
  "vivaldi",
  "browser",
]);

/**
 * Inspect whether a process name represents a web browser.
 */
export function isBrowserProcess(procName = "") {
  const p = String(procName || "").toLowerCase().replace(/\.exe$/, "");
  return KNOWN_BROWSER_PROCESSES.has(p) || [...KNOWN_BROWSER_PROCESSES].some((b) => p.includes(b));
}

/**
 * Extract document / page title from a browser window title.
 * e.g. "whatsapp status at DuckDuckGo - Opera" -> { document: "whatsapp status at DuckDuckGo", engine: "DuckDuckGo", browser: "Opera" }
 * e.g. "(12) WhatsApp - Google Chrome" -> { document: "WhatsApp", unread: 12, browser: "Google Chrome" }
 */
export function parseBrowserWindowTitle(title = "") {
  if (!title) return { document: "", browser: "", isSearchEngine: false, searchEngine: null };
  const parts = title.split(/\s+[-—]\s+/);
  const browser = parts.length > 1 ? parts.at(-1).trim() : "";
  const mainTitle = (parts.length > 1 ? parts.slice(0, -1).join(" - ") : title).trim();

  // Clean unread count badge e.g. "(3) WhatsApp" -> "WhatsApp"
  const cleanTitle = mainTitle.replace(/^\(\d+\)\s*/, "").trim();

  // Detect search engines on the main document title (NOT the trailing browser name like "- Google Chrome")
  const isDuckDuckGo = /duckduckgo/i.test(mainTitle);
  const isGoogle = /^google(\s+search)?$/i.test(cleanTitle) || /google search/i.test(mainTitle);
  const isBing = /^bing(\s+search)?$/i.test(cleanTitle) || /bing search/i.test(mainTitle);

  let searchEngine = null;
  if (isDuckDuckGo) searchEngine = "DuckDuckGo";
  else if (isGoogle) searchEngine = "Google";
  else if (isBing) searchEngine = "Bing";

  return {
    rawTitle: title,
    cleanDocumentTitle: cleanTitle,
    browser,
    isSearchEngine: Boolean(searchEngine),
    searchEngine,
  };
}

export class BrowserTargetResolver {
  /**
   * @param {object} [opts]
   * @param {object} [opts.cdp] Optional CDP accelerator client
   */
  constructor({ cdp = null } = {}) {
    this.cdp = cdp;
  }

  /**
   * 336, 383. Resolve selected browser tab and document identity from UIA elements,
   * environment, and optional CDP.
   *
   * @param {object} p
   * @param {object} p.environment EnvironmentSnapshot
   * @param {Array<object>} [p.uiaElements] Raw or mapped UIA elements
   * @returns {Promise<BrowserTargetResult>}
   */
  async resolveBrowserTarget({ environment, uiaElements = [] } = {}) {
    if (!environment || !isBrowserProcess(environment.proc)) {
      return {
        isBrowser: false,
        activeTab: null,
        tabs: [],
        documentIdentity: null,
        proven: false,
      };
    }

    const titleInfo = parseBrowserWindowTitle(environment.title);
    const tabs = [];

    // Step 1: Scan UIA elements for TabItems and SelectionItem pattern
    const tabElements = (uiaElements || []).filter(
      (el) => el.role === "tabitem" || el.role === "tab" || el.type === "tab" || el.role === "page tab"
    );

    for (const el of tabElements) {
      const isSelected = Boolean(
        el.isSelected ||
        el.selected ||
        el.state?.includes?.("selected") ||
        el.states?.includes?.("selected") ||
        (el.name && titleInfo.cleanDocumentTitle && el.name.toLowerCase().includes(titleInfo.cleanDocumentTitle.toLowerCase()))
      );

      tabs.push({
        name: el.name || el.label || "",
        isSelected,
        bounds: el.bbox || el.bounds || null,
        element: el,
      });
    }

    // Identify active tab: prefer explicit isSelected === true
    let activeTab = tabs.find((t) => t.isSelected) || null;

    // Step 2: Correlate with browser window title
    if (!activeTab && titleInfo.cleanDocumentTitle) {
      // Find tab matching window title
      activeTab = tabs.find((t) => t.name.toLowerCase().includes(titleInfo.cleanDocumentTitle.toLowerCase())) || null;
    }

    // Step 3: Optional CDP accelerator
    if (!activeTab && this.cdp && typeof this.cdp.getActiveTab === "function") {
      try {
        const cdpTab = await this.cdp.getActiveTab();
        if (cdpTab) {
          activeTab = {
            name: cdpTab.title || "",
            url: cdpTab.url || "",
            isSelected: true,
            source: "cdp",
          };
        }
      } catch {
        // CDP failed or unavailable, fallback to UIA / window title
      }
    }

    // Step 4: Determine document identity
    let documentIdentity = null;
    let proven = false;

    if (activeTab) {
      documentIdentity = activeTab.name || titleInfo.cleanDocumentTitle;
      proven = true;
    } else if (titleInfo.cleanDocumentTitle) {
      documentIdentity = titleInfo.cleanDocumentTitle;
      // Window title alone without tab confirmation is SUPPORTED, not independently PROVEN
      proven = false;
    }

    return {
      isBrowser: true,
      browserName: titleInfo.browser || environment.proc,
      activeTab,
      tabs,
      documentIdentity,
      titleInfo,
      proven,
    };
  }
}
