import { parse } from "acorn";
import { simple } from "acorn-walk";

const globals: Readonly<Record<string, string>> = Object.freeze({
  Sequencer: "sequencer", Sequence: "sequencer", Tagger: "tagger",
  MidiQOL: "midi-qol", TokenMagic: "tokenmagic", JB2A: "jb2a_patreon",
});

export function detectDependencies(code: string): string[] {
  const matches = new Set<string>();
  const tree = parse(code, {
    ecmaVersion: "latest", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true,
  });
  simple(tree, {
    Identifier(node) {
      if (Object.prototype.hasOwnProperty.call(globals, node.name)) matches.add(globals[node.name]);
    },
    CallExpression(node) {
      // game.modules.get("module-id")
      const member = node.callee;
      if (member.type !== "MemberExpression" || member.computed ||
          member.property.type !== "Identifier" || member.property.name !== "get") return;
      const modules = member.object;
      if (modules.type !== "MemberExpression" || modules.computed ||
          modules.object.type !== "Identifier" || modules.object.name !== "game" ||
          modules.property.type !== "Identifier" || modules.property.name !== "modules") return;
      const argument = node.arguments[0];
      if (argument?.type === "Literal" && typeof argument.value === "string" &&
          /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(argument.value)) matches.add(argument.value);
    },
  });
  return [...matches].sort();
}
