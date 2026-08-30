/**
 * Best-effort deep link back to the originating Telegram message. Only
 * resolvable for supergroups/channels (negative chat ids starting with
 * -100) since private chats and basic groups have no stable public URL.
 */
export function buildTelegramMessageLink(chatId: string, messageId: string): string | null {
  const id = Number(chatId);
  if (Number.isNaN(id) || id >= 0) return null;

  const match = String(id).match(/^-100(\d+)$/);
  if (!match) return null;

  return `https://t.me/c/${match[1]}/${messageId}`;
}
