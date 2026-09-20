/**
 * P4 Tickets 303–306, 357: Environment Probe & Active Window/Process Detection
 *
 *  303. Detect active window.
 *  304. Detect active process.
 *  305. Detect active application.
 *  306. Detect foreground window title.
 *  357. Store screen timestamp.
 */

import { computeCaptureHash } from "./capture.js";

/**
 * Normalizes a raw process name or window title to a canonical application name.
 */
export function sanitizeApplicationName(procName = "", title = "") {
  const p = String(procName || "").toLowerCase();
  const t = String(title || "").toLowerCase();

  const isSearchOrDoc = /duckduckgo|google search|bing search|\bat duckduckgo\b|\bat google\b|\b(status at|faq|help center|support|news|blog)\b/i.test(t);

  // WhatsApp in browser vs native
  if (t.includes("whatsapp") && !isSearchOrDoc) {
    if (/opera|chrome|msedge|firefox|brave|arc|vivaldi/i.test(p)) {
      return "WhatsApp Web";
    }
    return "WhatsApp";
  }
  if (p.includes("whatsapp")) {
    return "WhatsApp";
  }

  // Explicit known desktop applications
  if (p.includes("code")) return "Visual Studio Code";
  if (p.includes("explorer")) return "Windows Explorer";
  if (p.includes("notepad")) return "Notepad";
  if (p.includes("calc")) return "Calculator";
  if (p.includes("opera")) return "Opera";
  if (p.includes("chrome")) return "Google Chrome";
  if (p.includes("msedge") || p.includes("edge")) return "Microsoft Edge";
  if (p.includes("firefox")) return "Mozilla Firefox";
  if (p.includes("brave")) return "Brave";

  if (procName) return procName;
  if (title) return title.split(" - ").at(-1)?.trim() || title;
  return "unknown";
}

export class EnvironmentProbe {
  /**
   * @param {object} [driver] Driver providing foreground() or window discovery
   * @param {() => number} [clock]
   */
  constructor({ driver = null, clock = () => Date.now() } = {}) {
    this.driver = driver;
    this.clock = clock;
  }

  /**
   * 303–306. Probe foreground window, process, and application.
   * @returns {Promise<EnvironmentSnapshot>}
   */
  async probe() {
    const timestamp = this.clock();
    let fg = null;

    if (this.driver && typeof this.driver.foreground === "function") {
      try {
        fg = await this.driver.foreground();
      } catch {
        fg = null;
      }
    }

    const hwnd = fg?.hwnd || "0x0";
    const pid = fg?.pid || 0;
    const proc = fg?.proc || "unknown";
    const title = fg?.title || "";
    const className = fg?.class || "";
    const bounds = fg?.bounds || null;
    const activeApplication = sanitizeApplicationName(proc, title);

    const envHash = computeCaptureHash({ hwnd, pid, proc, title, className });

    return {
      hwnd,
      pid,
      proc,
      title,
      class: className,
      bounds,
      timestamp,
      activeApplication,
      hash: envHash,
      isBrowser: /opera|chrome|msedge|firefox|brave|arc|vivaldi/i.test(proc),
      raw: fg,
    };
  }
}
