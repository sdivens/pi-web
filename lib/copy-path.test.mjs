import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Through jiti: the module is TypeScript, and the test runner only strips types
// from the test itself.
const jiti = createJiti(import.meta.url);
const { copyablePath } = await jiti.import("./copy-path.ts");

test("a path without whitespace or a quote is copied as it is", () => {
  assert.equal(copyablePath("/Users/me/project"), "/Users/me/project");
  assert.equal(copyablePath("/"), "/");
  assert.equal(copyablePath(""), "");
  assert.equal(copyablePath("C:\\Users\\me\\project"), "C:\\Users\\me\\project");
});

test("a path with whitespace is quoted so it stays one word", () => {
  assert.equal(copyablePath("/Users/me/my project"), "\"/Users/me/my project\"");
  assert.equal(copyablePath("/Users/me/a b/c d"), "\"/Users/me/a b/c d\"");
  assert.equal(copyablePath("/Users/me/tab\there"), "\"/Users/me/tab\there\"");
  assert.equal(copyablePath(" /Users/me"), "\" /Users/me\"");
  assert.equal(copyablePath("/Users/me "), "\"/Users/me \"");
});

test("a double quote inside a quoted path is escaped", () => {
  assert.equal(copyablePath("/Users/me/the \"best\" dir"), "\"/Users/me/the \\\"best\\\" dir\"");
  // A quote alone needs the quotes too: a bare one is a syntax error in a shell.
  assert.equal(copyablePath("/Users/me/a\"b"), "\"/Users/me/a\\\"b\"");
});

test("a Windows path with a space keeps its backslashes", () => {
  assert.equal(copyablePath("C:\\Users\\me\\my project"), "\"C:\\Users\\me\\my project\"");
});
