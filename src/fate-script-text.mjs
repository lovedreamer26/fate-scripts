const header = "FATE SCRIPT TEXT 1.0";
const begin = "<<<FATE SCRIPT JAVASCRIPT>>>";
const end = "<<<END FATE SCRIPT>>>";
const maxLength = 16 * 1024 * 1024;
const marker = /(?:^|\n)(FATE SCRIPT TEXT 1\.0|<<<FATE SCRIPT JAVASCRIPT>>>|<<<END FATE SCRIPT>>>)(?=\r?\n|$)/g;

export class ScriptTextError extends Error {
  constructor(message, input) {
    super(message);
    this.name = "ScriptTextError";
    this.input = input;
  }
}

function validateMetadata(metadata, input) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ScriptTextError("Метаданные должны быть JSON-объектом.", input);
  }
  for (const key of ["name", "description", "foundryVersion", "systemVersion"]) {
    if (Object.hasOwn(metadata, key) && typeof metadata[key] !== "string") {
      throw new ScriptTextError(`Поле ${key} должно быть строкой.`, input);
    }
  }
  for (const key of ["tags", "dependencies"]) {
    if (Object.hasOwn(metadata, key) && (!Array.isArray(metadata[key]) ||
        !metadata[key].every((value) => typeof value === "string"))) {
      throw new ScriptTextError(`Поле ${key} должно быть массивом строк.`, input);
    }
  }
}

export function parseScriptText(input, { raw = false } = {}) {
  if (typeof input !== "string" || input.length > maxLength) {
    throw new ScriptTextError("Ожидается текст размером до 16 Ми кодовых единиц.", input);
  }
  if (raw) return { metadata: {}, code: input };

  const offset = input.startsWith("\uFEFF") ? 1 : 0;
  const matches = [...input.slice(offset).matchAll(marker)];
  if (matches.length !== 3 || matches[0][1] !== header ||
      matches[1][1] !== begin || matches[2][1] !== end) {
    throw new ScriptTextError("Нужен один полный блок FATE SCRIPT TEXT 1.0 с тремя маркерами по порядку.", input);
  }

  const [first, middle, last] = matches;
  const start = (match) => offset + match.index + Number(match[0].startsWith("\n"));
  const afterLine = (match) => {
    const index = start(match) + match[1].length;
    return index + (input.startsWith("\r\n", index) ? 2 : 1);
  };
  const beforeLine = (match) => {
    const index = start(match);
    return index - (input.slice(index - 2, index) === "\r\n" ? 2 : 1);
  };
  let metadata;
  try {
    metadata = JSON.parse(input.slice(afterLine(first), start(middle)));
  } catch {
    throw new ScriptTextError("Метаданные содержат некорректный JSON.", input);
  }
  validateMetadata(metadata, input);
  const codeStart = afterLine(middle);
  const codeEnd = beforeLine(last);
  if (codeEnd < codeStart) {
    throw new ScriptTextError("Перед закрывающим маркером нужен отдельный перенос строки.", input);
  }
  return { metadata, code: input.slice(codeStart, codeEnd) };
}

export function formatScriptText(metadata, code) {
  validateMetadata(metadata, code);
  if (typeof code !== "string") throw new ScriptTextError("JavaScript должен быть строкой.", code);
  // Use the same framing on both sides. CRLF framing also preserves a final lone CR.
  const separator = "\r\n";
  const input = [header, JSON.stringify(metadata), begin, code, end].join(separator);
  parseScriptText(input);
  return input;
}
