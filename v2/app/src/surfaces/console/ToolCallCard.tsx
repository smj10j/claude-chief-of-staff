import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { type ToolCall } from "../../state/chatSession";
import {
  countDiff,
  renderEditDiff,
  renderMultiEditDiff,
  renderWriteDiff,
  type DiffLine,
} from "./diffPreview";

/**
 * PRD-116 Phase 2.5 — render a single tool-call as a collapsible
 * card. Diffs for Edit/Write/MultiEdit; arg table + result for
 * everything else; red-edged variant when the tool returned an
 * error.
 *
 * Default state:
 *   - errors: expanded (you want to see what broke)
 *   - file edits: collapsed (the +N −M chip in the header is the
 *     summary; click to expand the diff)
 *   - bash: expanded (the command + output is short usually)
 *   - everything else: collapsed
 */
export function ToolCallCard({ call }: { call: ToolCall }) {
  const isFileEdit =
    call.name === "Edit" ||
    call.name === "Write" ||
    call.name === "MultiEdit";
  const defaultExpanded = call.isError || call.name === "Bash";
  const [expanded, setExpanded] = useState(defaultExpanded);

  const diff =
    call.name === "Edit"
      ? renderEditDiff(call.input)
      : call.name === "Write"
        ? renderWriteDiff(call.input)
        : call.name === "MultiEdit"
          ? renderMultiEditDiff(call.input)
          : null;
  const counts = diff ? countDiff(diff.lines) : null;

  const summary = oneLineSummary(call);

  return (
    <div
      className={`cos-tool-card${call.isError ? " is-error" : ""}${
        expanded ? " is-expanded" : ""
      }`}
    >
      <button
        type="button"
        className="cos-tool-card-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          className="cos-tool-card-chevron"
          aria-hidden
        />
        <span className="cos-tool-card-name">{call.name}</span>
        <span className="cos-tool-card-summary">{summary}</span>
        {counts && (counts.added > 0 || counts.removed > 0) && (
          <span className="cos-tool-card-counts">
            <span className="cos-diff-added">+{counts.added}</span>{" "}
            <span className="cos-diff-removed">−{counts.removed}</span>
          </span>
        )}
        {call.result === null && (
          <span className="cos-tool-card-pending">running…</span>
        )}
        {call.isError && <span className="cos-tool-card-flag">error</span>}
      </button>
      {expanded && (
        <div className="cos-tool-card-body">
          {isFileEdit && diff ? (
            <DiffBlock diff={diff} />
          ) : (
            <ArgsBlock input={call.input} />
          )}
          {call.result !== null && (
            <ResultBlock result={call.result} isError={call.isError} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Pull the most user-facing field out of the tool input as a
 * one-line summary that shows up in the card header.
 *   - file tools → file path
 *   - Bash → command (truncated)
 *   - Glob/Grep → pattern
 *   - other → first string field, fallback to JSON
 */
function oneLineSummary(call: ToolCall): string {
  const r = (call.input ?? {}) as Record<string, unknown>;
  const sf = (k: string): string | null =>
    typeof r[k] === "string" ? (r[k] as string) : null;
  const file = sf("file_path");
  if (file) return shortenPath(file);
  const cmd = sf("command");
  if (cmd) return cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd;
  const pattern = sf("pattern");
  if (pattern) return pattern;
  const url = sf("url");
  if (url) return url;
  const query = sf("query");
  if (query) return query.length > 80 ? `${query.slice(0, 77)}…` : query;
  // Fallback: stringified args.
  try {
    const s = JSON.stringify(call.input);
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  } catch {
    return "";
  }
}

function shortenPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-3).join("/")}`;
}

function DiffBlock({
  diff,
}: {
  diff: { lines: DiffLine[]; filePath: string | null };
}) {
  return (
    <div className="cos-diff">
      {diff.filePath && (
        <div className="cos-diff-path" title={diff.filePath}>
          {diff.filePath}
        </div>
      )}
      <pre className="cos-diff-body">
        {diff.lines.map((line, idx) => (
          <span
            key={idx}
            className={`cos-diff-line cos-diff-line-${line.kind}`}
          >
            <span className="cos-diff-marker">
              {line.kind === "add"
                ? "+"
                : line.kind === "del"
                  ? "−"
                  : line.kind === "meta"
                    ? " "
                    : " "}
            </span>
            {line.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

function ArgsBlock({ input }: { input: unknown }) {
  let pretty: string;
  try {
    pretty = JSON.stringify(input, null, 2);
  } catch {
    pretty = String(input);
  }
  return (
    <pre className="cos-tool-card-args">
      <code>{pretty}</code>
    </pre>
  );
}

function ResultBlock({
  result,
  isError,
}: {
  result: string;
  isError: boolean;
}) {
  // Long results truncate to ~200 lines with a "show all" toggle. We
  // don't aggressively trim — power users want the full output, but
  // a 10k-line `cat` shouldn't blow up the renderer.
  const TRUNCATE_AT = 200;
  const [showAll, setShowAll] = useState(false);
  const lines = result.split("\n");
  const truncated = !showAll && lines.length > TRUNCATE_AT;
  const visible = truncated ? lines.slice(0, TRUNCATE_AT).join("\n") : result;
  return (
    <div className={`cos-tool-card-result${isError ? " is-error" : ""}`}>
      <pre>
        <code>{visible}</code>
      </pre>
      {truncated && (
        <button
          type="button"
          className="cos-btn-link"
          onClick={() => setShowAll(true)}
        >
          show all ({lines.length} lines)
        </button>
      )}
    </div>
  );
}
