/** Trabajo de la cola ai-reply: solo ids (el texto queda en messages). */
export interface AiReplyJob {
  tenantId: string;
  conversationId: string;
  /** Entrante que encoló el trabajo. */
  messageId: string;
}
