/** A unified diff, one coloured line per diff line. The text is shown literally, never parsed. */
export function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="code diff" aria-label="Diff">
      {diff.split("\n").map((line, i) => {
        const kind =
          line.startsWith("+") && !line.startsWith("+++")
            ? "add"
            : line.startsWith("-") && !line.startsWith("---")
              ? "del"
              : line.startsWith("@@")
                ? "hunk"
                : "ctx";
        return (
          <span key={i} className={`diff-line diff-${kind}`}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}
