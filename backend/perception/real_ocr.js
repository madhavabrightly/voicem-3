import { ScreenModel } from "./screen_model.js";

/**
 * Real Windows OCR perception sensor.
 *
 * Drives the win-agent OCR bridge, then maps recognized text lines into the
 * semantic ScreenModel used by the orchestrator. This is where semantic
 * target resolution happens: "search box" -> element with bbox -> the tool
 * layer clicks the bbox center. No hard-coded coordinates live here — they
 * are produced per-capture from the live OCR geometry.
 */

function yCenter(l) { return l.y + Math.floor(l.h / 2); }
function xCenter(l) { return l.x + Math.floor(l.w / 2); }

function lineBoxToElement(line, type, name, extra = {}) {
  return {
    type,
    name,
    coordinates: { x: xCenter(line), y: yCenter(line) },
    bbox: { x: line.x, y: line.y, w: line.w, h: line.h },
    confidence: 0.8,
    ...extra,
  };
}

const SEARCH_RE = /search|start a new chat/i;
// Browser chrome / noise lines (Opera window frame + bookmarks + other apps)
const NOISE_RE = /^(billing|command code|madharasapattinam|assemblyai|build pc|mobile audio|rooty|onform|workspace|chatgpt|internships|epoch|welcome to|extension|live share|problems|output|debug console|terminal|ports|comments|go to calls|new call|end-to-end)/i;
const FILTER_RE = /^(all|unread|favorites|groups|contacts|messages|archived)$/i;
// Filter chips that sit on the row directly BELOW the search field.
const TAB_RE = /^(all|favorites|groups|archived|unread(\s+\d+)?)$/i;
const TIME_RE = /^\d{1,2}[/:.]\d{1,2}/;
const DATE_RE = /^(yesterday|today|friday|saturday|sunday|monday|tuesday|wednesday|thursday)$/i;

// The WhatsApp search box only ever lives in the left chat panel near the
// top of the window. Lines outside this region can never be the search box
// (taskbar "Search", browser status bar, page content, ...).
const PANEL = { left: 40, right: 620, top: 40, bottomRatio: 0.5 };
// Height of the OS/browser chrome strip at the bottom edge (taskbar ~48px,
// browser status bar) that must never yield clickable app content.
const BOTTOM_CHROME_PX = 56;
// Browser chrome strip at the TOP (tab strip + address/search bar, ~85px).
// The browser's own "Search or enter an address" bar must never be
// misresolved as the in-page WhatsApp search box.
const TOP_BROWSER_CHROME_PX = 85;
const BROWSER_PROC_RE = /opera|msedge|chrome|firefox|brave|arc|vivaldi/i;

function lineCenter(l) { return { x: l.x + l.w / 2, y: l.y + l.h / 2 }; }

/**
 * Resolve the effective screen height for region calculations. Prefer real
 * capture bounds; fall back to the lowest OCR line only when it looks like a
 * genuine full-screen capture (>= 900px), else null (no strip exclusion).
 */
function resolveScreenHeight(lines, bounds) {
  if (bounds?.height > 0) return bounds.height;
  const maxBottom = lines.reduce((m, l) => Math.max(m, l.y + l.h), 0);
  return maxBottom >= 900 ? maxBottom : null;
}

function inBottomChrome(l, screenH) {
  if (!screenH) return false;
  return lineCenter(l).y > screenH - BOTTOM_CHROME_PX;
}

function inSearchRegion(l, screenH, topChrome) {
  const c = lineCenter(l);
  if (c.x < PANEL.left || c.x > PANEL.right) return false;
  if (c.y < Math.max(PANEL.top, topChrome)) return false;
  if (screenH && c.y > screenH * PANEL.bottomRatio) return false;
  if (inBottomChrome(l, screenH)) return false;
  return true;
}

/**
 * Derive the search field's row from the filter tabs beneath it.
 *
 * Sometimes the field HAS text but the text is unreadable to OCR — a
 * selected field renders inverted, and Windows OCR returns nothing for it.
 * The field is still on screen (and still clickable), so instead of losing
 * the control we resolve its row from the tabs directly below it: the field
 * is one control row above the tabs and spans the same panel width.
 *
 * @param {object} tabLine  topmost filter tab line
 * @param {Array}  tabLines all filter tabs on that row
 * @returns {{text:string,x:number,y:number,w:number,h:number}} pseudo OCR line
 */
function searchRowFromTabs(tabLine, tabLines) {
  const rowH = Math.max(tabLine.h, 8);
  const height = Math.round(rowH * 3.5);
  const centerY = tabLine.y - Math.round(rowH * 3.5);
  const left = Math.min(...tabLines.map((l) => l.x));
  const right = Math.max(...tabLines.map((l) => l.x + l.w));
  return {
    text: "",
    x: left,
    y: centerY - Math.floor(height / 2),
    w: Math.max(right - left, 40),
    h: height,
  };
}

/**
 * Classify OCR lines into a WhatsApp web semantic model.
 *
 * WhatsApp Web layout (browser ~1920px wide, left chat panel ~x 140-540):
 *   - chat panel header (WhatsApp logo) near top
 *   - search box below it ("Search or start a new chat", or "Q <query>")
 *   - filter tabs (All/Unread/Favorites/Groups)
 *   - chat/contact rows (name at x<400, left aligned)
 * We key off *relative structure* (search line above contact rows, rows in
 * the left column) rather than fixed pixels.
 *
 * @param {Array} lines OCR lines with { text, x, y, w, h }
 * @param {{width?:number, height?:number}} [bounds] capture bounds
 * @param {object} [foreground] foreground window info ({ proc, title }) —
 *   browser-hosted WhatsApp needs the top chrome strip excluded.
 * @returns {ScreenModel}
 */
export function classifyWhatsAppScreen(lines, bounds = null, foreground = null) {
  const elements = [];
  const screenH = resolveScreenHeight(lines, bounds);
  const topChrome = foreground && BROWSER_PROC_RE.test(foreground.proc || "") ? TOP_BROWSER_CHROME_PX : 0;

  // WhatsApp logo/header line in the left panel marks the top of the app
  // ("WhatsApp" or "WhatsApp Business"; a line merely STARTING with the name
  // also counts when it sits below any browser chrome).
  const headerLine = lines.find(
    (l) => l.x < 400 && l.y < 250 && l.y >= topChrome && /^whatsapp(\s+business)?$/i.test(l.text.trim()) && !inBottomChrome(l, screenH)
  ) || lines.find(
    (l) => l.x < 400 && l.y < 250 && l.y >= topChrome && /^whatsapp\b/i.test(l.text.trim()) && !inBottomChrome(l, screenH)
  );

  // Search box: prefer the short text line directly below the WhatsApp
  // header (the input, possibly showing a query). Fall back to an explicit
  // "Search..." label — but ONLY inside the left-panel search region, so a
  // taskbar/status-bar/browser address bar "Search" label can never be
  // misresolved as the target. Last resort: the filter tabs below the field
  // anchor its row when the field's own text is unreadable to OCR.
  const tabLines = lines.filter((l) => TAB_RE.test(l.text.trim()) && l.x < PANEL.right && !inBottomChrome(l, screenH));
  const tabLine = tabLines.sort((a, b) => a.y - b.y)[0];

  const searchLine =
    (headerLine
      ? lines
          .filter((l) => l.x > 100 && l.x < 500 && l.y > headerLine.y + 10 && l.y < headerLine.y + 90 && l.text.trim().length < 30 && !inBottomChrome(l, screenH))
          .sort((a, b) => a.y - b.y)[0]
      : null) ||
    lines.find((l) => SEARCH_RE.test(l.text) && l.text.trim().length < 40 && inSearchRegion(l, screenH, topChrome)) ||
    (headerLine && tabLine ? searchRowFromTabs(tabLine, tabLines) : null);

  if (searchLine) {
    // If the search box currently holds a query (e.g. "Q Dad"), expose it so
    // type-verification can confirm the typed text landed.
    const raw = searchLine.text.trim().replace(/^q\s+/i, "");
    const hasQuery = raw.length > 0 && !/search|start a new chat/i.test(raw);
    elements.push(
      lineBoxToElement(searchLine, "search_box", hasQuery ? raw : "search_box", {
        role: "search",
        action: "click",
        query: hasQuery ? raw : "",
        // Structure-derived (text unreadable): the control is real, but its
        // content is unknown — never let this pose as a typed query.
        ...(searchLine.text ? {} : { derived: "structure" }),
      })
    );
  }

  const panelLeft = 60;
  const panelRight = 560;
  const listTop = searchLine ? searchLine.y + searchLine.h : headerLine ? headerLine.y + 80 : 200;
  for (const l of lines) {
    const t = l.text.trim();
    if (!t) continue;
    if (l.x < panelLeft || l.x > panelRight) continue; // left chat column only
    if (l.y < listTop) continue;
    if (inBottomChrome(l, screenH)) continue; // taskbar / status bar strip
    if (l.w < 20 || l.h < 8) continue; // noise
    if (NOISE_RE.test(t)) continue;
    if (FILTER_RE.test(t)) continue;
    if (/^unread\s*\d+$/i.test(t)) continue; // "Unread 21" filter tab w/ count
    if (/^\W+$/.test(t)) continue; // pure punctuation
    if (/^[.\d]+$/.test(t)) continue; // ".0." / numeric avatar noise
    if (/^•/.test(t)) continue; // bullet artifacts
    if (TIME_RE.test(t)) continue;
    if (DATE_RE.test(t)) continue;
    if (/^[+@#\d]/.test(t)) continue;
    if (t.length > 40) continue;
    if (searchLine && l === searchLine) continue;
    elements.push(lineBoxToElement(l, "contact", t, { action: "open" }));
  }

  const app = "WhatsApp";
  const screen = searchLine ? "chat_list" : "unknown";
  return new ScreenModel({
    application: app,
    screen,
    elements,
    source: "ocr",
    confidence: elements.length ? 0.85 : 0,
  });
}

/**
 * Generic (non-WhatsApp) fallback: emit OCR text lines as text elements.
 */
export function classifyGenericScreen(lines, foreground, bounds = null) {
  const app = foreground?.proc || foreground?.title || "unknown";
  const screenH = resolveScreenHeight(lines, bounds);
  const elements = lines
    .filter((l) => l.text.trim())
    .map((l) => lineBoxToElement(l, "text", l.text.trim(), {
      action: "click",
      // OS chrome (taskbar/status strip) is marked so target resolution can
      // deprioritise it in favour of real application content.
      ...(inBottomChrome(l, screenH) ? { chrome: true } : {}),
    }));
  return new ScreenModel({
    application: app,
    screen: "desktop",
    elements,
    source: "ocr",
    confidence: elements.length ? 0.7 : 0,
  });
}

/**
 * Decide which classifier to run based on the OCR text and foreground window.
 */
export function ocrLinesToModel(lines, foreground, bounds = null) {
  const joined = lines.map((l) => l.text.toLowerCase()).join(" ");
  if (foreground && /whatsapp/i.test(foreground.title || "")) {
    return classifyWhatsAppScreen(lines, bounds, foreground);
  }
  if (/whatsapp|web\.whatsapp/i.test(joined)) {
    return classifyWhatsAppScreen(lines, bounds, foreground);
  }
  return classifyGenericScreen(lines, foreground, bounds);
}
