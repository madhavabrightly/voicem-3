/**
 * Extract / fetch the OCR model artifacts used by the PaddleOCR ONNX engine.
 *
 * Sources:
 *   - ONNX models (det + rec): copied from the Screen-AI checkout when present,
 *     otherwise downloaded from the Hugging Face repo they originate from.
 *   - CTC dictionary + config: downloaded from the same Hugging Face repo.
 *
 * Run: node scripts/fetch-ocr-models.mjs
 * Env: SCREEN_AI_DIR override for the Screen-AI checkout path.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(HERE, "../backend/perception/models");
const SCREEN_AI_DIR =
  process.env.SCREEN_AI_DIR || "C:/Users/brigh/Desktop/trying_new/Screen-AI/ai_pc_operator/data/models";
const HF_BASE = "https://huggingface.co/monkt/paddleocr-onnx/resolve/main";

const ARTIFACTS = [
  {
    file: "ocr_det_v3.onnx",
    fromScreenAi: true,
    url: `${HF_BASE}/detection/v3/det.onnx`,
    role: "PP-OCR DB text-region detector",
  },
  {
    file: "ocr_rec_english.onnx",
    fromScreenAi: true,
    url: `${HF_BASE}/languages/english/rec.onnx`,
    role: "PP-OCRv5 English CTC text recognizer (438 classes)",
  },
  {
    file: "ocr_rec_dict.txt",
    fromScreenAi: false,
    url: `${HF_BASE}/languages/english/dict.txt`,
    role: "CTC character dictionary (one character per line)",
  },
  {
    file: "ocr_rec_config.json",
    fromScreenAi: false,
    url: `${HF_BASE}/languages/english/config.json`,
    role: "Model card / preprocessing notes",
  },
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function download(url, target) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(target, buf);
  return buf.length;
}

async function main() {
  mkdirSync(MODELS_DIR, { recursive: true });
  const records = [];

  for (const art of ARTIFACTS) {
    const target = join(MODELS_DIR, art.file);
    let status = "present";

    if (!existsSync(target)) {
      const from = join(SCREEN_AI_DIR, art.file);
      if (art.fromScreenAi && existsSync(from)) {
        copyFileSync(from, target);
        status = "copied";
      } else {
        await download(art.url, target);
        status = "downloaded";
      }
    }

    records.push({
      file: art.file,
      role: art.role,
      status,
      bytes: statSync(target).size,
      sha256: sha256(target),
      source: art.fromScreenAi ? SCREEN_AI_DIR : art.url,
      url: art.url,
    });
    console.log(`[ocr-models] ${art.file}: ${status} (${(statSync(target).size / 1024).toFixed(1)} KB)`);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    modelDir: MODELS_DIR,
    notes: [
      "PaddleOCR ONNX det+rec extracted from Screen-AI; dictionary from monkt/paddleocr-onnx.",
      "Rec model output is N x T x 438 (CTC); dictionary has one character per line.",
    ],
    records,
  };
  writeFileSync(join(MODELS_DIR, "models_manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[ocr-models] manifest -> ${join(MODELS_DIR, "models_manifest.json")}`);
}

main().catch((err) => {
  console.error(`[ocr-models:error] ${err?.message || err}`);
  process.exit(1);
});
