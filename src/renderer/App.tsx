import { useEffect, useState } from "react";
import type { AuditRecord } from "../shared/protocol";
import type { ApprovalRequest, BridgeEvent, BridgeState } from "./types";
import { StatusBar } from "./components/StatusBar";
import { ApprovalModal } from "./components/ApprovalModal";
import { AuditList } from "./components/AuditList";
import { LogView } from "./components/LogView";
import { SettingsPanel } from "./components/SettingsPanel";

interface LogLine {
  level: "info" | "warn" | "error";
  msg: string;
}

type Tab = "audit" | "log" | "settings";

export default function App() {
  const [status, setStatus] = useState<BridgeState>("disconnected");
  const [detail, setDetail] = useState<string | undefined>();
  const [config, setConfig] = useState<{
    bridgeUrl: string;
    clientId: string;
    approvedRoots: string[];
    shellEnabled: boolean;
  } | null>(null);
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [tab, setTab] = useState<Tab>("audit");

  useEffect(() => {
    let mounted = true;
    window.zmzai
      .getState()
      .then((s) => {
        if (!mounted) return;
        setStatus(s.status);
        setDetail(s.detail);
        setConfig(s.config);
        setAudit(s.audit);
      })
      .catch(() => {});

    window.zmzai.onEvent((e: BridgeEvent) => {
      if (e.type === "status") {
        setStatus(e.state);
        setDetail(e.detail);
      } else if (e.type === "log") {
        setLogs((p) => [{ level: e.level, msg: e.msg }, ...p].slice(0, 200));
      } else if (e.type === "audit") {
        setAudit((p) => [e.record, ...p].slice(0, 200));
      }
    });

    window.zmzai.onApproval((r: ApprovalRequest) => {
      setApprovals((p) => [...p, r]);
    });

    return () => {
      mounted = false;
    };
  }, []);

  async function resolve(id: string, allowed: boolean) {
    await window.zmzai.resolveApproval(id, allowed);
    setApprovals((p) => p.filter((a) => a.id !== id));
  }

  async function saveConfig(patch: Record<string, unknown>) {
    await window.zmzai.updateConfig(patch);
  }

  if (!config) return <div className="loading">加载中…</div>;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          ⚡ zmzai 客户端<span className="sub">云端 Agent · 本地伴侣 / 桥接器</span>
        </div>
        <StatusBar state={status} detail={detail} />
      </header>

      <nav className="tabs">
        <button className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}>
          执行审计
        </button>
        <button className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>
          运行日志
        </button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
          设置
        </button>
      </nav>

      <main className="content">
        {tab === "audit" && <AuditList items={audit} />}
        {tab === "log" && <LogView logs={logs} />}
        {tab === "settings" && <SettingsPanel config={config} onSave={saveConfig} />}
      </main>

      {approvals.map((a) => (
        <ApprovalModal key={a.id} req={a} onResolve={(allowed) => resolve(a.id, allowed)} />
      ))}
    </div>
  );
}
