import test from "node:test";
import assert from "node:assert/strict";
import orchestrator from "./orchestrator.js";

test("buildGuardrailScanUrl adds /backend prefix for plain upstream host", () => {
  assert.equal(
    orchestrator.buildGuardrailScanUrl("https://us1.calypsoai.app"),
    "https://us1.calypsoai.app/backend/v1/scans",
  );
});

test("buildGuardrailScanUrl keeps single /backend when upstream already includes it", () => {
  assert.equal(
    orchestrator.buildGuardrailScanUrl("https://us1.calypsoai.app/backend/"),
    "https://us1.calypsoai.app/backend/v1/scans",
  );
});

test("buildGuardrailPromptUrl adds /backend prefix for plain upstream host", () => {
  assert.equal(
    orchestrator.buildGuardrailPromptUrl("https://us1.calypsoai.app"),
    "https://us1.calypsoai.app/backend/v1/prompts",
  );
});

test("buildGuardrailPromptUrl keeps single /backend when upstream already includes it", () => {
  assert.equal(
    orchestrator.buildGuardrailPromptUrl("https://us1.calypsoai.app/backend/"),
    "https://us1.calypsoai.app/backend/v1/prompts",
  );
});

test("getPromptResponseModel extracts model from providerResult payload in files", () => {
  const payload = {
    result: {
      files: [
        {
          data: JSON.stringify({
            provider: "xAI",
            model: "x-ai/grok-4.1-fast",
            object: "chat.completion",
          }),
        },
      ],
    },
  };

  assert.equal(
    orchestrator.getPromptResponseModel(payload, "openai/gpt-4o-mini"),
    "x-ai/grok-4.1-fast",
  );
});

test("getPromptResponseModel falls back to selected model when response has no model field", () => {
  const payload = {
    result: {
      response: "hello",
    },
  };

  assert.equal(
    orchestrator.getPromptResponseModel(payload, "openai/gpt-4o-mini"),
    "openai/gpt-4o-mini",
  );
});

test("getLLMResponseModel returns model from LLM payload", () => {
  const llmPayload = {
    id: "chatcmpl-1",
    model: "openai/gpt-oss-20b",
    choices: [{ message: { role: "assistant", content: "hi" } }],
  };

  assert.equal(
    orchestrator.getLLMResponseModel(llmPayload, "openai/gpt-4o-mini"),
    "openai/gpt-oss-20b",
  );
});

test("getLLMResponseModel falls back to selected model when model is missing", () => {
  const llmPayload = {
    id: "chatcmpl-2",
    choices: [{ message: { role: "assistant", content: "hi" } }],
  };

  assert.equal(
    orchestrator.getLLMResponseModel(llmPayload, "openai/gpt-4o-mini"),
    "openai/gpt-4o-mini",
  );
});
