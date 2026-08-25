import type { BridgeState } from "../types";

const LABEL: Record<BridgeState, string> = {
  connecting: "连接中",
  connected: "已连接",
  disconnected: "已断开",
  error: "异常",
};

export function StatusBar({ state, detail }: { state: BridgeState; detail?: string }) {
  return (
    <div className="statusbar">
      <span className={`dot dot-${state}`} />
      <span className="status-label">{LABEL[state]}</span>
      {detail && <span className="status-detail">{detail}</span>}
    </div>
  );
}
