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

  bot.command("status", async (ctx) => {
    if (ctx.chat.id !== config.telegram.allowedChatId) {
      return;
    }

    const active = Jobs.listActive(db);

    if (active.length === 0) {
      await ctx.reply("Queue is empty — no pending or running jobs.", {
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }

    const runningCount = active.filter((j) => j.status === "running").length;
    const pendingCount = active.filter((j) => j.status === "pending").length;

    const lines = [
      `${runningCount} running, ${pendingCount} queued:`,
      "",
      ...active.map((job) => {
        const desc =
          job.taskDescription.length > 60
            ? `${job.taskDescription.slice(0, 57)}...`
            : job.taskDescription;
        return `#${job.id} [${job.status}] ${desc}`;
      }),
    ];

    await ctx.reply(lines.join("\n"), {
      reply_parameters: { message_id: ctx.message.message_id },
    });
  });

  bot.command("cancel", async (ctx) => {
    if (ctx.chat.id !== config.telegram.allowedChatId) {
      return;
    }

    const jobId = Number(ctx.payload.trim());
    if (!Number.isInteger(jobId) || jobId <= 0) {
      await ctx.reply("Usage: /cancel <job id> — see /status for ids.", {
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }

    const cancelled = Jobs.cancelPending(db, jobId, "Cancelled by user via /cancel");
    if (cancelled) {
      await ctx.reply(`Job #${jobId} cancelled.`, {
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }

    const job = Jobs.getById(db, jobId);
    if (!job) {
      await ctx.reply(`Job #${jobId} not found.`, {
        reply_parameters: { message_id: ctx.message.message_id },
      });
    } else if (job.status === "running") {
      await ctx.reply(
        `Job #${jobId} is already running and can't be cancelled mid-flight yet — it'll finish (or fail) on its own.`,
        { reply_parameters: { message_id: ctx.message.message_id } }
      );
    } else {
      await ctx.reply(`Job #${jobId} is already ${job.status} — nothing to cancel.`, {
        reply_parameters: { message_id: ctx.message.message_id },
      });
    }
  });

  bot.command("help", async (ctx) => {
    if (ctx.chat.id !== config.telegram.allowedChatId) {
      return;
    }

    const text = [
      "Commands:",
      "/task <description> — queue a new job; the agent will open a draft PR when done.",
      "/status — show pending/running jobs.",
      "/cancel <job id> — cancel a job that hasn't started running yet.",
      "/help — show this message.",
    ].join("\n");

    await ctx.reply(text, { reply_parameters: { message_id: ctx.message.message_id } });
  });

  return bot;
}
