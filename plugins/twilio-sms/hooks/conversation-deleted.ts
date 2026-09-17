import { purge } from "../src/runtime.ts";
export default function deleted(context: { conversationId: string }): void {
  purge(context.conversationId);
}
