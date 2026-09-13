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
const TIME_RE = /^\d{1,2}[/:.]\d{1,2}/;
const DATE_RE = /^(yesterday|today|friday|saturday|sunday|monday|tuesday|wednesday|thursday)$/i;

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
 * @returns {ScreenModel}
 */
export function classifyWhatsAppScreen(lines) {
  const elements = [];

  // WhatsApp logo/header line in the left panel marks the top of the app.
  const headerLine = lines.find(
    (l) => l.x < 400 && l.y < 200 && /^whatsapp$/i.test(l.text.trim())
  );

  // Search box: either an explicit "Search..." label, or the first short
  // text line below the WhatsApp header (the input showing the query).
  const searchLine =
    lines.find((l) => SEARCH_RE.test(l.text)) ||
    (headerLine
      ? lines
          .filter((l) => l.x > 100 && l.x < 500 && l.y > headerLine.y + 10 && l.y < headerLine.y + 90 && l.text.trim().length < 30)
          .sort((a, b) => a.y - b.y)[0]
      : null);

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
export function classifyGenericScreen(lines, foreground) {
  const app = foreground?.proc || foreground?.title || "unknown";
  const elements = lines
    .filter((l) => l.text.trim())
    .map((l) => lineBoxToElement(l, "text", l.text.trim(), { action: "click" }));
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
export function ocrLinesToModel(lines, foreground) {
  const joined = lines.map((l) => l.text.toLowerCase()).join(" ");
  if (foreground && /whatsapp/i.test(foreground.title || "")) {
    return classifyWhatsAppScreen(lines);
  }
  if (/whatsapp|web\.whatsapp/i.test(joined)) {
    return classifyWhatsAppScreen(lines);
  }
  return classifyGenericScreen(lines, foreground);
}
