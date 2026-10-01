import assert from "node:assert/strict";
import test from "node:test";

import {
  agyDiagnosticText,
  detectAgyAuthRequired,
  detectAgyQuotaExhausted,
  isAgySessionUnrecoverableError,
  isAgyTransientNetworkError,
  parseAgyJsonl,
} from "../dist/parse.js";

// A successful run whose MODEL text talks about errors, as an agent debugging
// an API would: none of it is agy failing.
const MODEL_TALKS_ABOUT_ERRORS = [
  JSON.stringify({ event: "init", conversation_id: "c1", init: { cwd: "/w" } }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: "c1",
      step_index: 1,
      state: "DONE",
      step_type: "agent_response",
      text_delta:
        "The API returned 429 Too Many Requests, then 401 Unauthorized, then 503; " +
        "quota exceeded. Conversation not found in the cache. Please log in again.",
    },
  }),
  JSON.stringify({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "done" } }),
].join("\n");

test("errors the model talks about do not classify the run", () => {
  const parsed = parseAgyJsonl(MODEL_TALKS_ABOUT_ERRORS);
  const input = { stdout: MODEL_TALKS_ABOUT_ERRORS, stderr: "", parsed };
  assert.equal(detectAgyAuthRequired(input).requiresAuth, false);
  assert.equal(detectAgyQuotaExhausted(input), false);
  assert.equal(isAgyTransientNetworkError(MODEL_TALKS_ABOUT_ERRORS, ""), false);
  assert.equal(isAgySessionUnrecoverableError(MODEL_TALKS_ABOUT_ERRORS, ""), false);
});

test("the same errors from agy itself still classify the run", () => {
  assert.equal(detectAgyAuthRequired({ stdout: "", stderr: "Error: not logged in", parsed: null }).requiresAuth, true);
  assert.equal(detectAgyQuotaExhausted({ stdout: "", stderr: "RESOURCE_EXHAUSTED: 429", parsed: null }), true);
  assert.equal(isAgyTransientNetworkError("", "connect ECONNREFUSED 1.2.3.4:443"), true);
  assert.equal(isAgySessionUnrecoverableError("", 'conversation "x" not found'), true);
});

test("agy's plain-text lines on stdout count as diagnostics", () => {
  const stdout = `Please log in: run \`agy login\`\n${MODEL_TALKS_ABOUT_ERRORS}`;
  assert.equal(agyDiagnosticText(stdout), "Please log in: run `agy login`");
  assert.equal(detectAgyAuthRequired({ stdout, stderr: "", parsed: null }).requiresAuth, true);
});

test("the result event's error field counts as a diagnostic", () => {
  const stdout = JSON.stringify({ event: "result", result: { status: "ERROR", error: "quota exceeded for project" } });
  const parsed = parseAgyJsonl(stdout);
  assert.equal(detectAgyQuotaExhausted({ stdout, stderr: "", parsed }), true);
});
