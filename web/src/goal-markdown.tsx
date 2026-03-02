import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const FALLBACK_GOAL_TEXT = "No goal configured in .autoloop/goal.md";

interface GoalMarkdownProps {
  goal: string;
  containerClassName?: string;
}

const DEFAULT_CONTAINER_CLASS =
  "mt-2 max-h-64 overflow-auto rounded-lg border border-white/10 bg-ink/50 p-3";

export function GoalMarkdown({ goal, containerClassName = DEFAULT_CONTAINER_CLASS }: GoalMarkdownProps) {
  const content = goal.trim() || FALLBACK_GOAL_TEXT;

  return (
    <div className={containerClassName}>
      <div className="markdown-body text-sm leading-6 text-mist/90">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}
