import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError } from '../middleware/error.js';
import {
  buildPatientSnapshot,
  emergencyNumberFor,
  languageName,
  renderSnapshot,
} from './context.js';
import { defaultSchedulerModel, getModel } from './models.js';
import {
  medicationAdderPrompt,
  medicationSchedulePrompt,
  symptomChatPrompt,
} from './prompts.js';
import {
  buildMedicationAdderTools,
  buildMedicationTools,
  buildSymptomTools,
  type AgentToolContext,
} from './tools.js';

export interface AgentImage {
  mimeType: string;
  base64: string;
}

export interface AgentMessageInput {
  text: string;
  images?: AgentImage[];
}

export interface ConversationEntry {
  type: 'AI' | 'Human';
  content: string;
}

export type SymptomStreamStepStatus = 'started' | 'completed' | 'failed';

export interface SymptomStreamStep {
  type: 'step';
  id: string;
  name: string;
  status: SymptomStreamStepStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export type SymptomStreamEvent =
  | { type: 'token'; content: string }
  | SymptomStreamStep
  | { type: 'done'; messages: ConversationEntry[] };

export interface SymptomStreamOptions {
  signal?: AbortSignal;
}

const MAX_STREAM_PAYLOAD = 2000;

function boundedPayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return value.length > MAX_STREAM_PAYLOAD
      ? `${value.slice(0, MAX_STREAM_PAYLOAD)}…[truncated]`
      : value;
  }
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return undefined;
    return json.length > MAX_STREAM_PAYLOAD
      ? `${json.slice(0, MAX_STREAM_PAYLOAD)}…[truncated]`
      : value;
  } catch {
    return '[unserializable]';
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'Tool failed');
  return message.length > MAX_STREAM_PAYLOAD
    ? `${message.slice(0, MAX_STREAM_PAYLOAD)}…[truncated]`
    : message;
}

export interface SymptomAgentContext extends AgentToolContext {
  symptomId: string;
  includeRecords: boolean;
  modifyHistory: boolean;
  hasImages?: boolean;
  patientContext?: string | null;
  language?: string | null;
  emergencyNumber?: string | null;
}

export interface MedicationAgentContext {
  patientId: string;
  accountId?: string | null;
  requestId?: string;
  model?: string;
  extraPrompt?: string;
}

let checkpointer: PostgresSaver | null = null;
let setupPromise: Promise<void> | null = null;

export function threadIdFor(symptomId: string): string {
  return `symptom_${symptomId}`;
}

export function getCheckpointer(): PostgresSaver {
  if (!checkpointer) {
    checkpointer = PostgresSaver.fromConnString(config.databaseUrl, {
      schema: 'ai_agent_state',
    });
  }
  return checkpointer;
}

export async function ensureCheckpointerReady(): Promise<void> {
  if (!setupPromise) {
    setupPromise = (async () => {
      const existing = await prisma.$queryRaw<Array<{ present: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'ai_agent_state' AND table_name = 'checkpoint_migrations'
        ) AS present
      `;
      if (existing[0]?.present) return;
      await getCheckpointer().setup();
    })().catch((error: unknown) => {
      setupPromise = null;
      throw error;
    });
  }
  await setupPromise;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') return text;
      }
      return '';
    })
    .join('\n')
    .trim();
}

function toConversation(messages: BaseMessage[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (const message of messages) {
    const type = message._getType();
    if (type !== 'ai' && type !== 'human') continue;
    const content = messageText(message.content);
    if (!content) continue;
    entries.push({ type: type === 'ai' ? 'AI' : 'Human', content });
  }
  return entries;
}

function buildHumanMessage(input: AgentMessageInput): HumanMessage {
  if (!input.images?.length) {
    return new HumanMessage({ content: [{ type: 'text', text: input.text }] });
  }
  return new HumanMessage({
    content: [
      { type: 'text', text: input.text },
      ...input.images.map((image) => ({
        type: 'image_url' as const,
        image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
      })),
    ],
  });
}

export function getSymptomAgent(context: SymptomAgentContext) {
  const model = getModel(context.model);
  const tools = buildSymptomTools(context, { includeRecords: context.includeRecords });
  return createReactAgent({
    name: 'HealthAccess Symptom Assistant',
    prompt: symptomChatPrompt({
      patientId: context.patientId,
      symptomId: context.symptomId,
      includeRecords: context.includeRecords,
      modifyHistory: context.modifyHistory,
      hasImages: Boolean(context.hasImages),
      patientContext: context.patientContext,
      language: context.language,
      emergencyNumber: context.emergencyNumber,
      today: new Date().toISOString().slice(0, 10),
    }),
    llm: model,
    tools,
    checkpointer: getCheckpointer(),
  });
}

/**
 * Load the de-identified patient snapshot for the prompt. Location and language
 * are part of the record, so they are only used when the patient allowed it.
 */
export async function withPatientContext(
  context: SymptomAgentContext,
): Promise<SymptomAgentContext> {
  const chosen = context.language ? languageName(context.language) : null;
  if (!context.includeRecords) {
    return { ...context, patientContext: null, language: chosen, emergencyNumber: null };
  }
  try {
    const snapshot = await buildPatientSnapshot(context.patientId);
    if (!snapshot) return { ...context, language: chosen };
    return {
      ...context,
      patientContext: renderSnapshot(snapshot),
      language: chosen ?? languageName(snapshot.preferredLanguage),
      emergencyNumber: snapshot.emergencyNumber ?? emergencyNumberFor(snapshot.location.country),
    };
  } catch {
    // The assistant still works without personal context; the tool can retry the lookup.
    return { ...context, language: chosen };
  }
}

export async function runSymptomChat(
  context: SymptomAgentContext,
  input: AgentMessageInput,
): Promise<ConversationEntry[]> {
  await ensureCheckpointerReady();
  const agent = getSymptomAgent({
    ...(await withPatientContext(context)),
    hasImages: Boolean(input.images?.length),
  });
  const result = await agent.invoke(
    { messages: [buildHumanMessage(input)] },
    { configurable: { thread_id: threadIdFor(context.symptomId) } },
  );
  const messages = Array.isArray(result.messages) ? (result.messages as BaseMessage[]) : [];
  return toConversation(messages);
}

function streamChunkText(chunk: unknown): string {
  if (!chunk) return '';
  if (typeof chunk === 'string') return chunk;
  if (typeof chunk === 'object' && 'content' in chunk) {
    return messageText((chunk as { content?: unknown }).content);
  }
  return '';
}

export async function* runSymptomChatStream(
  context: SymptomAgentContext,
  input: AgentMessageInput,
  options: SymptomStreamOptions = {},
): AsyncGenerator<SymptomStreamEvent> {
  await ensureCheckpointerReady();
  const threadId = threadIdFor(context.symptomId);
  const agent = getSymptomAgent({
    ...(await withPatientContext(context)),
    hasImages: Boolean(input.images?.length),
  });

  const events = agent.streamEvents(
    { messages: [buildHumanMessage(input)] },
    {
      version: 'v2',
      configurable: { thread_id: threadId },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  for await (const event of events) {
    if (event.event === 'on_chat_model_stream') {
      const content = streamChunkText(event.data?.chunk);
      if (content) {
        yield { type: 'token', content };
      }
      continue;
    }

    if (event.event === 'on_tool_start') {
      yield {
        type: 'step',
        id: event.run_id,
        name: event.name,
        status: 'started',
        input: boundedPayload(event.data?.input),
      };
      continue;
    }

    if (event.event === 'on_tool_end') {
      yield {
        type: 'step',
        id: event.run_id,
        name: event.name,
        status: 'completed',
        output: boundedPayload(streamChunkText(event.data?.output) || event.data?.output),
      };
      continue;
    }

    if (event.event === 'on_tool_error') {
      const toolError = (event.data as Record<string, unknown> | undefined)?.error;
      yield {
        type: 'step',
        id: event.run_id,
        name: event.name,
        status: 'failed',
        error: boundedError(toolError),
      };
    }
  }

  yield { type: 'done', messages: await readSymptomHistory(threadId) };
}

export async function readSymptomHistory(threadId: string): Promise<ConversationEntry[]> {
  await ensureCheckpointerReady();
  const tuple = await getCheckpointer().getTuple({
    configurable: { thread_id: threadId },
  });
  const values = tuple?.checkpoint.channel_values as Record<string, unknown> | undefined;
  const messages = Array.isArray(values?.messages) ? (values.messages as BaseMessage[]) : [];
  return toConversation(messages);
}

export async function clearSymptomThread(threadId: string): Promise<void> {
  await ensureCheckpointerReady();
  await prisma.$transaction([
    prisma.$executeRaw`delete from ai_agent_state.checkpoint_writes where thread_id = ${threadId}`,
    prisma.$executeRaw`delete from ai_agent_state.checkpoint_blobs where thread_id = ${threadId}`,
    prisma.$executeRaw`delete from ai_agent_state.checkpoints where thread_id = ${threadId}`,
  ]);
}

const scheduleJsonShape =
  '{"title":string?,"description":string?,"summary":string,"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","medications":[{"drug":string,"dose":string,"frequency":string,"times":[{"hour":number,"minute":number}]}],"err":string?}';

const additionJsonShape =
  '{"summary":string?,"startDate":"YYYY-MM-DD"?,"endDate":"YYYY-MM-DD"?,"medications":[{"drug":string,"dose":string,"frequency":string,"times":[{"hour":number,"minute":number}]}],"err":string?}';

function medicationContext(context: MedicationAgentContext, model: string): AgentToolContext {
  return {
    model,
    accountId: context.accountId ?? null,
    patientId: context.patientId,
    requestId: context.requestId,
  };
}

function lastAiText(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message._getType() === 'ai') {
      const text = messageText(message.content);
      if (text) return text;
    }
  }
  throw new AppError(502, 'AI returned an empty response', 'ai_invalid_response');
}

export function getMedicationSchedulerAgent(context: MedicationAgentContext) {
  const modelName = context.model ?? defaultSchedulerModel();
  const model = getModel(modelName);
  const tools = buildMedicationTools(medicationContext(context, modelName));
  return createReactAgent({
    name: 'HealthAccess Medication Scheduler',
    prompt: `${medicationSchedulePrompt}\n${context.extraPrompt ?? ''}\nYour output must be a single minified JSON object with this shape: ${scheduleJsonShape}.`,
    llm: model,
    tools,
  });
}

export function getMedicationScheduleAdderAgent(context: MedicationAgentContext) {
  const modelName = context.model ?? defaultSchedulerModel();
  const model = getModel(modelName);
  const tools = buildMedicationAdderTools(medicationContext(context, modelName));
  return createReactAgent({
    name: 'HealthAccess Medication Adder',
    prompt: `${medicationAdderPrompt}\n${context.extraPrompt ?? ''}\nYour output must be a single minified JSON object with this shape: ${additionJsonShape}.`,
    llm: model,
    tools,
  });
}

export async function runMedicationScheduler(
  context: MedicationAgentContext,
  input: AgentMessageInput,
): Promise<string> {
  const agent = getMedicationSchedulerAgent(context);
  const result = await agent.invoke({ messages: [buildHumanMessage(input)] });
  const messages = Array.isArray(result.messages) ? (result.messages as BaseMessage[]) : [];
  return lastAiText(messages);
}

export async function runMedicationAdder(
  context: MedicationAgentContext,
  input: AgentMessageInput,
): Promise<string> {
  const agent = getMedicationScheduleAdderAgent(context);
  const result = await agent.invoke({ messages: [buildHumanMessage(input)] });
  const messages = Array.isArray(result.messages) ? (result.messages as BaseMessage[]) : [];
  return lastAiText(messages);
}
