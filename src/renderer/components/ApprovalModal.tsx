import type { ApprovalRequest } from "../types";

export function ApprovalModal({
  req,
  onResolve,
}: {
  req: ApprovalRequest;
  onResolve: (allowed: boolean) => void;
}) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title">云端 Agent 请求在本地执行</div>
        <div className="modal-meta">
          <span className={`tag tag-${req.risk}`}>风险：{req.risk}</span>
          <span className="modal-tool">工具：{req.tool}</span>
        </div>
        <div className="modal-summary">{req.summary}</div>
        <div className="modal-actions">
          <button className="btn btn-danger" onClick={() => onResolve(false)}>
            拒绝
          </button>
          <button className="btn btn-ok" onClick={() => onResolve(true)}>
            允许
          </button>
        </div>
      </div>
    </div>
  );
}
