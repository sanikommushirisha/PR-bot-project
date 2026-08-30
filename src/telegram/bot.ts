import { Telegraf } from "telegraf";
import type Database from "better-sqlite3";
import { config } from "../config/index.js";
import { Jobs } from "../db/index.js";
import { createJobTopic, buildTopicName } from "./topics.js";

export function createBot(db: Database.Database): Telegraf {
  const bot = new Telegraf(config.telegram.botToken);

  bot.command("task", async (ctx) => {
    if (ctx.chat.id !== config.telegram.allowedChatId) {
      console.warn(
        `Ignored /task from chat ${ctx.chat.id} (configured TELEGRAM_ALLOWED_CHAT_ID is ${config.telegram.allowedChatId}).`
      );
      return; // require the explicit command in the configured chat only
    }

    const taskDescription = ctx.payload.trim();
    if (!taskDescription) {
      await ctx.reply("Usage: /task <description of what you want done>", {
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }

    const replyTo = ctx.message.reply_to_message;
    const contextNote = replyTo && "text" in replyTo ? replyTo.text : null;

    const messageThreadId = await createJobTopic(
      ctx.telegram,
      String(ctx.chat.id),
      buildTopicName(taskDescription)
    );

    const job = Jobs.create(db, {
      taskDescription,
      contextNote,
      requestingUserId: String(ctx.from.id),
      requestingUsername: ctx.from.username ?? ctx.from.first_name ?? null,
      chatId: String(ctx.chat.id),
      messageId: String(ctx.message.message_id),
      messageThreadId: messageThreadId !== null ? String(messageThreadId) : null,
      targetRepo: config.github.slug,
      targetBaseBranch: config.github.baseBranch,
    });

    const ackText = `Got it — job #${job.id} queued. I'll open a draft PR and post updates ${
      messageThreadId !== null ? "in this topic" : "here"
    } when it's ready.`;

    if (messageThreadId !== null) {
      await ctx.telegram.sendMessage(ctx.chat.id, ackText, { message_thread_id: messageThreadId });
    } else {
      await ctx.reply(ackText, { reply_parameters: { message_id: ctx.message.message_id } });
    }
  });

  return bot;
}
