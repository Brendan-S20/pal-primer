import { Fragment, type ReactNode } from "react";

// Minimal markdown renderer for AI-generated digests.
// Supports: # / ## / ### headings, **bold**, *italic*, `code`, and - / * bullet lists.
// Intentionally lightweight — no dependency.

function renderInline(text: string): ReactNode[] {
  // Split on **bold**, *italic*, `code` while preserving order.
  const parts: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      parts.push(
        <code key={key++} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

export function MarkdownLite({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let listBuffer: string[] = [];
  let key = 0;

  const flushList = () => {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    blocks.push(
      <ul key={key++} className="ml-5 list-disc space-y-1">
        {items.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
    listBuffer = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      listBuffer.push(bullet[1]);
      continue;
    }
    flushList();
    if (!line.trim()) {
      blocks.push(<div key={key++} className="h-2" />);
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const content = renderInline(h[2]);
      if (level === 1) blocks.push(<h3 key={key++} className="text-base font-semibold">{content}</h3>);
      else if (level === 2) blocks.push(<h4 key={key++} className="text-sm font-semibold">{content}</h4>);
      else blocks.push(<h5 key={key++} className="text-sm font-medium">{content}</h5>);
      continue;
    }
    blocks.push(<p key={key++}>{renderInline(line)}</p>);
  }
  flushList();

  return (
    <div className={className}>
      {blocks.map((b, i) => (
        <Fragment key={i}>{b}</Fragment>
      ))}
    </div>
  );
}
