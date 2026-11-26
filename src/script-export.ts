export function scriptExport(name: string, code: string) {
  const basename = Array.from(name.trim().replace(/[^\p{L}\p{N} ._-]/gu, "_"))
    .slice(0, 100).join("").replace(/[ .]+$/, "");
  const deviceName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  const filename = (basename && !deviceName.test(basename) ? basename : "macro") + ".js";
  return { filename, file: new Blob([code], {type: "text/javascript;charset=utf-8"}) };
}
