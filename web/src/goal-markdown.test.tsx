import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GoalMarkdown } from "./goal-markdown";

describe("GoalMarkdown", () => {
  test("renders markdown content as HTML instead of raw markdown", () => {
    const html = renderToStaticMarkup(<GoalMarkdown goal={"# Ship it\n\n- item"} />);

    expect(html).toContain("<h1>Ship it</h1>");
    expect(html).toContain("<li>item</li>");
    expect(html).not.toContain("# Ship it");
  });

  test("uses fallback text when goal markdown is empty", () => {
    const html = renderToStaticMarkup(<GoalMarkdown goal={"   "} />);

    expect(html).toContain("No goal configured in .autoloop/goal.md");
  });

  test("applies a max height and scrolling container", () => {
    const html = renderToStaticMarkup(<GoalMarkdown goal={"Line 1\n\nLine 2"} />);

    expect(html).toContain("max-h-64");
    expect(html).toContain("overflow-auto");
  });
});
