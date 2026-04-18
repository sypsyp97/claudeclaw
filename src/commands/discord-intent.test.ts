import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyThreadIntent } from "./discord-intent";

describe("classifyThreadIntent — hire (English)", () => {
  test("'hire Alice Bob' extracts both names", () => {
    const result = classifyThreadIntent("hire Alice Bob");
    expect(result).toEqual({ action: "hire", names: ["Alice", "Bob"] });
  });

  test("'fire Alice' extracts a single name", () => {
    const result = classifyThreadIntent("fire Alice");
    expect(result).toEqual({ action: "fire", names: ["Alice"] });
  });

  test("'delete bot1 and bot2' splits on 'and'", () => {
    const result = classifyThreadIntent("delete bot1 and bot2");
    expect(result).toEqual({ action: "fire", names: ["bot1", "bot2"] });
  });

  test("'spawn' is treated as hire", () => {
    const result = classifyThreadIntent("spawn worker");
    expect(result?.action).toBe("hire");
    expect(result?.names).toContain("worker");
  });

  test("'deploy' is treated as hire", () => {
    const result = classifyThreadIntent("deploy frontend");
    expect(result?.action).toBe("hire");
    expect(result?.names).toContain("frontend");
  });

  test("'remove' is treated as fire", () => {
    const result = classifyThreadIntent("remove worker");
    expect(result?.action).toBe("fire");
    expect(result?.names).toContain("worker");
  });

  test("'kill' is treated as fire", () => {
    const result = classifyThreadIntent("kill bot1");
    expect(result?.action).toBe("fire");
    expect(result?.names).toContain("bot1");
  });
});

describe("classifyThreadIntent — hire/fire (Chinese)", () => {
  test("'派出 關羽、張飛' splits on Chinese 、", () => {
    const result = classifyThreadIntent("派出 關羽、張飛");
    expect(result).toEqual({ action: "hire", names: ["關羽", "張飛"] });
  });

  test("'撤回 諸葛亮' extracts single name", () => {
    const result = classifyThreadIntent("撤回 諸葛亮");
    expect(result).toEqual({ action: "fire", names: ["諸葛亮"] });
  });

  test("'出征 關羽' is treated as hire", () => {
    const result = classifyThreadIntent("出征 關羽");
    expect(result?.action).toBe("hire");
    expect(result?.names).toContain("關羽");
  });

  test("'上陣 張飛' is treated as hire", () => {
    const result = classifyThreadIntent("上陣 張飛");
    expect(result?.action).toBe("hire");
    expect(result?.names).toContain("張飛");
  });

  test("'迎戰 趙雲' is treated as hire", () => {
    const result = classifyThreadIntent("迎戰 趙雲");
    expect(result?.action).toBe("hire");
    expect(result?.names).toContain("趙雲");
  });

  test("'出戰 黃忠' is treated as hire", () => {
    const result = classifyThreadIntent("出戰 黃忠");
    expect(result?.action).toBe("hire");
    expect(result?.names).toContain("黃忠");
  });

  test("'建立 worker' is treated as hire", () => {
    const result = classifyThreadIntent("建立 worker");
    expect(result?.action).toBe("hire");
    expect(result?.names).toContain("worker");
  });

  test("'開 frontend' is treated as hire", () => {
    const result = classifyThreadIntent("開 frontend");
    expect(result).toEqual({ action: "hire", names: ["frontend"] });
  });

  test("'關閉 frontend' is treated as fire", () => {
    const result = classifyThreadIntent("關閉 frontend");
    expect(result).toEqual({ action: "fire", names: ["frontend"] });
  });

  test("'收回 諸葛亮' is treated as fire", () => {
    const result = classifyThreadIntent("收回 諸葛亮");
    expect(result?.action).toBe("fire");
    expect(result?.names).toContain("諸葛亮");
  });

  test("'叫回來 諸葛亮' is treated as fire", () => {
    const result = classifyThreadIntent("叫回來 諸葛亮");
    expect(result?.action).toBe("fire");
    expect(result?.names).toContain("諸葛亮");
  });

  test("'撤 諸葛亮' standalone verb is treated as fire", () => {
    const result = classifyThreadIntent("撤 諸葛亮");
    expect(result?.action).toBe("fire");
    expect(result?.names).toContain("諸葛亮");
  });

  test("'刪 bot1' is treated as fire", () => {
    const result = classifyThreadIntent("刪 bot1");
    expect(result?.action).toBe("fire");
    expect(result?.names).toContain("bot1");
  });

  test("'關 bot1' is treated as fire", () => {
    const result = classifyThreadIntent("關 bot1");
    expect(result?.action).toBe("fire");
    expect(result?.names).toContain("bot1");
  });

  test("'滾 bot1' is treated as fire", () => {
    const result = classifyThreadIntent("滾 bot1");
    expect(result?.action).toBe("fire");
    expect(result?.names).toContain("bot1");
  });

  test("'派 劉備' standalone verb is treated as hire", () => {
    const result = classifyThreadIntent("派 劉備");
    expect(result?.action).toBe("hire");
    expect(result?.names).toContain("劉備");
  });
});

describe("classifyThreadIntent — keyword position and prefixes", () => {
  test("keyword not at start: '你好，派出 劉備'", () => {
    const result = classifyThreadIntent("你好，派出 劉備");
    expect(result).toEqual({ action: "hire", names: ["劉備"] });
  });

  test("English greeting prefix: 'hey, hire Alice'", () => {
    const result = classifyThreadIntent("hey, hire Alice");
    expect(result?.action).toBe("hire");
    expect(result?.names).toContain("Alice");
  });
});

describe("classifyThreadIntent — name-splitting separators", () => {
  test("comma-separated: 'hire Alice, Bob'", () => {
    const result = classifyThreadIntent("hire Alice, Bob");
    expect(result?.action).toBe("hire");
    expect(result?.names).toEqual(["Alice", "Bob"]);
  });

  test("Chinese comma-separated: 'hire Alice，Bob'", () => {
    const result = classifyThreadIntent("hire Alice，Bob");
    expect(result?.action).toBe("hire");
    expect(result?.names).toEqual(["Alice", "Bob"]);
  });

  test("ampersand-separated: 'hire Alice & Bob'", () => {
    const result = classifyThreadIntent("hire Alice & Bob");
    expect(result?.action).toBe("hire");
    expect(result?.names).toEqual(["Alice", "Bob"]);
  });

  test("'with'-separated: 'hire Alice with Bob'", () => {
    const result = classifyThreadIntent("hire Alice with Bob");
    expect(result?.action).toBe("hire");
    expect(result?.names).toEqual(["Alice", "Bob"]);
  });

  test("Chinese 和-separated: '派出 Alice 和 Bob'", () => {
    const result = classifyThreadIntent("派出 Alice 和 Bob");
    expect(result?.action).toBe("hire");
    expect(result?.names).toEqual(["Alice", "Bob"]);
  });

  test("Chinese 跟-separated: '派出 Alice 跟 Bob'", () => {
    const result = classifyThreadIntent("派出 Alice 跟 Bob");
    expect(result?.action).toBe("hire");
    expect(result?.names).toEqual(["Alice", "Bob"]);
  });

  test("Chinese 與-separated: '派出 Alice 與 Bob'", () => {
    const result = classifyThreadIntent("派出 Alice 與 Bob");
    expect(result?.action).toBe("hire");
    expect(result?.names).toEqual(["Alice", "Bob"]);
  });

  test("trailing punctuation is trimmed", () => {
    const result = classifyThreadIntent("hire Alice.");
    expect(result?.action).toBe("hire");
    expect(result?.names).toEqual(["Alice"]);
  });
});

describe("classifyThreadIntent — null cases", () => {
  test("empty string → null", () => {
    expect(classifyThreadIntent("")).toBeNull();
  });

  test("no keyword → null", () => {
    expect(classifyThreadIntent("hello world")).toBeNull();
  });

  test("'hire' alone with no names → null", () => {
    expect(classifyThreadIntent("hire")).toBeNull();
  });

  test("'派' alone with no names → null", () => {
    expect(classifyThreadIntent("派")).toBeNull();
  });

  test("whitespace-only after keyword → null", () => {
    expect(classifyThreadIntent("hire    ")).toBeNull();
  });

  test("pure chatter with no verb → null", () => {
    expect(classifyThreadIntent("how are you today")).toBeNull();
  });
});

describe("classifyThreadIntent — robustness", () => {
  test("caps names list to at most 10 entries (pathological input)", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `bot${i}`).join(" ");
    const result = classifyThreadIntent(`hire ${fifty}`);
    expect(result).not.toBeNull();
    expect(result?.action).toBe("hire");
    expect(result?.names.length).toBe(10);
  });

  test("ambiguous message with both verbs does not throw", () => {
    let threw = false;
    let result: ReturnType<typeof classifyThreadIntent> = null;
    try {
      result = classifyThreadIntent("hire Alice, fire Bob");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // Must be null or a valid intent shape — don't over-specify which verb wins.
    if (result !== null) {
      expect(["hire", "fire"]).toContain(result.action);
      expect(Array.isArray(result.names)).toBe(true);
    }
  });

  test("drops empty tokens from split result", () => {
    // Double separators that would produce empty tokens if not filtered.
    const result = classifyThreadIntent("hire Alice,, Bob");
    expect(result?.action).toBe("hire");
    expect(result?.names).toEqual(["Alice", "Bob"]);
  });

  test("is synchronous (returns non-Promise)", () => {
    const result = classifyThreadIntent("hire Alice");
    // A Promise would have a .then method; this must not.
    expect(typeof (result as unknown as { then?: unknown })?.then).not.toBe("function");
  });
});

describe("discord-intent.ts — no subprocess / no network", () => {
  test("source file does not import child_process or spawn a subprocess", () => {
    // Resolve the sibling implementation file relative to this test file.
    const implPath = join(import.meta.dir, "discord-intent.ts");
    const source = readFileSync(implPath, "utf8");

    expect(source).not.toContain("child_process");
    expect(source).not.toContain("execFileSync");
    expect(source).not.toContain("spawnSync");
    expect(source).not.toContain("spawn(");
    expect(source).not.toContain("claudeArgv");
  });
});
