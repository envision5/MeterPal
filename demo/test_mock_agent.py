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
        if nxt["name"] == "delegate_to":
            delegate_page = nxt
            break
    assert delegate_page is not None, "orchestrator never delegated"
    page_args = json.loads(delegate_page["arguments"])

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
        value = configured[0]["value"]["dataMapping"] if configured else {}
        mapping = {
            "widgetType": added[0]["type"],
            "categoryField": value.get("categoryKey", [{}])[0].get("id"),
            "valueField": value.get("valueKey", [{}])[0].get("id"),
        }
        if mapping != expect:
            print(f"  FAIL: mapping {mapping} != {expect}")
            ok = False
        else:
            print(f"  OK: {mapping}")
        title = value.get("format", {}).get("title", {}).get("text")
        print(f"  title: {title}")

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


results = []
for prompt, expect in CHART_PROMPTS:
    for shape in ("separate", "shared"):
        print(f"\n=== {shape}: {prompt[:48]}... ===")
        results.append(run_chart(prompt, expect, shape))

results.append(run_summarise())

print("\nALL:", "PASS" if all(results) else "FAIL")
sys.exit(0 if all(results) else 1)
