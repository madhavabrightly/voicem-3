# Real OCR + UIA Perception

This document describes the **real** screen-perception upgrade extracted from the
`Screen-AI` project: a local PaddleOCR ONNX text engine and a real Windows UI
Automation scanner. Both are additive — the existing Windows.Media.Ocr semantic
sensor and all agent behaviour are unchanged.

```
PNG screenshot
   -> DB text detector   (ocr_det_v3.onnx)      -> text regions
   -> CTC recognizer     (ocr_rec_english.onnx) -> text strings
   -> { text, x, y, w, h, confidence }
   -> existing semantic mapping (real_ocr.js)   -> ScreenModel
```

## Extracted assets

| File | Origin | Role |
|---|---|---|
| `backend/perception/models/ocr_det_v3.onnx` | Screen-AI (`ai_pc_operator/data/models`) | PP-OCR DB text-region detector |
| `backend/perception/models/ocr_rec_english.onnx` | Screen-AI | PP-OCRv5 English CTC recognizer |
| `backend/perception/models/ocr_rec_dict.txt` | `monkt/paddleocr-onnx` (Hugging Face) | 436-character dictionary |
| `backend/perception/models/ocr_rec_config.json` | same | Model card / preprocessing notes |
| `backend/tools/win/uia_scan.ps1` | Screen-AI (`screen_element_scanner`) | Windows UIA element scanner |

Regenerate / re-fetch everything with:

```bash
node scripts/fetch-ocr-models.mjs
```

(The script copies the ONNX files from a local Screen-AI checkout when present,
otherwise downloads them from Hugging Face. `SCREEN_AI_DIR` overrides the path.)

## Model I/O

| Model | Input | Output | Notes |
|---|---|---|---|
| `ocr_det_v3.onnx` | `x` `[N,3,H,W]` f32 | `fetch_name_0` `[N,1,H,W]` | per-pixel text probability map |
| `ocr_rec_english.onnx` | `x` `[N,3,48,W]` f32 | `fetch_name_0` `[N,T,438]` | softmax over 438 classes |

- Detector preprocessing: resize so both sides are multiples of 32 (longest side
  ≤ 960), `scale=1/255`, ImageNet mean/std, **BGR** channel order (PaddleOCR reads
  with OpenCV).
- Recognizer preprocessing: crop region, resize to height 48, normalise
  `(x/255 - 0.5) / 0.5`, BGR.

### CTC dictionary mapping

PaddleOCR convention, verified against the shipped artifacts:

```
class 0        -> blank (dropped)
class 1..436   -> dict[i-1]
class 437      -> space
```

so `num_classes (438) === dict.length (436) + blank + space`. The decoder warns
loudly if a model ever disagrees with the dictionary.

### Detector post-processing

PaddleOCR's reference post-process uses OpenCV contours + rotated min-area rects
+ Vatti-clip unclip. To keep the engine dependency-free in Node, this project
uses a **documented simplification** adequate for horizontal UI text:

```
threshold (0.3) -> 8-connected components -> axis-aligned box
                -> area/perimeter unclip (1.6) -> group into text lines
```

## Sensors and priority

`backend/real_agent.js` builds the real perception stack. Sensors are tried in
order and the first result at or above the confidence threshold (0.6) wins:

1. `RealOcrSensor` — Windows.Media.Ocr semantic sensor (**unchanged primary**).
2. `PaddleOcrSensor` — this local ONNX engine (works without a language pack).
3. `RealUiaSensor` — real Windows UI Automation tree (`uia_scan.ps1`).

> Why the proven Windows-OCR sensor stays first: UIA does not expose browser web
> content (e.g. the WhatsApp Web search box), so promoting UIA above OCR broke the
> existing real-desktop flow. Keeping the order above preserves all existing
> behaviour and passing tests while adding the new capabilities as fallbacks.

Each fallback can be disabled via config:

```js
buildRealAgent({ config: { perception: { paddleOcr: false, uia: false } } });
```

`RealUiaSensor` filters scanned elements to the foreground process id, so a
desktop-wide scan does not leak controls from other applications.

## Commands

```bash
# OCR an existing image (headless-safe, deterministic)
node demo/ocr-demo.js --image tests/fixtures/menu_bar.png

# Capture the live screen and OCR it
node demo/ocr-demo.js
```

Both print the recognised lines (text + box + confidence) and the resulting
`ScreenModel` the agent consumes.

## Tests

```bash
node --test tests/paddle_ocr_unit.test.js     # CTC + dict + det post-process
node --test tests/paddle_ocr_model.test.js    # real ONNX inference on a fixture
```

The model test skips (does not fail) when the model artifacts or fixture are
absent, so the suite still runs after a fresh clone.

## Limitations

- The detector post-process is axis-aligned (no rotated boxes); fine for UI text,
  not for arbitrary photographed documents.
- `onnxruntime-node` native sessions run on CPU; ~0.6–0.9 s for a 1920×1080
  screenshot on this machine.
- Screen capture and UIA require an interactive, unlocked desktop session.
- UIA coverage depends on the application exposing its controls (browsers often
  expose only the window shell).
