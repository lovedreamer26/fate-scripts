import assert from "node:assert/strict";
import { test } from "node:test";
import { macroCandidate, macroFile, documentMetadata, classifyMacro, glossaryTitle, systemFromPath, translationKey } from "./catalog-metadata.ts";

test("accepts Foundry macro candidates and excludes test, helper and configuration paths", () => {
  for(const path of ["macros/pf2e/show-xp.js","macros/roll.json","roll.macro.json","macros/dnd5e/roll.cjs"]) assert(macroCandidate(path),path);
  for(const path of ["macros/test/fixture.js","macros/helpers/roll.js","vite.config.js","macros package.json","macros/module.json","data.json"]) assert(!macroCandidate(path),path);
});
test("extracts JS metadata, preserves bytes and analyzes known module references without executing", () => {
  const code = "\uFEFF/**\r\n * Macro Title: Show XP\r\n * @author TheJoester\r\n * Foundry Version: v12-v13\r\n * Description: Checks the party.\r\n */\r\nthrow Error('must not run');\r\nawait game.modules.get('sequencer');";
  const result=macroFile(code,"macros/pf2e/show-xp.js");
  assert.equal(result.code,code);
  assert.deepEqual(result.metadata,{title:"Show XP",author:"TheJoester",versions:"v12-v13",description:"Checks the party."});
  assert.deepEqual(classifyMacro(result.metadata,"macros/pf2e/show-xp.js",code).dependencies,["sequencer"]);
  assert.equal(systemFromPath("macros/pf2e/show-xp.js"),"pf2e");
});
test("validates JSON definitions and rejects exported libraries",()=>{
  const code="return 42;\r\n";
  assert.equal(macroFile(JSON.stringify({name:"Sample",type:"script",command:code}),"macros/sample.json").code,code);
  assert.throws(()=>macroFile('{"type":"chat","command":"hello"}',"macros/sample.json"));
  assert.throws(()=>macroFile("export function test() {}","macro.js"));
});
test("glossary does not replace unknown English and localization keys depend on original metadata",()=>{
  assert.equal(glossaryTitle("show-xp.js"),"Показать опыт");
  assert.equal(glossaryTitle("strange-widget.js"),undefined);
  assert.equal(translationKey("a/b","x.js",{title:"Original"}),translationKey("a/b","x.js",{title:"Original"}));
  assert.notEqual(translationKey("a/b","x.js",{title:"Original"}),translationKey("a/b","x.js",{title:"Changed"}));
});

test("reads a macro section and its nested instructions without borrowing repository-wide claims",()=>{
  const doc="# Overview\nLicense: MIT\n## Show XP\nPrints the party's experience.\n\n### Usage\nSelect a party.\n\n## Other\nAuthor: Somebody";
  assert.deepEqual(documentMetadata(doc,["show-xp.js"],false),{description:"Prints the party's experience.",instructions:"Select a party."});
  assert.deepEqual(documentMetadata(doc,["missing.js"],false),{});
});
