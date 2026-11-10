"""
demo/mock_llm.py -- a tiny OpenAI-compatible chat-completions provider.

Stands in for OpenAI/Anthropic so the demo runs with no real provider keys.
LiteLLM points at it like any other OpenAI-compatible deployment:

    litellm_params:
      model: openai/demo-gpt
      api_base: http://localhost:9999/v1
      api_key: mock-local-key

Usage is controlled two ways:

  * A directive anywhere in the last user message (stripped from the reply):

        [usage: in=10000 out=2000 cache_read=8000]

    Keys: in / out / cache_read / cache_write / reasoning.  Unknown keys are
    ignored.

  * Otherwise input is derived from the prompt (~4 chars per token) and
    output is fixed at 64 tokens.

The response carries OpenAI-style usage accounting: `prompt_tokens` INCLUDES
cached input (prompt = in + cache_read + cache_write), and cached tokens are
also exposed as `prompt_tokens_details.cached_tokens`.  That is exactly the
rule the MeterPal bridge applies when it splits the pools, so balances move by
the numbers you asked for.

Run:  python demo/mock_llm.py          # serves http://localhost:9999
"""

from __future__ import annotations

import re
import time
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from mock_agent import final_reply, plan_next_turn

app = FastAPI(title="Mock LLM")

_MODELS = ["demo-gpt", "gpt-4o-mini-mock"]

_DIRECTIVE_RE = re.compile(r"\[(?:mock_)?usage:([^\]]*)\]")


def _parse_usage(messages: list[dict]) -> tuple[dict[str, int], str]:
    """Extract the usage directive from the last user message.

    Returns (usage, cleaned_text)."""
    last_user = ""
    for msg in reversed(messages or []):
        if msg.get("role") == "user":
            last_user = msg.get("content") or ""
            break

    usage = {
        "in": max(len(last_user) // 4, 1),
        "out": 64,
        "cache_read": 0,
        "cache_write": 0,
        "reasoning": 0,
    }
    cleaned = last_user
    m = _DIRECTIVE_RE.search(last_user)
    if m:
        for pair in m.group(1).split():
            if "=" not in pair:
                continue
            key, _, raw = pair.partition("=")
            key = key.strip().lower()
            try:
                val = int(raw)
            except ValueError:
                continue
            if key in ("in", "input", "input_tokens"):
                usage["in"] = val
            elif key in ("out", "output", "output_tokens"):
                usage["out"] = val
            elif key in ("cache_read", "cache_read_tokens", "cached"):
                usage["cache_read"] = val
            elif key in ("cache_write", "cache_write_tokens"):
                usage["cache_write"] = val
            elif key in ("reasoning", "reasoning_tokens"):
                usage["reasoning"] = val
        cleaned = _DIRECTIVE_RE.sub("", last_user).strip()
    return usage, cleaned


_TOOLS_DUMP = "C:/Users/craig/MeterPal/demo/logs/mock_tools.jsonl"


def _dump_tools(body: dict) -> None:
    """Append the tool schemas this request offered, for inspection."""
    tools = body.get("tools")
    if not tools:
        return
    try:
        import json
        import os

        os.makedirs(os.path.dirname(_TOOLS_DUMP), exist_ok=True)
        with open(_TOOLS_DUMP, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(tools) + "\n")
    except Exception as exc:  # pragma: no cover - diagnostics only
        print(f"[mock-llm] tool dump failed: {exc}")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/models")
def models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [{"id": m, "object": "model", "owned_by": "mock"} for m in _MODELS],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Any:
    body = await request.json()
    model = body.get("model") or "demo-gpt"
    usage, cleaned = _parse_usage(body.get("messages") or [])

    _dump_tools(body)

    completion_id = f"chatcmpl-mock-{int(time.time() * 1000)}"
    created = int(time.time())

    prompt_total = usage["in"] + usage["cache_read"] + usage["cache_write"]
    completion_total = usage["out"] + usage["reasoning"]

    usage_block = {
        # OpenAI semantics: prompt_tokens includes cached input.
        "prompt_tokens": prompt_total,
        "completion_tokens": completion_total,
        "total_tokens": prompt_total + completion_total,
        "prompt_tokens_details": {"cached_tokens": usage["cache_read"]},
        # Anthropic-style pool fields; the bridge reads either shape.
        "cache_read_input_tokens": usage["cache_read"],
        "cache_creation_input_tokens": usage["cache_write"],
        "completion_tokens_details": {"reasoning_tokens": usage["reasoning"]},
    }

    # A request that offers tools is an agent turn: play the agent.
    tool_call = plan_next_turn(body)
    if tool_call is not None:
        print(
            f"[mock-llm] tool call -> {tool_call['name']} "
            f"{tool_call['arguments'][:300]}",
            flush=True,
        )
        return {
            "id": completion_id,
            "object": "chat.completion",
            "created": created,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": f"call_{int(time.time() * 1000)}",
                                "type": "function",
                                "function": {
                                    "name": tool_call["name"],
                                    "arguments": tool_call["arguments"],
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": usage_block,
        }

    if body.get("tools"):
        # The agent has nothing left to call: close with a report of what the
        # delegation built, not an echo of the prompt.
        reply = final_reply(body)
        print(f"[mock-llm] final reply -> {reply}", flush=True)
        return {
            "id": completion_id,
            "object": "chat.completion",
            "created": created,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": reply},
                    "finish_reason": "stop",
                }
            ],
            "usage": usage_block,
        }

    reply = (
        f"[mock {model}] Acknowledged: {cleaned[:120] or '(empty prompt)'} "
        f"-- billed {usage['in']:,} input"
        + (f" (+{usage['cache_read']:,} cached)" if usage["cache_read"] else "")
        + f" / {usage['out']:,} output tokens."
    )

    if body.get("stream"):
        return StreamingResponse(
            _stream_chunks(
                completion_id=completion_id,
                created=created,
                model=model,
                reply=reply,
                usage_block=usage_block,
                include_usage=bool(
                    (body.get("stream_options") or {}).get("include_usage")
                ),
            ),
            media_type="text/event-stream",
        )

    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": reply},
                "finish_reason": "stop",
            }
        ],
        "usage": usage_block,
    }


async def _stream_chunks(
    *,
    completion_id: str,
    created: int,
    model: str,
    reply: str,
    usage_block: dict[str, Any],
    include_usage: bool,
):
    """Server-Sent Events in the OpenAI chunk shape.

    The reply is delivered in a few pieces so a client sees the stream
    arrive, then the usage chunk, then [DONE] -- the same order the real
    providers use.
    """
    import json

    def envelope(delta: dict[str, Any], finish_reason: Any, usage: Any = None) -> str:
        payload: dict[str, Any] = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [
                {"index": 0, "delta": delta, "finish_reason": finish_reason}
            ],
        }
        if usage is not None:
            payload["choices"] = []
            payload["usage"] = usage
        return f"data: {json.dumps(payload)}\n\n"

    yield envelope({"role": "assistant", "content": ""}, None)

    pieces = reply.split(" ")
    for index, piece in enumerate(pieces):
        text = piece if index == 0 else " " + piece
        yield envelope({"content": text}, None)

    yield envelope({}, "stop")

    if include_usage:
        yield envelope({}, None, usage_block)

    yield "data: [DONE]\n\n"


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=9999, log_level="warning")
