import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWhatsAppScreen } from "../backend/perception/real_ocr.js";

test("real_ocr: classifies WhatsApp chat list with search box and contacts", () => {
  // Representative OCR lines captured from a real WhatsApp Web session.
  const lines = [
    { text: "web.whatsapp.com", x: 55, y: 48, w: 232, h: 15 },
    { text: "WhatsApp", x: 130, y: 131, w: 104, h: 20 },
    { text: "Q Dad", x: 148, y: 185, w: 55, h: 15 },
    { text: "All", x: 143, y: 232, w: 17, h: 11 },
    { text: "Unread 21", x: 194, y: 232, w: 61, h: 11 },
    { text: "Bala Dad..", x: 197, y: 330, w: 70, h: 12 },
    { text: "Mounesh Dad", x: 197, y: 417, w: 97, h: 12 },
    { text: "Muthish Dad", x: 197, y: 493, w: 88, h: 12 },
  ];
  const model = classifyWhatsAppScreen(lines);

  assert.equal(model.application, "WhatsApp");
  assert.equal(model.screen, "chat_list");
  assert.equal(model.source, "ocr");
  assert.ok(model.confidence >= 0.6);

  const search = model.find({ type: "search_box" });
  assert.equal(search.length, 1);
  assert.equal(search[0].role, "search");
  // query exposed for type verification
  assert.ok(search[0].query);

  const dads = model.find({ type: "contact", name: "Dad" });
  assert.ok(dads.length >= 1, "expected Dad contacts to be found");

  // Every element carries coordinates resolved by perception (never hard-coded).
  for (const el of model.elements) {
    assert.ok(el.coordinates?.x >= 0 && el.coordinates?.y >= 0, "element needs coordinates");
  }
});

test("real_ocr: find() resolves search_box alias", () => {
  const lines = [
    { text: "WhatsApp", x: 130, y: 131, w: 104, h: 20 },
    { text: "Search or start a new chat", x: 148, y: 185, w: 220, h: 15 },
    { text: "Bala Dad..", x: 197, y: 330, w: 70, h: 12 },
  ];
  const model = classifyWhatsAppScreen(lines);
  // Planner asks for search_box; perception typed it search_box w/ role search.
  assert.equal(model.find({ type: "search_box" }).length, 1);
  assert.equal(model.find({ name: "search_box" }).length, 1);
});

test("real_ocr: resolves the search field from the filter tabs when its text is unreadable", () => {
  // Captured from a live session where the field held a SELECTED query: Windows
  // OCR returns nothing for inverted (selected) text, so the field line is
  // missing entirely even though the control is on screen and clickable.
  const lines = [
    { text: "WhatsApp", x: 130, y: 131, w: 104, h: 20 },
    { text: "All", x: 143, y: 232, w: 17, h: 11 },
    { text: "Unread 21", x: 194, y: 232, w: 61, h: 11 },
    { text: "Favorites", x: 292, y: 232, w: 58, h: 11 },
    { text: "Groups", x: 402, y: 233, w: 45, h: 13 },
    { text: "Bala Dad..", x: 197, y: 330, w: 70, h: 12 },
    { text: "Mounesh Dad", x: 197, y: 417, w: 97, h: 12 },
  ];
  const model = classifyWhatsAppScreen(lines);

  // The app is unambiguously loaded — a missing field line must not blank the screen.
  assert.equal(model.screen, "chat_list");

  const search = model.find({ type: "search_box" });
  assert.equal(search.length, 1, "expected the field to still be resolvable");
  // Resolved from the row above the tabs, inside the left panel.
  assert.ok(search[0].coordinates.x > 140 && search[0].coordinates.x < 460, `x=${search[0].coordinates.x}`);
  assert.ok(search[0].coordinates.y > 170 && search[0].coordinates.y < 215, `y=${search[0].coordinates.y}`);
  // Content is unknown, so no query may be claimed (typing stays unverified).
  assert.equal(search[0].query, "");
});

test("real_ocr: a readable field still wins over the tab-derived row", () => {
  const lines = [
    { text: "WhatsApp", x: 130, y: 131, w: 104, h: 20 },
    { text: "Q Dad", x: 148, y: 185, w: 55, h: 15 },
    { text: "All", x: 143, y: 232, w: 17, h: 11 },
    { text: "Unread 21", x: 194, y: 232, w: 61, h: 11 },
  ];
  const model = classifyWhatsAppScreen(lines);
  const search = model.find({ type: "search_box" });
  assert.equal(search.length, 1);
  assert.equal(search[0].query, "Dad");
  assert.equal(search[0].derived, undefined);
});
