import { describe, expect, test } from "bun:test";
import { parseResetArgs } from "../scripts/reset-tenant.js";

describe("reset tenant arguments", () => {
  test("is a dry run by default", () => {
    expect(parseResetArgs(["--telegram-id", "123456789"])).toEqual({
      telegramId: "123456789",
      approved: false,
      includeLinked: false,
    });
  });

  test("requires an exact numeric Telegram ID", () => {
    expect(() => parseResetArgs(["--telegram-id", "user@example.com"])).toThrow(
      "numeric --telegram-id",
    );
  });

  test("parses both destructive-action guards", () => {
    expect(
      parseResetArgs([
        "--telegram-id",
        "123456789",
        "--include-linked",
        "--yes",
      ]),
    ).toEqual({
      telegramId: "123456789",
      approved: true,
      includeLinked: true,
    });
  });
});
