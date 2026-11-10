"""
demo/mock_agent.py -- a scripted agent for AG Studio.

AG Studio's assistant is a multi-agent harness. An orchestrator reads the
schema, the report and the page, then delegates: a *page* agent places widgets
on the grid, and a *widget* agent configures each widget's data mapping. Every
one of those turns is a model call -- and in this demo every one of them is
metered, because they all go through MeterPal's inference path.

The mock LLM normally just echoes the prompt. When a request offers tools, it
plays the agent instead: it reads the tool list to work out which role it is
playing, and it drives the harness through the sequence a real model would --
view the schema, view the report, view the page, delegate to the page agent,
delegate to the widget agent, finish.

Roles share no server-side state. The plan travels between them inside the
delegation instructions as a `SPEC: {...}` line, so every role agrees on the
widget id, type, position and data mapping without a shared store.
"""

from __future__ import annotations

import json
import re
from typing import Any

# The plan, carried between roles in the delegation instructions.
_SPEC_MARKER = "SPEC:"

# Table-qualified field ids. The studio's single fact table is `usage`.
_TABLE = "usage"

# Which field plays the category (x axis / slice) and the value, per shape.
_CATEGORY_BY_TYPE = {
    "line-chart": "period",
    "area-chart": "period",
    "column-chart-grouped": "event_name",
    "column-chart-stacked": "event_name",
    "bar-chart-grouped": "event_name",
    "bar-chart-stacked": "event_name",
    "pie-chart": "event_name",
    "donut-chart": "event_name",
}

# Words that mean "the page agent is not needed -- just talk".
_SUMMARISE_RE = re.compile(r"summar|describe|explain|what does|stand[s]? out", re.I)


def _tool_names(body: dict) -> list[str]:
    return [
        t["function"]["name"]
        for t in (body.get("tools") or [])
        if isinstance(t, dict) and "function" in t
    ]


def _called_tool_calls(messages: list[dict]) -> list[dict]:
    """Every tool call the model has already made in this conversation."""
    calls: list[dict] = []
    for msg in messages or []:
        if msg.get("role") != "assistant":
            continue
        for call in msg.get("tool_calls") or []:
            fn = call.get("function") or {}
            raw = fn.get("arguments") or "{}"
            try:
                args = json.loads(raw) if isinstance(raw, str) else dict(raw)
            except (TypeError, ValueError):
                args = {}
            calls.append({"name": fn.get("name"), "args": args})
    return calls


def _called_names(messages: list[dict]) -> set[str]:
    return {c["name"] for c in _called_tool_calls(messages) if c.get("name")}


def _last_user_text(messages: list[dict]) -> str:
    for msg in reversed(messages or []):
        if msg.get("role") == "user":
            content = msg.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                parts = [
                    part.get("text", "")
                    for part in content
                    if isinstance(part, dict) and part.get("type") == "text"
                ]
                if parts:
                    return " ".join(parts)
    return ""


def _texts_of(value: Any) -> list[str]:
    """Every plain-text block in a message content field."""
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, list):
        out = []
        for part in value:
            if isinstance(part, dict) and part.get("type") == "text":
                text = part.get("text") or ""
                if text:
                    out.append(text)
        return out
    return []


def _extract_spec(text: str) -> dict | None:
    """Pull the plan out of a block of text.

    The plan is one JSON object introduced by a `SPEC:` marker. The object has
    nested objects, so the end is found by matching braces rather than by a
    regular expression -- and strings inside the JSON are skipped, so a brace
    inside a value does not end the object early.
    """
    marker = text.find(_SPEC_MARKER)
    if marker < 0:
        return None
    start = text.find("{", marker)
    if start < 0:
        return None

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    parsed = json.loads(text[start : index + 1])
                except (TypeError, ValueError):
                    return None
                return parsed if isinstance(parsed, dict) else None
    return None


def _spec_from_messages(messages: list[dict]) -> dict | None:
    """Find the plan the orchestrator left for the delegated agent.

    The plan rides in the delegation instructions, which reach the delegated
    agent as a message. The same instructions stay in the orchestrator's own
    history as a tool-call argument -- so the orchestrator can read back the
    plan it wrote and reuse the *same* widget id when it delegates the next
    step. Two places are searched, and the tool-call arguments are parsed as
    JSON first: a raw argument string has its newlines escaped, which would
    hide the `SPEC:` line from a line-based match.
    """
    texts: list[str] = []

    for msg in messages or []:
        texts.extend(_texts_of(msg.get("content")))

        for call in msg.get("tool_calls") or []:
            fn = call.get("function") or {}
            arguments = fn.get("arguments")
            parsed: Any = None
            if isinstance(arguments, str):
                try:
                    parsed = json.loads(arguments)
                except (TypeError, ValueError):
                    parsed = None
            elif isinstance(arguments, dict):
                parsed = arguments
            if not isinstance(parsed, dict):
                continue
            texts.extend(_texts_of(parsed.get("instructions")))
            target = parsed.get("type")
            if isinstance(target, dict):
                texts.extend(_texts_of(target.get("instructions")))

    for text in reversed(texts):
        spec = _extract_spec(text)
        if spec:
            return spec
    return None


def _widget_type_from_prompt(prompt: str) -> str:
    text = (prompt or "").lower()
    if "donut" in text:
        return "donut-chart"
    if "pie chart" in text or "pie " in text:
        return "pie-chart"
    if "bar chart" in text or "bar " in text:
        return "bar-chart-grouped"
    if "column chart" in text or "column " in text:
        return "column-chart-grouped"
    if "area chart" in text or "area " in text:
        return "area-chart"
    if "table" in text or "rows" in text or "detail" in text:
        return "grid"
    if "kpi" in text or "single number" in text or "headline" in text:
        return "value"
    if "line" in text or "over time" in text or "trend" in text:
        return "line-chart"
    if "per day" in text or "daily" in text or "peak" in text:
        return "line-chart"
    return "column-chart-grouped"


def _category_from_prompt(prompt: str, widget_type: str) -> str:
    """The field the widget groups by.

    An explicit "by customer" / "by event" wins. Otherwise the chart type
    decides: a time series groups by date, everything else by feature.
    """
    text = (prompt or "").lower()
    if "by customer" in text:
        return "customer_id"
    if "by event" in text or "by feature" in text:
        return "event_name"
    if widget_type in ("line-chart", "area-chart") or "per day" in text:
        return "period"
    return _CATEGORY_BY_TYPE.get(widget_type, "event_name")


def _value_field_from_prompt(prompt: str) -> str:
    """The field the widget measures."""
    text = (prompt or "").lower()
    if "event" in text and "credits" not in text:
        return "events"
    return "credits"


def _title_for(widget_type: str, category: str, value_field: str) -> str:
    if widget_type == "grid":
        return "Usage detail"
    if value_field == "events":
        noun = "Tracked events"
    else:
        noun = "Credits"
    if category == "period":
        if value_field == "events":
            return "Tracked events per day"
        return "Credits spent per day"
    if category == "customer_id":
        return f"{noun} by customer"
    if category == "event_name":
        return f"{noun} by feature"
    return noun


def _build_spec(prompt: str, widget_type: str, widget_id: str) -> dict:
    """The plan: which widget to build, and how it maps to the data."""
    category = _category_from_prompt(prompt, widget_type)
    value_field = _value_field_from_prompt(prompt)

    return {
        "widgetType": widget_type,
        "widgetId": widget_id,
        "title": _title_for(widget_type, category, value_field),
        "categoryField": f"{_TABLE}.{category}",
        "valueField": f"{_TABLE}.{value_field}",
        "pageId": "usage",
        "layout": {"xTrack": 0, "yTrack": 45, "xSpan": 12, "ySpan": 18},
    }


def _spec_line(spec: dict) -> str:
    return "SPEC: " + json.dumps(spec, separators=(",", ":"))


def _next_widget_id(widget_type: str, calls: list[dict], taken: set[str]) -> str:
    """A widget id that nothing in this conversation or the report already uses.

    The report is read by the `view_report` tool, so its widget ids are known
    before anything is placed. Reusing one would have `add_widget` collide
    with a widget that is already on the canvas.
    """
    used = {
        (c.get("args") or {}).get("widgetId")
        for c in calls
        if c.get("name") in ("add_widget", "configure_widget", "delegate_to")
    }
    used |= set(taken)
    base = f"w-{widget_type}"
    index = 1
    while f"{base}-{index}" in used:
        index += 1
    return f"{base}-{index}"


def _report_widget_ids(messages: list[dict]) -> set[str]:
    """The widget ids already on the canvas.

    The orchestrator reads the report with `view_report` before it plans, so
    the tool result carries the current widget ids. Reading them keeps a
    second request from colliding with the widget the first one added.
    """
    ids: set[str] = set()
    for msg in messages or []:
        if msg.get("role") != "tool":
            continue
        content = msg.get("content")
        text = content if isinstance(content, str) else ""
        if not text:
            continue
        ids.update(re.findall(r'"widgetId"\s*:\s*"([^"]+)"', text))
        try:
            payload = json.loads(text)
        except (TypeError, ValueError):
            continue
        for page in (payload or {}).get("pages") or []:
            if not isinstance(page, dict):
                continue
            widgets = page.get("widgets")
            if isinstance(widgets, dict):
                ids.update(widgets.keys())
    return ids


def _delegated_to(calls: list[dict], role: str) -> bool:
    """Has the orchestrator already delegated to this role?"""
    for call in calls:
        if call.get("name") != "delegate_to":
            continue
        target = (call.get("args") or {}).get("type") or {}
        if isinstance(target, dict) and target.get("id") == role:
            return True
    return False


def _call(name: str, arguments: dict) -> dict:
    return {
        "name": name,
        "arguments": json.dumps(arguments),
    }


def plan_next_turn(body: dict) -> dict | None:
    """Decide the next tool call, or None when the turn should be text.

    Returns `{"name": ..., "arguments": {...}}`.
    """
    tools = _tool_names(body)
    if not tools:
        return None

    messages = body.get("messages") or []
    calls = _called_tool_calls(messages)
    called = _called_names(messages)
    prompt = _last_user_text(messages)

    # -- The page agent: places a widget on the grid. ---------------------
    if "add_widget" in tools:
        spec = _spec_from_messages(messages)
        if spec and "add_widget" not in called:
            layout = spec.get("layout") or {}
            return _call(
                "add_widget",
                {
                    "type": spec["widgetType"],
                    "widgetId": spec["widgetId"],
                    "xTrack": layout.get("xTrack", 0),
                    "yTrack": layout.get("yTrack", 45),
                    "xSpan": layout.get("xSpan", 12),
                    "ySpan": layout.get("ySpan", 18),
                },
            )
        if "view_page" in tools and "view_page" not in called:
            return _call("view_page", {})
        if "complete_task" in tools and "complete_task" not in called:
            return _call(
                "complete_task",
                {"summary": "Widget placed.", "artifacts": []},
            )
        return None

    # -- The widget agent: configures a placed widget. --------------------
    if "configure_widget" in tools:
        spec = _spec_from_messages(messages)
        if spec and "configure_widget" not in called:
            # `configure_widget` is a patch: the widget's new configuration
            # travels in `value`, and `op` says what to do with it.
            return _call(
                "configure_widget",
                {
                    "op": "patch",
                    "widgetId": spec["widgetId"],
                    "value": {
                        "type": spec["widgetType"],
                        "format": {
                            "title": {"enabled": True, "text": spec["title"]}
                        },
                        "dataMapping": {
                            "categoryKey": [{"id": spec["categoryField"]}],
                            "valueKey": [
                                {"id": spec["valueField"], "aggregation": "sum"}
                            ],
                        },
                    },
                },
            )
        if "view_widget" in tools and "view_widget" not in called:
            return _call("view_widget", {"widgetId": spec["widgetId"] if spec else ""})
        if "complete_task" in tools and "complete_task" not in called:
            return _call(
                "complete_task",
                {"summary": "Widget configured.", "artifacts": []},
            )
        return None

    # -- The orchestrator: reads, then delegates. --------------------------
    if "delegate_to" in tools:
        for view in ("view_schema", "view_report", "view_page"):
            if view in tools and view not in called:
                return _call(view, {})

        # A question about the page is answered, not built.
        if _SUMMARISE_RE.search(prompt or ""):
            return None

        # The plan the orchestrator wrote earlier is still in its own history.
        # Reading it back keeps one widget id across the whole delegation --
        # minting a new one here would have the widget agent configure a
        # widget that does not exist.
        spec = _spec_from_messages(messages)
        if not spec:
            widget_type = _widget_type_from_prompt(prompt)
            widget_id = _next_widget_id(
                widget_type, calls, _report_widget_ids(messages)
            )
            spec = _build_spec(prompt, widget_type, widget_id)

        if not _delegated_to(calls, "page"):
            return _call(
                "delegate_to",
                {
                    "type": {"id": "page", "pageId": spec["pageId"]},
                    "instructions": (
                        "Place the widget described below on the page.\n"
                        + _spec_line(spec)
                    ),
                },
            )

        if not _delegated_to(calls, "widget"):
            return _call(
                "delegate_to",
                {
                    "type": {
                        "id": "widget",
                        "widgetType": spec["widgetType"],
                        "widgetId": spec["widgetId"],
                    },
                    "instructions": (
                        "Configure the widget described below.\n"
                        + _spec_line(spec)
                    ),
                },
            )

        if "complete_task" in tools and "complete_task" not in called:
            return _call(
                "complete_task",
                {
                    "summary": f"Added a {spec['widgetType']} widget.",
                    "artifacts": [],
                },
            )
        return None

    return None


def _report_widgets(messages: list[dict]) -> list[tuple[str, str]]:
    """The widgets on the canvas, as (title, type) pairs."""
    found: list[tuple[str, str]] = []
    for msg in messages or []:
        if msg.get("role") != "tool":
            continue
        content = msg.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        try:
            payload = json.loads(content)
        except (TypeError, ValueError):
            continue
        if not isinstance(payload, dict):
            continue
        for page in payload.get("pages") or []:
            if not isinstance(page, dict):
                continue
            for widget_id, widget in (page.get("widgets") or {}).items():
                if not isinstance(widget, dict):
                    continue
                fmt = widget.get("format") or {}
                title = (fmt.get("title") or {}).get("text") or widget_id
                found.append((str(title), str(widget.get("type") or "widget")))
    return found


def final_reply(body: dict) -> str:
    """The closing message, once the agent has nothing left to call.

    The orchestrator's last turn is prose: it reports what the delegation
    produced. Without this the mock would fall back to echoing the prompt,
    which reads like a broken assistant in a demo.
    """
    messages = body.get("messages") or []
    prompt = _last_user_text(messages)

    if _SUMMARISE_RE.search(prompt or ""):
        widgets = _report_widgets(messages)
        if not widgets:
            return (
                "This dashboard has no widgets yet -- the canvas is empty. "
                "Ask me to add a chart and I will build one."
            )
        listed = ", ".join(f"{title} ({kind})" for title, kind in widgets)
        return (
            f"This dashboard has {len(widgets)} widgets: {listed}. "
            "They all read the metered usage table -- one row per day, feature "
            "and customer, where `credits` is what was billed to the wallet and "
            "`events` is how many tracked events produced it."
        )

    spec = _spec_from_messages(messages)
    if not spec:
        return "Done."

    widget_type = spec.get("widgetType") or "widget"
    title = spec.get("title") or widget_type
    return (
        f'Added "{title}" to the Usage page -- a {widget_type} over the metered '
        "usage table, built from this customer's own usage."
    )
