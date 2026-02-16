import { Session } from "@openomni/session";
import { Message } from "@openomni/protocol";
import { TaskManager, Task, TaskStorage } from "../../task";

export interface SummaryTemplate {
  format: "markdown" | "json" | "text";
  fields: string[];
}

export interface SummaryData {
  runId: string;
  taskId: string;
  result: string;
  duration: number;
  timestamp: number;
}

export namespace SummaryDelivery {
  export function extract(
    sessionId: string,
    _template: SummaryTemplate,
  ): SummaryData {
    const messages = Session.getMessages(sessionId);

    let result = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        const parts = Session.getParts(msg.id);
        const textParts = parts.filter((p) => p.type === "text");
        if (textParts.length > 0) {
          result = textParts
            .map((p) => (p as Message.TextPart).text)
            .join("\n");
        }
        break;
      }
    }

    let duration = 0;
    if (messages.length > 0) {
      const firstMsg = messages[0];
      const lastMsg = messages[messages.length - 1];

      const startTime =
        firstMsg.role === "user"
          ? firstMsg.time.created
          : (firstMsg as Message.AssistantMessage).time.created;

      const endTime =
        lastMsg.role === "user"
          ? lastMsg.time.created
          : ((lastMsg as Message.AssistantMessage).time.completed ??
            (lastMsg as Message.AssistantMessage).time.created);

      duration = endTime - startTime;
    }

    const timestamp = Date.now();
    const runId = sessionId.split(":")[3] || sessionId;
    const taskId = sessionId.split(":")[1] || "";

    return {
      runId,
      taskId,
      result,
      duration,
      timestamp,
    };
  }

  export function format(data: SummaryData, template: SummaryTemplate): string {
    const selectedFields = template.fields;

    switch (template.format.toLowerCase()) {
      case "json":
        return formatAsJson(data, selectedFields);
      case "markdown":
        return formatAsMarkdown(data, selectedFields);
      case "text":
      default:
        return formatAsText(data, selectedFields);
    }
  }

  export function persist(runId: string, summary: string): void {
    const run = TaskManager.getRun(runId);
    if (!run) {
      return;
    }

    const updatedRun: Task.Run = {
      ...run,
      summary,
    };

    const store = TaskStorage.getAdapter();
    store.run.set(run.taskId, updatedRun);
  }

  function formatAsJson(data: SummaryData, fields: string[]): string {
    const filtered: Record<string, unknown> = {};

    for (const field of fields) {
      if (field in data) {
        filtered[field] = data[field as keyof SummaryData];
      }
    }

    return JSON.stringify(filtered, null, 2);
  }

  function formatAsMarkdown(data: SummaryData, fields: string[]): string {
    const lines: string[] = ["# Summary"];

    for (const field of fields) {
      if (field in data) {
        const value = data[field as keyof SummaryData];
        const displayName = field.charAt(0).toUpperCase() + field.slice(1);

        if (field === "result") {
          lines.push(`\n## ${displayName}\n`);
          lines.push(String(value));
        } else if (field === "duration") {
          lines.push(`\n**${displayName}:** ${value}ms`);
        } else if (field === "timestamp") {
          const date = new Date(value as number).toISOString();
          lines.push(`\n**${displayName}:** ${date}`);
        } else {
          lines.push(`\n**${displayName}:** ${value}`);
        }
      }
    }

    return lines.join("\n");
  }

  function formatAsText(data: SummaryData, fields: string[]): string {
    const lines: string[] = [];

    for (const field of fields) {
      if (field in data) {
        const value = data[field as keyof SummaryData];
        const displayName = field.charAt(0).toUpperCase() + field.slice(1);

        if (field === "duration") {
          lines.push(`${displayName}: ${value}ms`);
        } else if (field === "timestamp") {
          const date = new Date(value as number).toISOString();
          lines.push(`${displayName}: ${date}`);
        } else {
          lines.push(`${displayName}: ${value}`);
        }
      }
    }

    return lines.join("\n");
  }
}
