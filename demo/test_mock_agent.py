"""Offline check of mock_agent.

Covers the three chart prompts the studio offers, the summarise prompt, and
the two conversation shapes the harness can have:

  separate -- each role gets a fresh conversation, and the plan travels in the
              delegation instructions.
  shared   -- the orchestrator sees the delegated agents' tool calls in its
              own history, so it must read the plan back rather than mint a
              second widget id.
"""

import json
import sys

sys.path.insert(0, "C:/Users/craig/MeterPal/demo")

from mock_agent import _extract_spec as extract_spec
from mock_agent import _category_from_prompt as category_from_prompt
from mock_agent import final_reply, plan_next_turn

CHART_PROMPTS = [
    (
        "Add a chart of credits spent per day for this customer, so I can see when usage peaked.",
        {"widgetType": "line-chart", "categoryField": "usage.period", "valueField": "usage.credits"},
    ),
    (
        "Add a chart of credits by event name, so I can see which feature is costing the most.",
        {"widgetType": "column-chart-grouped", "categoryField": "usage.event_name", "valueField": "usage.credits"},
    ),
    (
        "Add a chart of tracked events per day for this customer, so I can see how busy it is.",
        {"widgetType": "line-chart", "categoryField": "usage.period", "valueField": "usage.events"},
    ),
    # A grid reads `cols`, not `categoryKey`/`valueKey`. This case exists
    # because a table widget configured with a chart's mapping is not an error
    # anywhere in the stack -- it just renders "No Rows To Show".
    (
        "Add a table of usage by customer, one row per customer, showing total credits used.",
        {"widgetType": "grid", "categoryField": "usage.customer_id", "valueField": "usage.credits"},
    ),
    # The wording a merchant actually uses. "by customer" was matched as a
    # literal string, so "per customer" fell through to the type default and
    # built a table grouped by *feature* -- right shape, wrong question, and
    # a summary that never mentioned the substitution.
    (
        "Add a table of credits used per customer.",
        {"widgetType": "grid", "categoryField": "usage.customer_id", "valueField": "usage.credits"},
    ),
]

SUMMARISE_PROMPT = (
    "Summarise what this dashboard shows: every widget, the fields it reads, and what stands out."
)


def mk_tools(names):
    return [{"type": "function", "function": {"name": n, "parameters": {}}} for n in names]


ORCH = [
    "view_schema",
    "view_report",
    "view_page",
    "view_plan",
    "update_plan",
    "clear_plan",
    "rename_thread",
    "delegate_to",
]
PAGE = [
    "view_schema",
    "view_page",
    "view_plan",
    "add_page_filter",
    "remove_page_filter",
    "add_widget",
    "position_widget",
    "remove_widget",
    "complete_task",
]
WIDGET = [
    "view_plan",
    "view_widget",
    "view_schema",
    "add_widget_filter",
    "remove_widget_filter",
    "configure_widget",
    "complete_task",
]


def assistant_call(name, args):
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": f"c-{name}",
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }
        ],
    }


def tool_result(call_id, payload):
    return {"role": "tool", "tool_call_id": call_id, "content": json.dumps(payload)}


def drive(body, max_turns=8):
    made = []
    for _ in range(max_turns):
        nxt = plan_next_turn(body)
        if nxt is None:
            break
        args = json.loads(nxt["arguments"])
        made.append((nxt["name"], args))
        body["messages"].append(assistant_call(nxt["name"], args))
    return made


def run_chart(prompt, expect, shape):
    orch = {"tools": mk_tools(ORCH), "messages": [{"role": "user", "content": prompt}]}

    delegate_page = None
    for _ in range(8):
        nxt = plan_next_turn(orch)
        if nxt is None:
            break
        args = json.loads(nxt["arguments"])
        orch["messages"].append(assistant_call(nxt["name"], args))
        if nxt["name"] == "view_page":
            # The real tool answers with every widget's box. The planner has
            # to place the new tile below these, so the fixture has to carry
            # a box -- otherwise the test cannot tell a placed widget from a
            # guessed one.
            orch["messages"].append(
                tool_result(
                    "c-view_page",
                    {
                        "success": True,
                        "response": "Found 2 widget(s) in layout.",
                        "data": {
                            "widgets": {
                                "kpi-credits": {
                                    "xTrack": 0,
                                    "yTrack": 0,
                                    "xSpan": 6,
                                    "ySpan": 5,
                                },
                                "usage-table": {
                                    "xTrack": 0,
                                    "yTrack": 21,
                                    "xSpan": 24,
                                    "ySpan": 18,
                                },
                            },
                            "pageLayout": {},
                            "filters": [],
                            "issues": [],
                        },
                    },
                )
            )
        if nxt["name"] == "delegate_to":
            delegate_page = nxt
            break
    assert delegate_page is not None, "orchestrator never delegated"
    page_args = json.loads(delegate_page["arguments"])

    # The plan must land under the seeded table (which ends at track 39), not
    # at the constant that used to sit on top of it.
    spec = extract_spec(page_args["instructions"])
    assert spec is not None, "no SPEC in the delegation"
    y = spec["layout"]["yTrack"]
    if y <= 39:
        print(f"  FAIL: layout yTrack {y} collides with the seeded table")
        return False
    print(f"  OK: layout yTrack {y} sits below the seeded table")

    page = {
        "tools": mk_tools(PAGE),
        "messages": [{"role": "user", "content": page_args["instructions"]}],
    }
    page_calls = drive(page)

    if shape == "shared":
        for name, args in page_calls:
            orch["messages"].append(assistant_call(name, args))

    delegate_widget = plan_next_turn(orch)
    assert delegate_widget and delegate_widget["name"] == "delegate_to", "no widget delegation"
    widget_args = json.loads(delegate_widget["arguments"])
    orch["messages"].append(assistant_call(delegate_widget["name"], widget_args))

    widget = {
        "tools": mk_tools(WIDGET),
        "messages": [{"role": "user", "content": widget_args["instructions"]}],
    }
    widget_calls = drive(widget)

    added = [a for n, a in page_calls if n == "add_widget"]
    configured = [a for n, a in widget_calls if n == "configure_widget"]
    completed = [a for n, a in widget_calls + page_calls if n == "complete_task"]

    ok = True
    if not added:
        print("  FAIL: no widget added")
        ok = False
    if not configured:
        print("  FAIL: widget not configured")
        ok = False
    elif configured[0]["widgetId"] != added[0]["widgetId"]:
        print(
            f"  FAIL: configured {configured[0]['widgetId']} but added {added[0]['widgetId']}"
        )
        ok = False

    if added:
        configured_value = configured[0]["value"] if configured else {}
        # `value` is the whole patch: `dataMapping` plus `format`. The title
        # lives in `format`, so reading it off the mapping returned None and
        # the check silently passed nothing -- which is how a duplicated tile
        # title ("Usage detail", the seeded table's own name) shipped.
        value = configured_value.get("dataMapping") or {}
        # Grids read `cols`; charts read `categoryKey`/`valueKey`.
        cols = value.get("cols") or []
        mapping = {
            "widgetType": added[0]["type"],
            "categoryField": (
                cols[0].get("id")
                if cols
                else (value.get("categoryKey") or [{}])[0].get("id")
            ),
            "valueField": (
                cols[-1].get("id")
                if cols
                else (value.get("valueKey") or [{}])[0].get("id")
            ),
        }
        if mapping != expect:
            print(f"  FAIL: mapping {mapping} != {expect}")
            ok = False
        else:
            print(f"  OK: {mapping}")
        title = ((configured_value.get("format") or {}).get("title") or {}).get("text")
        print(f"  title: {title}")
        if title != spec["title"]:
            print(f"  FAIL: title {title!r} != plan {spec['title']!r}")
            ok = False
        elif title == "Usage detail":
            # The seeded table's own title. Reusing it reads as a duplicate.
            print("  FAIL: title reuses the seeded table's name")
            ok = False
        else:
            print("  OK: title matches the plan and is not the seeded one")

    if not completed:
        print("  FAIL: no complete_task")
        ok = False
    else:
        print(f"  complete_task summary: {completed[0].get('summary')}")

    reply = final_reply({"tools": mk_tools(ORCH), "messages": orch["messages"]})
    print(f"  final reply: {reply}")
    return ok


def run_summarise():
    print("\n=== summarise ===")
    orch = {"tools": mk_tools(ORCH), "messages": [{"role": "user", "content": SUMMARISE_PROMPT}]}

    made = []
    for _ in range(8):
        nxt = plan_next_turn(orch)
        if nxt is None:
            break
        args = json.loads(nxt["arguments"])
        made.append(nxt["name"])
        orch["messages"].append(assistant_call(nxt["name"], args))
        if nxt["name"] == "view_report":
            orch["messages"].append(
                tool_result(
                    "c-view_report",
                    {
                        "selectedPageId": "usage",
                        "pages": [
                            {
                                "id": "usage",
                                "widgets": {
                                    "kpi-credits": {
                                        "type": "value",
                                        "format": {"title": {"enabled": True, "text": "Credits spent"}},
                                    },
                                    "by-feature": {
                                        "type": "donut-chart",
                                        "format": {"title": {"enabled": True, "text": "Credits by feature"}},
                                    },
                                },
                            }
                        ],
                    },
                )
            )

    print("  orchestrator calls:", made)
    reply = final_reply({"tools": mk_tools(ORCH), "messages": orch["messages"]})
    print("  final reply:", reply)

    ok = "delegate_to" not in made
    print("  OK: answered without delegating" if ok else "  FAIL: delegated")
    ok = ok and "Credits spent" in reply and "Credits by feature" in reply
    print("  OK: summary names the widgets" if ok else "  FAIL: summary missing widgets")
    return ok


def run_placement():
    """The page agent places the widget below what is already on the page.

    The plan's layout is written before the page is read and can be empty, so
    the role that actually places the widget has to consult its own
    `view_page` result. When it did not, the second widget an agent added
    landed on top of the first and Studio logged a layout validation failure
    on screen -- the page ended up correct only because a repair pass moved it
    afterwards.
    """
    print("\n=== placement ===")
    instructions = (
        "Place the widget described below on the page.\n"
        'SPEC: {"widgetType":"column-chart-grouped","widgetId":"w-chart-1",'
        '"title":"Credits by feature","categoryField":"usage.event_name",'
        '"valueField":"usage.credits","pageId":"usage",'
        '"layout":{"xTrack":0,"yTrack":0,"xSpan":12,"ySpan":18}}'
    )
    body = {"tools": mk_tools(PAGE), "messages": [{"role": "user", "content": instructions}]}

    added = None
    for _ in range(6):
        nxt = plan_next_turn(body)
        if nxt is None:
            break
        args = json.loads(nxt["arguments"])
        body["messages"].append(assistant_call(nxt["name"], args))
        if nxt["name"] == "view_page":
            body["messages"].append(
                tool_result(
                    "c-view_page",
                    {
                        "success": True,
                        "response": "Found 2 widget(s) in layout.",
                        "data": {
                            "widgets": {
                                # The agent's own grid, already placed.
                                "w-grid-1": {
                                    "xTrack": 0,
                                    "yTrack": 42,
                                    "xSpan": 12,
                                    "ySpan": 18,
                                },
                                "usage-table": {
                                    "xTrack": 0,
                                    "yTrack": 21,
                                    "xSpan": 24,
                                    "ySpan": 18,
                                },
                            }
                        },
                    },
                )
            )
        if nxt["name"] == "add_widget":
            added = args
            break

    if not added:
        print("  FAIL: page agent never placed the widget")
        return False

    y = added["yTrack"]
    # Below the agent's own grid (42 + 18 = 60), not on top of it and not at
    # the plan's 0.
    if y < 60:
        print(f"  FAIL: placed at yTrack {y}, on top of w-grid-1 (42..60)")
        return False
    print(f"  OK: placed at yTrack {y}, clear of w-grid-1 (42..60)")
    return True


def run_follow_up():
    """A second request in the same conversation still builds something.

    The orchestrator's history keeps the first turn's reads, plan and
    delegation. When "have I already done this?" was answered against the
    whole history, the second request found everything already done and
    replied with text -- no widget, no error, nothing on screen.
    """
    print("\n=== follow-up turn ===")
    first = 'SPEC: {"widgetType":"grid","widgetId":"w-grid-1","title":"Usage by customer"}'
    messages = [
        {"role": "user", "content": "Add a table of usage by customer."},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "view_schema", "arguments": "{}"}}
        ]},
        {"role": "tool", "tool_call_id": "c1", "content": '{"success":true,"data":{"tables":[]}}'},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c2", "type": "function",
             "function": {"name": "view_page", "arguments": "{}"}}
        ]},
        {"role": "tool", "tool_call_id": "c2",
         "content": '{"success":true,"data":{"widgets":{}}}'},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c3", "type": "function",
             "function": {"name": "delegate_to",
                          "arguments": json.dumps({"type": {"id": "page"},
                                                   "instructions": first})}}
        ]},
        {"role": "tool", "tool_call_id": "c3", "content": '{"success":true}'},
        {"role": "assistant", "content": 'Added "Usage by customer".'},
        # The judge asks for something else, in the same conversation.
        {"role": "user", "content": "Add a column chart of credits by feature."},
    ]

    nxt = plan_next_turn({"tools": mk_tools(ORCH), "messages": messages})
    if nxt is None:
        print("  FAIL: second request answered with text, no work done")
        return False

    name = nxt["name"]
    if name not in ("view_schema", "view_report", "view_page", "delegate_to"):
        print(f"  FAIL: unexpected first step {name}")
        return False
    print(f"  OK: second request starts with {name}")
    return True


def run_phrasings():
    """Every way a merchant names a dimension lands on the right column.

    Only three literal strings used to be understood -- "by customer", "by
    event", "per day". Anything else was silently answered with a widget
    grouped by a different column, which is worse than refusing: the widget
    renders, it has a plausible title, and it is about something else.
    """
    print("\n=== grouping phrasings ===")
    cases = [
        ("Add a table of credits used per customer.", "grid", "customer_id"),
        ("Show credits by customer.", "column-chart-grouped", "customer_id"),
        ("Break credits down by user.", "column-chart-grouped", "customer_id"),
        ("A table of usage for each customer.", "grid", "customer_id"),
        ("Credits by client, please.", "column-chart-grouped", "customer_id"),
        ("Grouped by account.", "grid", "customer_id"),
        ("Credits by feature.", "column-chart-grouped", "event_name"),
        ("A table of credits per day.", "grid", "period"),
        # No dimension named at all -- the widget type still decides.
        ("Add a chart of credits.", "column-chart-grouped", "event_name"),
        # "for this customer" is scoping, not grouping: the page is already
        # scoped to one customer, so it must not turn a time series into a
        # one-row per-customer chart.
        (
            "Add a chart of credits spent per day for this customer.",
            "line-chart",
            "period",
        ),
    ]
    ok = True
    for prompt, widget_type, expect in cases:
        got = category_from_prompt(prompt, widget_type)
        if got != expect:
            print(f"  FAIL: {prompt!r} -> {got}, expected {expect}")
            ok = False
        else:
            print(f"  OK: {prompt!r} -> {got}")
    return ok


def run_scoped_note():
    """A per-customer widget is built, and the reply admits it holds one row.

    The studio's data source is scoped to the selected customer, so grouping
    by customer is a one-row table by construction. Building it and saying so
    is honest; the alternative -- quietly grouping by feature instead -- is a
    convincing widget answering a question nobody asked.
    """
    print("\n=== scoped-per-customer note ===")
    spec = (
        'SPEC: {"widgetType":"grid","widgetId":"w-grid-1","title":"Usage by customer",'
        '"categoryField":"usage.customer_id","valueField":"usage.credits",'
        '"pageId":"usage","layout":{"xTrack":0,"yTrack":42,"xSpan":12,"ySpan":18}}'
    )
    messages = [
        {"role": "user", "content": "Add a table of credits used per customer."},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "delegate_to",
                          "arguments": json.dumps({"type": {"id": "page"},
                                                   "instructions": spec})}}
        ]},
        {"role": "tool", "tool_call_id": "c1", "content": '{"success":true}'},
    ]
    reply = final_reply({"tools": mk_tools(ORCH), "messages": messages})
    print(f"  final reply: {reply}")

    ok = "Usage by customer" in reply and "one row" in reply
    print("  OK: reply names the widget and the one-row consequence" if ok
          else "  FAIL: reply does not disclose the single-row scoping")
    return ok


results = []
for prompt, expect in CHART_PROMPTS:
    for shape in ("separate", "shared"):
        print(f"\n=== {shape}: {prompt[:48]}... ===")
        results.append(run_chart(prompt, expect, shape))

results.append(run_summarise())
results.append(run_placement())
results.append(run_follow_up())
results.append(run_phrasings())
results.append(run_scoped_note())

print("\nALL:", "PASS" if all(results) else "FAIL")
sys.exit(0 if all(results) else 1)
