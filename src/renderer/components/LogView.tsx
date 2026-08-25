interface LogLine {
  level: "info" | "warn" | "error";
  msg: string;
}

export function LogView({ logs }: { logs: LogLine[] }) {
  if (logs.length === 0) return <div className="empty">暂无日志</div>;
  return (
    <div className="log-view">
      {logs.map((l, i) => (
        <div key={i} className={`log-line log-${l.level}`}>
          {l.msg}
        </div>
      ))}
    </div>
  );
}
