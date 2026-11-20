import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatGroq } from '@langchain/groq';
import { ChatOpenAI } from '@langchain/openai';
import { config } from '../config.js';
import { AppError } from '../middleware/error.js';

export type ModelName =
  | 'openrouter'
  | 'deepSeekChat'
  | 'geminiFlash'
  | 'geminiPro'
  | 'haiku'
  | 'sonnet'
  | 'llamaScout'
  | 'llamaMaverick';

type Provider = 'openrouter' | 'deepseek' | 'google' | 'anthropic' | 'groq';

interface ModelDefinition {
  provider: Provider;
  create: () => BaseChatModel;
}

const definitions: Record<ModelName, ModelDefinition> = {
  openrouter: {
    provider: 'openrouter',
    create: () =>
      new ChatOpenAI({
        apiKey: config.ai.openrouter,
        model: config.ai.openrouterModel,
        temperature: 0.3,
        maxRetries: 7,
        configuration: {
          baseURL: 'https://openrouter.ai/api/v1',
          defaultHeaders: {
            'HTTP-Referer': config.frontendUrl,
            'X-Title': 'HealthAccess',
          },
        },
      }),
  },
  deepSeekChat: {
    provider: 'deepseek',
    create: () =>
      new ChatDeepSeek({
        apiKey: config.ai.deepseek,
        model: 'deepseek-chat',
        temperature: 0.3,
        maxRetries: 7,
      }),
  },
  geminiFlash: {
    provider: 'google',
    create: () =>
      new ChatGoogleGenerativeAI({
        apiKey: config.ai.google,
        model: 'gemini-2.0-flash',
        temperature: 0.3,
        maxRetries: 7,
      }),
  },
  geminiPro: {
    provider: 'google',
    create: () =>
      new ChatGoogleGenerativeAI({
        apiKey: config.ai.google,
        model: 'gemini-1.5-pro',
        temperature: 0.3,
        maxRetries: 7,
      }),
  },
  haiku: {
    provider: 'anthropic',
    create: () =>
      new ChatAnthropic({
        apiKey: config.ai.anthropic,
        model: 'claude-3-5-haiku-latest',
        maxRetries: 7,
      }),
  },
  sonnet: {
    provider: 'anthropic',
    create: () =>
      new ChatAnthropic({
        apiKey: config.ai.anthropic,
        model: 'claude-3-5-sonnet-latest',
        maxRetries: 7,
      }),
  },
  llamaScout: {
    provider: 'groq',
    create: () =>
      new ChatGroq({
        apiKey: config.ai.groq,
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        temperature: 0.3,
        maxRetries: 7,
      }),
  },
  llamaMaverick: {
    provider: 'groq',
    create: () =>
      new ChatGroq({
        apiKey: config.ai.groq,
        model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
        temperature: 0.3,
        maxRetries: 7,
      }),
  },
};

const cache = new Map<ModelName, BaseChatModel>();

function definitionFor(name: string): ModelDefinition {
  const definition = definitions[name as ModelName];
  if (!definition) {
    throw new AppError(400, `Unknown AI model: ${name}`, 'unknown_ai_model');
  }
  return definition;
}

function providerKey(provider: Provider): string | undefined {
  return config.ai[provider];
}

export function isModelConfigured(name: string): boolean {
  const definition = definitions[name as ModelName];
  if (!definition) return false;
  return Boolean(providerKey(definition.provider));
}

export function getModel(name: string): BaseChatModel {
  const definition = definitionFor(name);
  if (!providerKey(definition.provider)) {
    throw new AppError(
      503,
      `AI provider for model "${name}" is not configured`,
      'ai_unavailable',
    );
  }

  const key = name as ModelName;
  const cached = cache.get(key);
  if (cached) return cached;

  const model = definition.create();
  cache.set(key, model);
  return model;
}

export function defaultChatModel(): string {
  if (!process.env.CHAT_MODEL && config.ai.openrouter) return 'openrouter';
  return config.ai.chatModel;
}

export function defaultSchedulerModel(): string {
  if (!process.env.MEDICATION_SCHEDULER_MODEL && config.ai.openrouter) return 'openrouter';
  return config.ai.schedulerModel;
}

export function resetModelCache() {
  cache.clear();
}
