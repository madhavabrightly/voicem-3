import { WindowsDriver } from "../backend/tools/win/win_driver.js";

async function run() {
  console.log("Running real Windows OCR...");
  const driver = new WindowsDriver();
  const res = await driver.ocr();
  if (res.success) {
    console.log("OCR SUCCESS. Lines detected:", res.lines?.length || 0);
    console.log("First 5 lines:", res.lines?.slice(0, 5));
  } else {
    console.log("OCR FAILED.", res);
  }
}
run();
