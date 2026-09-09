import assert from "node:assert/strict";
import test from "node:test";
import { PiTerminalJson } from "../src/pi-terminal-json.ts";

function parse(source: string, chunkSize = source.length || 1) {
  const parser = new PiTerminalJson();
  for (let i = 0; i < source.length; i += chunkSize) parser.write(source.slice(i, i + chunkSize));
  return parser.end();
}

const final = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" };

test("projects cumulative messages exceeding the limit while retaining the last message", () => {
  const source = JSON.stringify({ type: "agent_end", messages: ["x".repeat(4 * 1024 * 1024), final] });
  assert.deepEqual(parse(source, 8191), { type: "agent_end", messages: [final] });
  assert.equal(parse(JSON.stringify({ type: "agent_end", messages: [final, "x".repeat(4 * 1024 * 1024)] })), undefined);
});

test("handles every character boundary and escaped top-level keys", () => {
  const source = '{"messa\\u0067es":[{"ignored":[null,false,true,-2.3e+4]},' + JSON.stringify(final) + '],"type":"agent_end"}';
  for (let split = 0; split <= source.length; split++) {
    const parser = new PiTerminalJson();
    parser.write(source.slice(0, split));
    parser.write(source.slice(split));
    assert.deepEqual(parser.end(), { messages: [final], type: "agent_end" });
  }
});

test("preserves duplicate-key semantics and does not project nested messages", () => {
  assert.deepEqual(parse('{"messages":[1,2],"messages":[3,4],"type":"wrong","type":"agent_end"}'),
    { messages: [4], type: "agent_end" });
  assert.deepEqual(parse('{"messages":[1],"messages":null,"nested":{"messages":[1,2]}}'),
    { messages: null, nested: { messages: [1, 2] } });
  assert.deepEqual(parse('{"messages":null,"messages":[]}'), { messages: [] });
  assert.deepEqual(parse('{"__proto__":{"polluted":true},"messages":[1,2]}'),
    JSON.parse('{"__proto__":{"polluted":true},"messages":[2]}'));
});

test("rejects malformed syntax even in discarded large history", () => {
  for (const invalid of ['01', '1.', '1e+', 'tru', 'undefined', '"bad\\x"', '"bad\n"',
    '{"a":1,}', '[1,]', '{"a" 1}', '[,1]', '{1:2}', '"\\u00xz"']) {
    assert.equal(parse('{"messages":[' + JSON.stringify("x".repeat(4 * 1024 * 1024)) + ',' + invalid + ',1]}', 16381), undefined, invalid);
  }
  for (const invalid of ['{} trailing', '{}{}', '{', '[]', 'null', '{"messages":[1,2]'] ) {
    assert.equal(parse(invalid, 1), undefined, invalid);
  }
});

test("bounds nesting and the complete projected envelope", () => {
  assert.equal(parse('{"messages":[' + '['.repeat(257) + '1' + ']'.repeat(257) + ',1]}'), undefined);
  assert.equal(parse(JSON.stringify({ type: "agent_end", padding: "x".repeat(3 * 1024 * 1024),
    messages: ["x".repeat(2 * 1024 * 1024)] })), undefined);
});

test("matches JSON.parse across deterministic nested values and streaming boundaries", () => {
  let seed = 42;
  const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  const scalars = [null, true, false, 0, -17, 1.3e40, -0.004, "", "quote\"\\\n\t", "日本語🌱", "\ud800"];
  function value(depth: number): unknown {
    if (depth === 0 || random(3) === 0) return scalars[random(scalars.length)];
    if (random(2)) return Array.from({ length: random(4) }, () => value(depth - 1));
    return Object.fromEntries(Array.from({ length: random(4) }, (_, i) => [`key${i}`, value(depth - 1)]));
  }
  for (let i = 0; i < 100; i++) {
    const source = JSON.stringify({ metadata: value(3), messages: Array.from({ length: random(5) }, () => value(3)),
      type: "agent_end" }, null, i % 2 ? 2 : undefined);
    const expected = JSON.parse(source);
    expected.messages = expected.messages.slice(-1);
    for (const chunkSize of [1, 7, 64]) assert.deepEqual(parse(source, chunkSize), expected);
  }
});

test("rejects invalid delimiter, number, literal, and string mutations", () => {
  const mutations = ['{"messages";[1]}', '{"messages":[1 2]}', '{"messages":[truefalse]}',
    '{"messages":[+1]}', '{"messages":[-.2]}', '{"messages":[1e]}', '{"messages":[1.e2]}',
    '{"messages":[false,]}', '{"messages":["\\u123"]}', '{"messages":["\\v"]}',
    '{"messages":[1]}\u00a0', '{"messages":[1]}\0', '{"messages":{]}', '{"messages":{,}}'];
  for (const source of mutations) {
    assert.throws(() => JSON.parse(source));
    for (const chunkSize of [1, 5, 64]) assert.equal(parse(source, chunkSize), undefined, source);
  }
});

test("applies the exact envelope byte limit across surrogate-pair chunk boundaries", () => {
  const overhead = Buffer.byteLength(JSON.stringify({ messages: [""] }));
  const text = "🌱".repeat(Math.floor((4 * 1024 * 1024 - overhead) / 4));
  const padding = "x".repeat(4 * 1024 * 1024 - overhead - Buffer.byteLength(text));
  const source = JSON.stringify({ messages: [text + padding] });
  assert.equal(Buffer.byteLength(source), 4 * 1024 * 1024);
  assert.deepEqual(parse(source, 8191), { messages: [text + padding] });
  assert.equal(parse(JSON.stringify({ messages: [text + padding + "x"] }), 8191), undefined);
});
