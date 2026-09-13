/**
 * PaddleOCR CTC dictionary.
 *
 * Format: one character per line (UTF-8). Index mapping follows PaddleOCR:
 *   class 0            -> CTC blank
 *   class 1..N         -> dict[i-1]
 *   class N+1          -> space (use_space_char)
 * so num_classes === dict.length + 2.
 */
import { readFileSync } from "node:fs";

export class OcrDict {
  constructor(chars) {
    this.chars = chars;
  }

  static load(path) {
    let lines = readFileSync(path, "utf8").replace(/\r/g, "").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return new OcrDict(lines);
  }

  /** Total classes this dictionary implies (blank + chars + space). */
  get classes() {
    return this.chars.length + 2;
  }

  /** Map a class index to a character; `null` for the CTC blank (0). */
  charAt(index) {
    if (index <= 0) return null;
    if (index <= this.chars.length) return this.chars[index - 1];
    return " "; // trailing space class
  }
}
