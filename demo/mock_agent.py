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

# How a merchant names the dimension a widget should group by. These are
# patterns rather than the literal strings "by customer" / "by event" /
# "per day", because those three were the *only* accepted phrasings: "a table
# of credits used per customer" fell through to the type default and produced
# a widget grouped by the wrong column, with a summary that never mentioned
# the substitution. The vocabulary here is deliberately wider than the demo
# prompts use -- a merchant says "per user", "for each client", "split by
# account", and the agent should not silently answer a different question.
_GROUP_PREFIX = (
    r"(?:group(?:ed|ing)?\s+by|broken\s+down\s+by|split\s+by"
    r"|by|per|for\s+each|for\s+every|across)"
)

_CUSTOMER_GROUP_RE = re.compile(
    _GROUP_PREFIX + r"\s+(?:customer|user|account|tenant|payer|client|subscriber)s?\b"
)
_EVENT_GROUP_RE = re.compile(
    _GROUP_PREFIX + r"\s+(?:event|feature|model|product|endpoint|operation)s?\b"
)
_PERIOD_GROUP_RE = re.compile(
    r"\b(?:by|per|each|every)\s+(?:day|date|week|month|hour)\b"
    r"|\bdaily\b|\bover\s+time\b|\btrend\b"
)


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


# A delegation reaches the delegated agent as a user message, and it carries
# the plan. It is not something the merchant typed.
_DELEGATION_PREFIXES = (
    "Place the widget described below",
    "Configure the widget described below",
)


def _is_merchant_prompt(message: dict) -> bool:
    """Is this message the merchant asking for something?

    Not every user-role message is: a delegation instruction is also a user
    message, and it contains the `SPEC:` line. Anchoring a turn on one of
    those would make the second request in a conversation look like the first
    one still in progress.
    """
    if message.get("role") != "user":
        return False
    text = " ".join(_texts_of(message.get("content"))).strip()
    if not text:
        return False
    if _SPEC_MARKER in text:
        return False
    return not text.startswith(_DELEGATION_PREFIXES)


def _current_turn(messages: list[dict]) -> list[dict]:
    """The messages since the merchant's latest request.

    A studio conversation accumulates: the orchestrator's history still holds
    the reads, the delegation and the plan from the previous thing the
    merchant asked for. Every "have I already done this?" question has to be
    asked against the current turn only -- asked against the whole history,
    the second request finds `view_page` already called, a `SPEC` already
    written and the delegation already made, and answers with the previous
    turn's summary.

    For a delegated agent the instructions arrive as the user message and
    everything after it belongs to that one job, so the slice is the whole
    list and this is a no-op there.
    """
    for index in range(len(messages) - 1, -1, -1):
        if _is_merchant_prompt(messages[index]):
            return messages[index:]
    return messages


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

    The phrasings are matched as patterns rather than as literal strings. "by
    customer" was the only accepted form, so "a table of credits used per
    customer" fell through to the default and built a table grouped by
    *feature* -- a correct-looking widget answering a different question, with
    a summary that never mentioned the substitution.
    """
    text = (prompt or "").lower()
    if _CUSTOMER_GROUP_RE.search(text):
        return "customer_id"
    if _EVENT_GROUP_RE.search(text):
        return "event_name"
    if widget_type in ("line-chart", "area-chart") or _PERIOD_GROUP_RE.search(text):
        return "period"
    return _CATEGORY_BY_TYPE.get(widget_type, "event_name")


def _value_field_from_prompt(prompt: str) -> str:
    """The field the widget measures."""
    text = (prompt or "").lower()
    if "event" in text and "credits" not in text:
        return "events"
    return "credits"


def _title_for(widget_type: str, category: str, value_field: str) -> str:
    if value_field == "events":
        noun = "Tracked events"
    else:
        noun = "Credits"
    # A table gets the same "what, by what" name a chart gets. It used to be
    # the constant "Usage detail", which is the seeded table's own title -- so
    # asking for a table added a second tile with an identical heading, and the
    # page read as though the first one had been duplicated.
    if widget_type == "grid":
        noun = "Usage"
    if category == "period":
        if value_field == "events":
            return "Tracked events per day"
        return "Usage by day" if widget_type == "grid" else "Credits spent per day"
    if category == "customer_id":
        return f"{noun} by customer"
    if category == "event_name":
        return f"{noun} by feature"
    return noun


def _build_spec(
    prompt: str, widget_type: str, widget_id: str, layouts: dict | None = None
) -> dict:
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
        # Below whatever is already placed, not at a constant. The constant
        # was where the seeded table ends, so the second widget an agent added
        # landed exactly on the first one and Studio's validator logged an
        # overlap before our repair pass moved it.
        "layout": _free_slot(layouts or {}),
    }


def _spec_line(spec: dict) -> str:
    return "SPEC: " + json.dumps(spec, separators=(",", ":"))


def _format_for(widget_type: str, title: str) -> dict:
    """The presentation half of a widget's configuration.

    A grouped grid turns its grand-total row off. Grouping aggregates the
    dimension column with `first`, and the footer aggregates it the same way
    -- so the total row repeats the customer name from the row above it,
    reading as a duplicate row of data rather than a total. The body rows
    already carry the totals, so the footer goes. An ungrouped grid keeps
    its footer: there the label lands in an empty first column and reads
    correctly as "Total".
    """
    fmt: dict = {"title": {"enabled": True, "text": title}}
    if widget_type in ("grid", "pivot-grid"):
        fmt["style"] = {"grandTotalRow": {"enabled": False}}
    return fmt


def _mapping_for(widget_type: str, category_field: str, value_field: str) -> dict:
    """The dataMapping a widget of this type actually reads.

    A widget is a shell plus a mapping, and the mapping keys are per-type: a
    grid reads `cols`, a chart reads `categoryKey`/`valueKey`, a KPI reads
    `value`.

    The shapes differ by more than the key names. A chart's `categoryKey` is a
    plain dimension (`{id}`), but every entry in a grid's `cols` must carry an
    `aggregation` -- the schema is a union whose every branch requires one, and
    an entry that fails validation is dropped rather than rejected. That is how
    a table widget came out with `cols: []`: a correct-looking mapping, an
    empty grid, and no error anywhere.
    """
    if widget_type in ("grid", "pivot-grid"):
        return {
            "cols": [
                # "first" groups: one row per distinct category.
                {"id": category_field, "aggregation": "first"},
                {"id": value_field, "aggregation": "sum"},
            ]
        }
    if widget_type == "value":
        return {"value": [{"id": value_field, "aggregation": "sum"}]}
    return {
        "categoryKey": [{"id": category_field}],
        "valueKey": [{"id": value_field, "aggregation": "sum"}],
    }


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


def _find_key(payload: Any, key: str) -> Any:
    """The first value for `key` anywhere in a tool result.

    Studio's tools answer `{success, response, data}`, so the interesting part
    is nested one level down -- and not always at the same depth. Walking the
    payload is cheaper than encoding every tool's envelope here, and it cannot
    silently stop matching when a tool adds a wrapper.
    """
    if isinstance(payload, dict):
        if key in payload:
            return payload[key]
        for value in payload.values():
            found = _find_key(value, key)
            if found is not None:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = _find_key(item, key)
            if found is not None:
                return found
    return None


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
        for page in _find_key(payload, "pages") or []:
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


def _layouts_from_messages(messages: list[dict]) -> dict[str, dict]:
    """Every widget's box, as the `view_page` tool reported it.

    `view_report` answers with counts and types only -- no geometry -- so a
    planner reading just that has to guess where the widgets are. Guessing is
    what put the agent's chart on top of the agent's table: both specs said
    `yTrack: 45`, because that constant was the only thing the planner knew.

    `view_page` does return the boxes (`{xTrack, yTrack, xSpan, ySpan}` per
    widget), and the orchestrator already calls it before planning, so the
    layout is in the history by the time a spec is built.
    """
    layouts: dict[str, dict] = {}
    for msg in messages or []:
        if msg.get("role") != "tool":
            continue
        content = msg.get("content")
        text = content if isinstance(content, str) else ""
        if not text:
            continue
        try:
            payload = json.loads(text)
        except (TypeError, ValueError):
            continue
        widgets = _find_key(payload, "widgets")
        if not isinstance(widgets, dict):
            continue
        for widget_id, box in widgets.items():
            if isinstance(box, dict) and "yTrack" in box:
                layouts[widget_id] = box
    return layouts


# The canvas is 24 tracks wide and a row is one track tall.
_CANVAS_WIDTH = 24
_DEFAULT_SPAN = {"xSpan": 12, "ySpan": 18}
# A few empty rows between the new tile and the one above it, so the page
# reads as a layout rather than a stack.
_GAP_TRACKS = 3


def _free_slot(layouts: dict[str, dict], span: dict | None = None) -> dict:
    """The first empty box below everything already on the page.

    Placing below the lowest occupied row is what a person would do, and it
    means the widget arrives where the reader's eye goes next -- no overlap to
    repair, and no validator error in the console mid-demo.
    """
    size = {**_DEFAULT_SPAN, **(span or {})}
    lowest = 0
    for box in layouts.values():
        try:
            bottom = int(box.get("yTrack", 0)) + int(box.get("ySpan", 0))
        except (TypeError, ValueError):
            continue
        lowest = max(lowest, bottom)

    return {
        "xTrack": 0,
        "yTrack": lowest + _GAP_TRACKS if lowest else 0,
        "xSpan": min(size["xSpan"], _CANVAS_WIDTH),
        "ySpan": size["ySpan"],
    }


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
    # Only this turn's work counts as done -- see `_current_turn`.
    turn = _current_turn(messages)
    calls = _called_tool_calls(turn)
    called = _called_names(turn)
    prompt = _last_user_text(messages)

    # -- The page agent: places a widget on the grid. ---------------------
    if "add_widget" in tools:
        spec = _spec_from_messages(turn)
        # The placer is the role that reads the page, and its own `view_page`
        # result is the only trustworthy source for where things are: the
        # plan's layout is written before the page is read and is usually
        # empty. Trusting it is what put the chart on top of the table, which
        # Studio's validator logged as a layout failure on screen.
        observed = _layouts_from_messages(turn)
        if not observed and "view_page" in tools and "view_page" not in called:
            return _call("view_page", {})
        if spec and "add_widget" not in called:
            layout = spec.get("layout") or {}
            if observed:
                layout = _free_slot(observed, layout)
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
        spec = _spec_from_messages(turn)
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
                        "format": _format_for(spec["widgetType"], spec["title"]),
                        "dataMapping": _mapping_for(
                            spec["widgetType"], spec["categoryField"], spec["valueField"]
                        ),
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
        spec = _spec_from_messages(turn)
        if not spec:
            widget_type = _widget_type_from_prompt(prompt)
            widget_id = _next_widget_id(
                widget_type, calls, _report_widget_ids(turn)
            )
            spec = _build_spec(
                prompt, widget_type, widget_id, _layouts_from_messages(turn)
            )

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
        widgets = _report_widgets(_current_turn(messages))
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

    spec = _spec_from_messages(_current_turn(messages))
    if not spec:
        return "Done."

    widget_type = spec.get("widgetType") or "widget"
    title = spec.get("title") or widget_type
    reply = (
        f'Added "{title}" to the Usage page -- a {widget_type} over the metered '
        "usage table, built from this customer's own usage."
    )
    # Grouping by customer is a request the page can technically honour but
    # cannot usefully answer: the studio's data source is already scoped to the
    # selected customer, so a per-customer widget has exactly one row -- the
    # total for the customer you are looking at. Building it and saying so is
    # honest; quietly grouping by feature instead would have produced a
    # convincing widget answering a question nobody asked.
    if str(spec.get("categoryField") or "").endswith(".customer_id"):
        reply += (
            " One thing worth knowing: this page's data source is scoped to a "
            "single customer, so grouped by customer it holds one row -- their "
            "own total. Ask for a breakdown by feature or by day to see the "
            "shape of it."
        )
    return reply
