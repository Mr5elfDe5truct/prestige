// Fast checks for the pure helpers in src/tools.ts. The modules it imports talk to Tauri and the tool server,
// so they're stubbed out here.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/backends", () => ({ errMsg: (e: unknown) => String(e), http: vi.fn() }));
vi.mock("../src/knowledge", () => ({ libraryNote: () => "", readyDocs: () => [], searchFilesTool: vi.fn() }));

import { describeCall, fitToolResults, groupsWithin, loadToolsSpec, splitGroups, tokensIn, wanted, withoutToolCalls, type ToolDef } from "../src/tools";

const tool = (name: string, group: string, server: string, size = 0): ToolDef => ({
  name,
  group,
  server,
  op: name,
  description: "x".repeat(size),
  parameters: { type: "object", properties: {} },
  confirm: false,
});

describe("tokensIn", () => {
  it("counts about 3 characters a token, rounding up", () => {
    expect(tokensIn("")).toBe(0);
    expect(tokensIn("abc")).toBe(1);
    expect(tokensIn("abcd")).toBe(2);
  });
});

describe("groupsWithin", () => {
  const tools = [
    tool("web_search", "web", ""),
    tool("small_op", "filesystem", "filesystem", 300),
    tool("big_op", "desktop", "desktop", 3000),
  ];
  const all = new Set(["web", "filesystem", "desktop"]);

  it("keeps everything when it fits", () => {
    const { keep, dropped } = groupsWithin(tools, all, 100_000);
    expect([...keep].sort()).toEqual(["desktop", "filesystem", "web"]);
    expect(dropped).toEqual([]);
  });

  it("drops the biggest server group first", () => {
    const { keep, dropped } = groupsWithin(tools, all, 500);
    expect(keep.has("desktop")).toBe(false);
    expect(keep.has("filesystem")).toBe(true);
    expect(dropped.map((d) => d.id)).toEqual(["desktop"]);
  });

  it("never drops Prestige's own groups", () => {
    const { keep } = groupsWithin(tools, all, 1);
    expect(keep.has("web")).toBe(true);
    expect(keep.has("desktop")).toBe(false);
    expect(keep.has("filesystem")).toBe(false);
  });
});

describe("splitGroups", () => {
  const tools = [tool("web_search", "web", ""), tool("read_file", "filesystem", "filesystem"), tool("run", "desktop", "desktop"), tool("wiki", "wikipedia", "wikipedia")];
  const groups = new Set(["web", "filesystem", "desktop", "wikipedia", "browser"]);

  it("sends Prestige's own groups in full and offers the rest by name", () => {
    const { full, later } = splitGroups(tools, groups, "What's the capital of France?", new Set());
    expect([...full]).toEqual(["web"]);
    expect(later).toEqual(["filesystem", "desktop", "wikipedia"]); // browser has no tools, so isn't offered
  });

  it("loads what the message clearly needs, and what this chat loaded before", () => {
    const { full } = splitGroups(tools, groups, "Read notes.txt in my Documents folder", new Set(["wikipedia"]));
    expect([...full].sort()).toEqual(["filesystem", "web", "wikipedia"]);
  });
});

describe("wanted", () => {
  it("matches a group's words, id or label", () => {
    expect(wanted("desktop", "open PowerShell and list processes")).toBe(true);
    expect(wanted("wikipedia", "look it up on Wikipedia")).toBe(true);
    expect(wanted("browser", "tell me a joke")).toBe(false);
  });
});

describe("loadToolsSpec", () => {
  it("lists each group on one line with its tool count", () => {
    const spec = loadToolsSpec([tool("a", "desktop", "desktop"), tool("b", "desktop", "desktop")], ["desktop"]);
    expect(spec.function.name).toBe("load_tools");
    expect(spec.function.description).toMatch(/- desktop: .*\(2 tools\)/);
    expect(spec.function.parameters.properties.group.enum).toEqual(["desktop"]);
  });
});

describe("withoutToolCalls", () => {
  it("removes typed tool calls, closed or not", () => {
    expect(withoutToolCalls('Hi <tool_call>{"name":"x"}</tool_call> there')).toBe("Hi  there");
    expect(withoutToolCalls("Answer <tool_call>{unfinished")).toBe("Answer");
  });
});

describe("fitToolResults", () => {
  it("shortens older results but never the newest", () => {
    const long = "y".repeat(3000);
    const messages: any[] = [
      { role: "user", content: "q" },
      { role: "tool", content: long },
      { role: "tool", content: long },
    ];
    expect(fitToolResults(messages, 1500, 100)).toBe(true);
    expect(messages[1].content.length).toBeLessThan(500);
    expect(messages[2].content).toBe(long);
  });
});

describe("describeCall", () => {
  it("shows the first string argument, cut to 60 characters", () => {
    expect(describeCall("web_search", { query: "llama.cpp release" })).toBe('web_search · llama.cpp release');
    expect(describeCall("x", {})).toBe("x");
    expect(describeCall("x", { a: "z".repeat(80) }).length).toBe("x · ".length + 58);
  });
});
