// Run with:  npm test   (uses Node's built-in test runner, no extra packages)
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fs = require("node:fs");
const vm = require("node:vm");

// The game files are plain browser scripts, so load them the way a browser would.
global.window = global;
for (const f of ["js/rules.js", "data/words.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "../public/wordle", f), "utf8"), {
    filename: f,
  });
}
const Rules = global.Rules;

const short = (r) => r.map((s) => s[0]).join(""); // c / p / a

test("evaluate: exact, present, absent", () => {
  assert.equal(short(Rules.evaluate("crane", "crane")), "ccccc");
  assert.equal(short(Rules.evaluate("react", "crane")), "ppcpa");
  assert.equal(short(Rules.evaluate("build", "crane")), "aaaaa");
});

test("evaluate: duplicate letters are not over-counted", () => {
  assert.equal(short(Rules.evaluate("llama", "small")), "ppcpa");
  assert.equal(short(Rules.evaluate("speed", "abide")), "aapap"); // one E in the answer
  assert.equal(short(Rules.evaluate("eerie", "there")), "papac");
  assert.equal(short(Rules.evaluate("geese", "abbey")), "apaaa");
  assert.equal(short(Rules.evaluate("allee", "eagle")), "ppapc");
});

test("daily word: stable, not alphabetical, covers every answer once", () => {
  const n = ANSWER_WORDS.length;
  const order = Rules.dailyOrder(n);
  assert.equal(new Set(order).size, n);
  assert.equal(Rules.dailyAnswer(ANSWER_WORDS, 10), Rules.dailyAnswer(ANSWER_WORDS, 10));
  assert.equal(Rules.dailyAnswer(ANSWER_WORDS, 10), Rules.dailyAnswer(ANSWER_WORDS, 10 + n));
  const week = [0, 1, 2, 3, 4, 5, 6].map((d) => Rules.dailyAnswer(ANSWER_WORDS, d));
  assert.notDeepEqual(week, [...week].sort());
});

test("dayIndex uses the local calendar date", () => {
  assert.equal(Rules.dayIndex(new Date(2024, 0, 1, 0, 5)), 0);
  assert.equal(Rules.dayIndex(new Date(2024, 0, 1, 23, 55)), 0);
  assert.equal(Rules.dayIndex(new Date(2024, 0, 2, 0, 5)), 1);
});

test("round points", () => {
  assert.equal(Rules.roundPoints(false, 6, 1000, 0), 0);
  assert.equal(Rules.roundPoints(true, 1, 1000, 0), 6);
  assert.equal(Rules.roundPoints(true, 6, 1000, 0), 1);
  assert.equal(Rules.roundPoints(true, 3, 20000, 60), 6); // 4 + 2 speed bonus
  assert.equal(Rules.roundPoints(true, 3, 40000, 60), 5); // 4 + 1
  assert.equal(Rules.roundPoints(true, 3, 59000, 60), 4);
});

test("team score is the average, so bigger teams get no advantage", () => {
  assert.equal(Rules.teamScore([6, 6]), 6);
  assert.equal(Rules.teamScore([6]), 6);
  assert.equal(Rules.teamScore([5, 4, 0]), 3);
  assert.equal(Rules.teamScore([]), 0);
});

test("safeColor rejects anything that is not a plain colour", () => {
  assert.equal(Rules.safeColor("#3a6df0"), "#3a6df0");
  assert.equal(Rules.safeColor("hsl(137.5 70% 48%)"), "hsl(137.5 70% 48%)");
  assert.equal(Rules.safeColor('red"><img src=x onerror=alert(1)>'), "#8892a5");
  assert.equal(Rules.safeColor("url(javascript:alert(1))"), "#8892a5");
});

test("word lists are well formed", () => {
  assert.ok(ANSWER_WORDS.every((w) => Rules.isWordShape(w) && VALID_WORDS.has(w)));
});

test("MVP: top score, ties broken by rounds solved, then fewer guesses, then time", () => {
  const p = (id, score, roundsWon, solveTries, solveMs) => ({
    id,
    score,
    roundsWon,
    solveTries,
    solveMs,
  });
  assert.equal(Rules.pickMvp([p("a", 5, 1, 2, 9000), p("b", 9, 2, 6, 9000)]), "b");
  assert.equal(Rules.pickMvp([p("a", 8, 1, 2, 9000), p("b", 8, 2, 6, 9000)]), "b");
  assert.equal(Rules.pickMvp([p("a", 8, 2, 5, 9000), p("b", 8, 2, 6, 1000)]), "a");
  assert.equal(Rules.pickMvp([p("a", 8, 2, 5, 9000), p("b", 8, 2, 5, 1000)]), "b");
  assert.equal(Rules.pickMvp([p("a", 0, 0, 0, 0)]), null);
  assert.equal(Rules.pickMvp([]), null);
});
