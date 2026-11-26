import assert from "node:assert/strict";
import { test } from "node:test";
import { scriptExport } from "./script-export.ts";

test("exports JavaScript without changing BOM, line endings, or escaped characters", async () => {
  const input = "\uFEFF// Пример\r\nconst path = 'C:\\\\Файлы';\nreturn path;\r";
  const { filename, file } = scriptExport("  Пример  ", input);
  assert.equal(filename, "Пример.js");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new TextEncoder().encode(input));
});

test("uses a safe file name on Windows", () => {
  assert.equal(scriptExport("CON.log", "").filename, "macro.js");
  assert.equal(scriptExport("  ../Папка: имя*  ", "").filename, ".._Папка_ имя_.js");
});
