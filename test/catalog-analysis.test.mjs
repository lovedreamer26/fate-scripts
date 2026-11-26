import assert from "node:assert/strict";
import test from "node:test";
import { analyzeMacro, normalizeSystem } from "../src/catalog-analysis.ts";
import { documentMetadata, macroFile, UnsupportedMacroError } from "../src/catalog-metadata.ts";

test("finds a README annotation only for the named macro", () => {
  const readme = "# Macros\n- Divine Smite (Automatically appends damage to the attack card.)";
  assert.match(documentMetadata(readme,["divine-smite.js"],false).description,/attack card/);
  assert.deepEqual(documentMetadata(readme,["healing-light.js"],false),{});
});

test("describes concrete Foundry calls without executing code or treating strings as evidence", () => {
  const result = analyzeMacro(`
    if (!canvas.tokens.controlled.length) return;
    const token = canvas.tokens.controlled[0];
    game.dnd5e;
    await new Roll("1d8").evaluate();
    await token.actor.createEmbeddedDocuments("ActiveEffect", []);
    await token.actor.update({"system.attributes.hp.value": 12});
    throw new Error("game.pf2e; actor.applyDamage(30)");
  `);
  assert.equal(result.system,"dnd5e");
  assert.match(result.description,/бросок кубиков/);
  assert.match(result.changes.join(" "),/активные эффекты.*очки здоровья/);
  assert.doesNotMatch(result.description,/урона/);
  assert.match(result.instructions,/выберите токены/);
});

test("rejects inert libraries and leaves ambiguous systems unassigned", () => {
  assert.throws(()=>analyzeMacro("const update = () => actor.update({});"),UnsupportedMacroError);
  assert.throws(()=>macroFile("export const run = () => {};","feature.js"),UnsupportedMacroError);
  assert.equal(analyzeMacro("ChatMessage.create({content: 'hello'});").system,undefined);
  assert.equal(analyzeMacro("game.dnd5e; game.pf2e;").system,undefined);
  assert.equal(normalizeSystem("Dungeons & Dragons 5e (2024)"),"dnd5e");
  assert.equal(normalizeSystem("Pathfinder 2e"),"pf2e");
  assert.equal(normalizeSystem("System-agnostic"),"universal");
});
