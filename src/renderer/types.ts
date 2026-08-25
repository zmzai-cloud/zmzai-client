import type { AuditRecord, RiskLevel, ToolName } from "../shared/protocol";

export type BridgeState = "connecting" | "connected" | "disconnected" | "error";

export interface ApprovalRequest {
  id: string;
  tool: ToolName;
  risk: RiskLevel;
  summary: string;
  paramsSummary: string;
}

export type BridgeEvent =
  | { type: "status"; state: BridgeState; detail?: string }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string }
  | { type: "audit"; record: AuditRecord };

export interface ConfigSnapshot {
  bridgeUrl: string;
  clientId: string;
  approvedRoots: string[];
  shellEnabled: boolean;
}

export interface StateSnapshot {
  status: BridgeState;
  detail?: string;
  config: ConfigSnapshot;
  audit: AuditRecord[];
}

export interface ZmzaiApi {
  getState: () => Promise<StateSnapshot>;
  resolveApproval: (id: string, allowed: boolean) => Promise<boolean>;
  updateConfig: (patch: Record<string, unknown>) => Promise<boolean>;
  onEvent: (cb: (e: BridgeEvent) => void) => void;
  onApproval: (cb: (r: ApprovalRequest) => void) => void;
}

declare global {
  interface Window {
    zmzai: ZmzaiApi;
  }
}

export {};
