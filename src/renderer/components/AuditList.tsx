import type { AuditRecord } from "../../shared/protocol";

function fmt(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN");
}

export function AuditList({ items }: { items: AuditRecord[] }) {
  if (items.length === 0) return <div className="empty">暂无执行记录</div>;
  return (
    <div className="audit-list">
      {items.map((r) => (
        <div key={r.id} className={`audit-item ${r.approved ? "audit-allow" : "audit-deny"}`}>
          <div className="audit-head">
            <span className={`tag tag-${r.risk}`}>{r.risk}</span>
            <span className="audit-tool">{r.tool}</span>
            <span className="audit-time">{fmt(r.startedAt)}</span>
            <span className="audit-decision">
              {r.decidedBy === "user"
                ? r.approved
                  ? "用户授权"
                  : "用户拒绝"
                : r.decidedBy === "policy"
                  ? "策略默认拒绝"
                  : "自动"}
            </span>
          </div>
          <div className="audit-summary">{r.summary}</div>
        </div>
      ))}
    </div>
  );
}
