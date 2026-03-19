import type { AiSettings } from "@shared/types";

export interface AiBrief {
  summary: string;
  keyPoints: string[];
  oneLineTakeaway: string;
  confidence: "high" | "medium" | "low";
}

export async function createAiBrief(
  settings: AiSettings,
  input: {
    channelName: string;
    title: string;
    description: string;
    chapters: string[];
    transcript: string;
  }
): Promise<AiBrief> {
  const fallback = fallbackBrief(input);

  if (!settings.apiKey || !settings.baseUrl || !settings.model) {
    return fallback;
  }

  try {
    const content = await requestAiCompletion(settings, {
      temperature: 0.2,
      responseFormat: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Return strict JSON with summary, keyPoints, oneLineTakeaway, confidence. Write concise Chinese suitable for Telegram."
        },
        {
          role: "user",
          content: [
            `频道：${input.channelName}`,
            `标题：${input.title}`,
            `描述：${input.description}`,
            `章节：${input.chapters.join(" | ")}`,
            `文本：${input.transcript.slice(0, 12000)}`
          ].join("\n")
        }
      ]
    });

    if (!content) {
      return fallback;
    }

    return normalizeAiBrief(content, fallback);
  } catch {
    return fallback;
  }
}

export async function testAiConnection(settings: AiSettings): Promise<string> {
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    throw new Error("请先填写 AI Base URL、API Key 和模型名称");
  }

  const content = await requestAiCompletion(settings, {
    temperature: 0,
    messages: [
      {
        role: "system",
        content: "Reply with only OK"
      },
      {
        role: "user",
        content: "Connection test"
      }
    ]
  });

  if (!content) {
    throw new Error("AI 接口已连接，但没有返回内容");
  }

  return `AI 接口可用，模型 ${settings.model} 已成功响应。`;
}

async function requestAiCompletion(
  settings: AiSettings,
  input: {
    temperature: number;
    messages: Array<{ role: string; content: string }>;
    responseFormat?: { type: "json_object" };
  }
): Promise<string> {
  const response = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: input.temperature,
      ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
      messages: input.messages
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`AI 请求失败：HTTP ${response.status}${detail ? `，${detail.slice(0, 120)}` : ""}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

function normalizeAiBrief(content: string, fallback: AiBrief): AiBrief {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const summary = typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : fallback.summary;
    const oneLineTakeaway = typeof parsed.oneLineTakeaway === "string" && parsed.oneLineTakeaway.trim()
      ? parsed.oneLineTakeaway.trim()
      : fallback.oneLineTakeaway;
    const keyPoints = normalizeKeyPoints(parsed.keyPoints, fallback.keyPoints);
    const confidence = normalizeConfidence(parsed.confidence, fallback.confidence);

    return {
      summary,
      keyPoints,
      oneLineTakeaway,
      confidence
    };
  } catch {
    return fallback;
  }
}

function normalizeKeyPoints(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const points = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
    return points.length > 0 ? points.slice(0, 5) : fallback;
  }

  if (typeof value === "string" && value.trim()) {
    const points = value
      .split(/\r?\n|[;；]/)
      .map((item) => item.replace(/^[-*\d.\s]+/, "").trim())
      .filter(Boolean);
    return points.length > 0 ? points.slice(0, 5) : fallback;
  }

  return fallback;
}

function normalizeConfidence(value: unknown, fallback: AiBrief["confidence"]): AiBrief["confidence"] {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["high", "medium", "low"].includes(normalized)) {
      return normalized as AiBrief["confidence"];
    }
    if (["high confidence", "strong", "very high"].includes(normalized)) {
      return "high";
    }
    if (["mid", "moderate"].includes(normalized)) {
      return "medium";
    }
    if (["weak", "very low"].includes(normalized)) {
      return "low";
    }
  }

  if (typeof value === "number") {
    if (value >= 0.75) {
      return "high";
    }
    if (value >= 0.4) {
      return "medium";
    }
    return "low";
  }

  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    return normalizeConfidence(candidate.level ?? candidate.value ?? candidate.label, fallback);
  }

  return fallback;
}

function fallbackBrief(input: {
  title: string;
  description: string;
  chapters: string[];
  transcript: string;
}): AiBrief {
  const raw = [input.transcript, input.description, input.chapters.join(" ")].join(" ").trim();
  return {
    summary: (raw || input.title).slice(0, 160),
    keyPoints: [
      input.title,
      input.description.slice(0, 80) || "描述较少，建议打开原视频查看。",
      input.chapters[0] || "未抓到字幕，仅基于标题和描述生成。"
    ]
      .filter(Boolean)
      .slice(0, 3),
    oneLineTakeaway: input.transcript ? "文本较完整，可优先阅读摘要。" : "可用文本较少，建议结合原视频查看。",
    confidence: input.transcript ? "medium" : "low"
  };
}
