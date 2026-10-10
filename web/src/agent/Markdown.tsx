import { Fragment, type ReactNode } from "react";

// A small Markdown renderer for the agent's replies. It builds React elements only (no HTML), and
// links may only be http(s) or relative. Covers what the agent writes: paragraphs, headings, lists,
// quotes, fenced code, tables, **bold**, *italic*, `code` and links.

// The agent's workspace paths (/data/…) are on its sandbox, not pages here: shown as text.
const safeHref = (url: string) => (/^(https?:\/\/|\/(?!\/))/i.test(url) && !url.startsWith("/data/") ? url : null);

function inline(text: string, key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  // order matters: code first (no formatting inside), then links, then emphasis, then bare URLs
  const re = /(`[^`\n]+`)|(\[([^\]\n]+)\]\(([^)\s]+)\))|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*|_([^_\n]+)_)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) {
      const href = safeHref(m[4]);
      out.push(href ? <a key={k} href={href} target={href.startsWith("/") ? undefined : "_blank"} rel="noreferrer">{inline(m[3], k)}</a> : m[3]);
    } else if (m[5]) out.push(<strong key={k}>{inline(m[6], k)}</strong>);
    else if (m[7]) out.push(<em key={k}>{inline(m[8] || m[9], k)}</em>);
    else if (m[10]) out.push(<a key={k} href={m[10]} target="_blank" rel="noreferrer">{m[10].length > 60 ? m[10].slice(0, 57) + "…" : m[10]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const withBreaks = (text: string, key: string) =>
  text.split("\n").map((line, i, all) => (
    <Fragment key={`${key}-l${i}`}>
      {inline(line, `${key}-${i}`)}
      {i < all.length - 1 && <br />}
    </Fragment>
  ));

export function Markdown({ text }: { text: string }) {
  const lines = (text || "").replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  const isList = (l: string) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${b++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*```(\w+)?/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={key}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(4, h[1].length + 2);
      const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={key}>{inline(h[2], key)}</Tag>);
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push(
        <div className="md-table" key={key}>
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c, `${key}h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `${key}r${ri}c${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={key}>{withBreaks(quote.join("\n"), key)}</blockquote>);
      continue;
    }
    if (isList(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const entries: string[] = [];
      while (i < lines.length && (isList(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && entries.length))) {
        if (isList(lines[i])) entries.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        else entries[entries.length - 1] += "\n" + lines[i].trim();
        i++;
      }
      const items = entries.map((e, j) => <li key={j}>{withBreaks(e, `${key}-${j}`)}</li>);
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !isList(lines[i]) && !/^\s*>/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    blocks.push(<p key={key}>{withBreaks(para.join("\n"), key)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
