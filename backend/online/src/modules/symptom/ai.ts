import {
  clearSymptomThread,
  readSymptomHistory,
  runSymptomChat,
  runSymptomChatStream,
  type AgentMessageInput,
  type ConversationEntry,
  type SymptomStreamEvent,
  type SymptomStreamOptions,
} from '../../ai/agents.js';
import { isModelConfigured, defaultChatModel } from '../../ai/models.js';
import { AppError } from '../../middleware/error.js';

export type SymptomAiStreamEvent = SymptomStreamEvent;
export type SymptomAiStreamOptions = SymptomStreamOptions;

export interface SymptomAiContext {
  accountId: string;
  patientId: string;
  symptomId: string;
  includeRecords: boolean;
  modifyHistory: boolean;
  language?: string | null;
  model: string;
  requestId?: string;
}

export interface SymptomAi {
  isConfigured(): boolean;
  invoke(context: SymptomAiContext, input: AgentMessageInput): Promise<ConversationEntry[]>;
  stream(
    context: SymptomAiContext,
    input: AgentMessageInput,
    options?: SymptomAiStreamOptions,
  ): AsyncIterable<SymptomAiStreamEvent>;
  history(threadId: string): Promise<ConversationEntry[]>;
  clear(threadId: string): Promise<void>;
}

export const defaultSymptomAi: SymptomAi = {
  isConfigured() {
    return isModelConfigured(defaultChatModel());
  },

  async invoke(context, input) {
    if (!isModelConfigured(context.model)) {
      throw new AppError(503, 'AI provider is not configured', 'ai_unavailable');
    }
    return runSymptomChat(context, input);
  },

  stream(context, input, options = {}) {
    if (!isModelConfigured(context.model)) {
      throw new AppError(503, 'AI provider is not configured', 'ai_unavailable');
    }
    return runSymptomChatStream(context, input, options);
  },

  history(threadId) {
    return readSymptomHistory(threadId);
  },

  clear(threadId) {
    return clearSymptomThread(threadId);
  },
};
