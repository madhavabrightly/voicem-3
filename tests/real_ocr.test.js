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
