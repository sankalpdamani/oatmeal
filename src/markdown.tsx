// Minimal markdown renderer for summaries + chat (headings, lists, checkboxes,
// bold, code). No dependency, no HTML injection.
import React from "react";

function inline(text: string, key: number): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong>);
    else parts.push(<code key={`${key}-${i++}`}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let list: React.ReactNode[] = [];
  let k = 0;

  const flushList = () => {
    if (list.length) {
      out.push(<ul key={`ul-${k++}`}>{list}</ul>);
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (h) {
      flushList();
      out.push(<h2 key={`h-${k++}`}>{h[2]}</h2>);
    } else if (li) {
      const item = li[1];
      const cb = item.match(/^\[([ xX])\]\s*(.*)/);
      if (cb) {
        list.push(
          <li key={`li-${k++}`}>
            <input type="checkbox" readOnly checked={cb[1] !== " "} />
            {inline(cb[2], k)}
          </li>
        );
      } else {
        list.push(<li key={`li-${k++}`}>{inline(item, k)}</li>);
      }
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      out.push(<p key={`p-${k++}`}>{inline(line, k)}</p>);
    }
  }
  flushList();
  return <div className="md">{out}</div>;
}
