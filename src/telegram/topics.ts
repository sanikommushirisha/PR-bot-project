import type { Telegram } from "telegraf";

/**
 * Creates a dedicated forum topic for a new job. Returns null (rather than
 * throwing) if the chat isn't a forum-enabled supergroup or the bot lacks
 * the "Manage Topics" permission there — callers should fall back to
 * replying in the main chat instead of failing the whole job.
 */
export async function createJobTopic(
  telegram: Telegram,
  chatId: string,
  name: string
): Promise<number | null> {
  try {
    const topic = await telegram.createForumTopic(chatId, name);
    return topic.message_thread_id;
  } catch (err) {
    console.warn(
      `Could not create a Telegram forum topic (is "Topics" enabled for this group, and is the bot an admin with "Manage Topics"?): ${
        err instanceof Error ? err.message : err
      }`
    );
    return null;
  }
}

const TOPIC_NAME_MAX_LENGTH = 100;

export function buildTopicName(taskDescription: string): string {
  return taskDescription.length > TOPIC_NAME_MAX_LENGTH
    ? `${taskDescription.slice(0, TOPIC_NAME_MAX_LENGTH - 3)}...`
    : taskDescription;
}
