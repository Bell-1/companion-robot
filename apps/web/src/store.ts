import { create } from "zustand";
import type { SessionState } from "@companion/shared";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** 历史消息存本地，刷新后仍能快速回看。 */
const MESSAGES_KEY = "companion.messages";
export const MAX_STORED_MESSAGES = 300;

function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is ChatMessage =>
          !!item &&
          typeof item === "object" &&
          typeof (item as ChatMessage).id === "string" &&
          ((item as ChatMessage).role === "user" || (item as ChatMessage).role === "assistant") &&
          typeof (item as ChatMessage).text === "string",
      )
      .slice(-MAX_STORED_MESSAGES);
  } catch {
    return [];
  }
}

interface CompanionStore {
  connection: "idle" | "connecting" | "open" | "closed";
  sessionState: SessionState;
  micOn: boolean;
  partial: string;
  /** 被服务端忽略的识别结果及原因，短暂提示用户，避免文字凭空消失。 */
  notice: string | null;
  messages: ChatMessage[];
  ttsSampleRate: number;
  error: string | null;

  setConnection: (connection: CompanionStore["connection"]) => void;
  setSessionState: (state: SessionState) => void;
  setMicOn: (on: boolean) => void;
  setPartial: (text: string) => void;
  setNotice: (notice: string | null) => void;
  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, text: string) => void;
  appendAssistant: (turnId: string, delta: string) => void;
  finalizeAssistant: (turnId: string, text: string) => void;
  setTtsSampleRate: (rate: number) => void;
  setError: (message: string | null) => void;
  reset: () => void;
}

export const useCompanionStore = create<CompanionStore>((set) => ({
  connection: "idle",
  sessionState: "idle",
  micOn: false,
  partial: "",
  notice: null,
  messages: loadMessages(),
  ttsSampleRate: 24000,
  error: null,

  setConnection: (connection) => set({ connection }),
  setSessionState: (sessionState) => set({ sessionState }),
  setMicOn: (micOn) => set({ micOn }),
  setPartial: (partial) => set({ partial }),
  setNotice: (notice) => set({ notice }),
  setTtsSampleRate: (ttsSampleRate) => set({ ttsSampleRate }),
  setError: (error) => set({ error }),
  reset: () =>
    set({
      sessionState: "idle",
      micOn: false,
      partial: "",
      notice: null,
      messages: [],
      error: null,
    }),

  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),

  updateMessage: (id, text) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id ? { ...message, text } : message,
      ),
    })),

  appendAssistant: (turnId, delta) =>
    set((state) => {
      const id = `assistant-${turnId}`;
      const index = state.messages.findIndex((message) => message.id === id);
      if (index === -1) {
        return { messages: [...state.messages, { id, role: "assistant" as const, text: delta }] };
      }
      const messages = [...state.messages];
      messages[index] = { ...messages[index]!, text: messages[index]!.text + delta };
      return { messages };
    }),

  finalizeAssistant: (turnId, text) =>
    set((state) => {
      const id = `assistant-${turnId}`;
      const index = state.messages.findIndex((message) => message.id === id);
      if (index === -1) {
        return { messages: [...state.messages, { id, role: "assistant" as const, text }] };
      }
      const messages = [...state.messages];
      messages[index] = { ...messages[index]!, text };
      return { messages };
    }),
}));

/** 消息变化后延迟落盘，避免流式 token 每个都写一次 localStorage。 */
let saveTimer: number | null = null;
useCompanionStore.subscribe((state, previous) => {
  if (state.messages === previous.messages) return;
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    try {
      const recent = useCompanionStore.getState().messages.slice(-MAX_STORED_MESSAGES);
      localStorage.setItem(MESSAGES_KEY, JSON.stringify(recent));
    } catch {
      // 隐私模式或配额不足时降级为仅内存展示。
    }
  }, 300);
});
