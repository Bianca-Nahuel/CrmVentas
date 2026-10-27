// Prompt v3 (tarea 010, conversación más natural) en dos capas (fija + empresa) y la conversación en su
// sección delimitada.
import type { MessageType, TenantConfig } from '@ventas/shared';
import { AI_HISTORY_MESSAGES, AI_MESSAGE_MAX_CHARS } from '../../ai.constants.js';
import { jsonForPrompt } from '../../llm/json-for-prompt.js';
import type { LlmMessage } from '../../llm/llm-client.js';
import type { LocalTime } from '../../reply/business-hours.js';
import { FIXED_LAYER } from './fixed-layer.js';
import { buildClientData, buildTenantLayer, type TenantLayerState } from './tenant-layer.js';

export const PROMPT_VERSION = 'v3';

export type HistoryAuthor = 'cliente' | 'asistente' | 'vendedor' | 'sistema';

export interface HistoryMessage {
  author: HistoryAuthor;
  type: MessageType;
  /** HH:MM local o fecha y hora; solo para que el modelo vea el orden y las pausas. */
  at: string;
  text: string | null;
}

export interface PromptInput {
  config: TenantConfig;
  local: LocalTime;
  isOpen: boolean;
  state: TenantLayerState;
  history: HistoryMessage[];
}

function truncate(text: string): string {
  const chars = [...text];
  return chars.length <= AI_MESSAGE_MAX_CHARS ? text : `${chars.slice(0, AI_MESSAGE_MAX_CHARS).join('')}…`;
}

export function buildPrompt(input: PromptInput): { system: string; messages: LlmMessage[] } {
  const history = input.history.slice(-AI_HISTORY_MESSAGES).map((message) => ({
    autor: message.author,
    tipo: message.type,
    hora: message.at,
    texto: message.text === null ? null : truncate(message.text),
  }));
  return {
    system: `${FIXED_LAYER}\n\n${buildTenantLayer(input)}`,
    messages: [
      {
        role: 'user',
        content: `${buildClientData(input.config, input.state)}
<conversacion>${jsonForPrompt(history)}</conversacion>`,
      },
    ],
  };
}
