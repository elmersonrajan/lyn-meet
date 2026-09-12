const test = require("node:test");
const assert = require("node:assert");

const { classLabel, MAX } = require("../src/auth/classLabel");

test("the platform's own name for the class is used", () => {
  // The name a student already sees on the site they clicked through from.
  assert.strictEqual(
    classLabel({ subject: "2027 NEET 2027 Physics tamil", title: "Period 3" }),
    "2027 NEET 2027 Physics tamil",
  );
});

test("the meeting title is the fallback, not the first choice", () => {
  // MeetingTitle is free text a teacher may have left as "test"; the subject
  // name is structural and carries the class and the medium already.
  assert.strictEqual(classLabel({ subject: null, title: "Revision" }), "Revision");
  assert.strictEqual(classLabel({ subject: "   ", title: "Revision" }), "Revision");
});

test("nothing worth showing gives nothing", () => {
  // An ad-hoc room has no schedule behind it, and the strip must then be
  // exactly what it was before this existed.
  assert.strictEqual(classLabel(null), null);
  assert.strictEqual(classLabel({}), null);
  assert.strictEqual(classLabel({ subject: "", title: "  " }), null);
});

test("whitespace typed into a web form is tidied", () => {
  assert.strictEqual(classLabel({ subject: "  Physics   tamil \n" }), "Physics tamil");
});

test("a very long name is cut rather than pushing the id off the strip", () => {
  const long = "x".repeat(MAX + 40);
  const out = classLabel({ subject: long });
  assert.strictEqual(out.length, MAX);
  assert.ok(out.endsWith("…"), out.slice(-5));
});

test("a name exactly at the limit is left alone", () => {
  const exact = "y".repeat(MAX);
  assert.strictEqual(classLabel({ subject: exact }), exact);
});

test("a non-string from the driver does not throw", () => {
  // Some columns come back as numbers or Buffers depending on the type.
  assert.strictEqual(classLabel({ subject: 2027 }), "2027");
});
