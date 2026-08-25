import { useState } from "react";
import type { ConfigSnapshot } from "../types";

export function SettingsPanel({
  config,
  onSave,
}: {
  config: ConfigSnapshot;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [bridgeUrl, setBridgeUrl] = useState(config.bridgeUrl);
  const [shellEnabled, setShellEnabled] = useState(config.shellEnabled);
  const [roots, setRoots] = useState(config.approvedRoots.join("\n"));

  return (
    <div className="settings">
      <label>
        桥接端点 (wss)
        <input value={bridgeUrl} onChange={(e) => setBridgeUrl(e.target.value)} />
      </label>
      <label>
        Client ID
        <input value={config.clientId} disabled />
      </label>
      <label>
        User ID（归属用户，云端据此路由）
        <input value={config.userId} disabled />
      </label>
      <label>
        已批准目录（每行一个，支持 ~）
        <textarea value={roots} onChange={(e) => setRoots(e.target.value)} rows={4} />
      </label>
      <label className="row">
        <input
          type="checkbox"
          checked={shellEnabled}
          onChange={(e) => setShellEnabled(e.target.checked)}
        />
        允许 shell.exec（每次执行仍会单独弹窗审批）
      </label>
      <button
        className="btn btn-ok"
        onClick={() =>
          onSave({
            bridgeUrl,
            shellEnabled,
            approvedRoots: roots
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
      >
        保存并重连
      </button>
    </div>
  );
}
