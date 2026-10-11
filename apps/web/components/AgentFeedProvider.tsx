"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from "react";

export type AgentLifecycle = {
  type: "lifecycle";
  agentId: string;
  role: string;
  status: "initialized" | "running" | "paused" | "halted";
  ts: number;
};

export type AgentIntent = {
  type: "intent";
  agentId: string;
  role: string;
  symbol: string;
  side: "BUY" | "SELL" | "HOLD";
  size: number;
  confidence: number;
  rationale: string;
  ts: number;
};

export type AgentDecision = {
  type: "decision";
  agentId: string;
  role: string;
  symbol: string;
  action: "BUY" | "SELL" | "HOLD";
  size: number;
  price: number;
  rationale: string;
  riskChecked: boolean;
  ts: number;
};

export type AgentMsg = AgentLifecycle | AgentIntent | AgentDecision;

export type AgentInfo = {
  id: string;
  name: string;
  role: string;
  model: string;
  temperature: number;
  autonomy: "SUGGEST" | "APPROVE" | "AUTO";
  state: "initialized" | "running" | "paused" | "halted";
  mandate: string;
  riskLimits: { maxClip: number; maxLeverage: number; dailyLossStop: number };
  tools: string[];
  feeds: string[];
  dailyPnL: number;
};

interface AgentFeedState {
  agents: Map<string, AgentInfo>;
  intents: Map<string, AgentIntent>;
  decisions: Map<string, AgentDecision>;
  connected: boolean;
  connecting: boolean;
  lastError: string | null;
  lastUpdate: number;
}

interface AgentFeedContextType extends AgentFeedState {}

const AgentFeedContext = createContext<AgentFeedContextType | undefined>(
  undefined
);

const STALE_MS = 7000;

export function AgentFeedProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AgentFeedState>({
    agents: new Map(),
    intents: new Map(),
    decisions: new Map(),
    connected: false,
    connecting: false,
    lastError: null,
    lastUpdate: 0,
  });

  const attemptRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const cancelledRef = useRef(false);

  const endpoint = process.env.NEXT_PUBLIC_CORE_WS || "ws://localhost:4000";

  useEffect(() => {
    cancelledRef.current = false;
    attemptRef.current = 0;

    const connect = () => {
      if (cancelledRef.current) return;
      setState((prev) => ({ ...prev, connecting: true, connected: false }));
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${endpoint}/agents`);
      } catch (err) {
        setState((prev) => ({
          ...prev,
          connecting: false,
          connected: false,
          lastError: err instanceof Error ? err.message : String(err),
        }));
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelledRef.current) {
          try {
            ws.close();
          } catch {}
          return;
        }
        setState((prev) => ({
          ...prev,
          connected: true,
          connecting: false,
          lastError: null,
        }));
      };

      ws.onmessage = (ev: MessageEvent) => {
        let msg: AgentMsg;
        try {
          msg = JSON.parse(ev.data) as AgentMsg;
        } catch {
          return;
        }

        setState((prev) => {
          const nextAgents = new Map(prev.agents);
          const nextIntents = new Map(prev.intents);
          const nextDecisions = new Map(prev.decisions);

          if (msg.type === "lifecycle") {
            nextAgents.set(msg.agentId, {
              id: msg.agentId,
              name: msg.agentId,
              role: msg.role,
              model: "anthropic/claude-3-opus", // default; could be enhanced
              temperature: 0.5,
              autonomy: "AUTO",
              state: msg.status,
              mandate: "",
              riskLimits: { maxClip: 10, maxLeverage: 5, dailyLossStop: 1000 },
              tools: ["get_quotes", "get_positions", "read_floor"],
              feeds: ["market_data", "news"],
              dailyPnL: 0,
            });
          } else if (msg.type === "intent") {
            nextIntents.set(`${msg.agentId}-${msg.symbol}`, msg);
          } else if (msg.type === "decision") {
            nextDecisions.set(`${msg.agentId}-${msg.symbol}`, msg);
          }

          return {
            agents: nextAgents,
            intents: nextIntents,
            decisions: nextDecisions,
            connected: true,
            connecting: false,
            lastError: null,
            lastUpdate: Date.now(),
          };
        });
      };

      ws.onclose = () => {
        if (cancelledRef.current) {
          setState((prev) => ({
            ...prev,
            connected: false,
            connecting: false,
          }));
          return;
        }
        setState((prev) => ({ ...prev, connected: false, connecting: false }));
        scheduleReconnect();
      };

      ws.onerror = (ev: Event) => {
        const err =
          (ev as { message?: string })?.message ||
          (ev as { error?: { message?: string } })?.error?.message ||
          "WebSocket error";
        setState((prev) => ({
          ...prev,
          connected: false,
          connecting: false,
          lastError: err,
        }));
        try {
          ws.close();
        } catch {}
      };
    };

    const scheduleReconnect = () => {
      if (cancelledRef.current) return;
      attemptRef.current += 1;
      const delay = Math.min(1500 * attemptRef.current, 30000);
      setTimeout(() => {
        if (cancelledRef.current) return;
        connect();
      }, delay);
    };

    connect();

    return () => {
      cancelledRef.current = true;
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
      }
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  return (
    <AgentFeedContext.Provider
      value={{
        agents: state.agents,
        intents: state.intents,
        decisions: state.decisions,
        connected: state.connected,
        connecting: state.connecting,
        lastError: state.lastError,
        lastUpdate: state.lastUpdate,
      }}
    >
      {children}
    </AgentFeedContext.Provider>
  );
}

export function useAgentFeed(): AgentFeedContextType {
  const ctx = useContext(AgentFeedContext);
  if (!ctx) {
    throw new Error("useAgentFeed must be used within an AgentFeedProvider");
  }
  return ctx;
}
