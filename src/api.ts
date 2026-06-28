/**
 * BytePlus ModelArk - SeeDance 2.0 Video Generation API client.
 *
 * Implements the ModelArk Video Generation API:
 *   - Create a video generation task: POST   /contents/generations/tasks
 *   - Retrieve a video generation task: GET    /contents/generations/tasks/{id}
 *   - List video generation tasks:      GET    /contents/generations/tasks
 *   - Cancel or delete a task:          DELETE /contents/generations/tasks/{id}
 *
 * Base URL & authentication:
 *   https://ark.byteplus.com/api/v3   with `Authorization: Bearer <API_KEY>`
 */

export const DEFAULT_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";

export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface ContentItem {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    /** Seedance 2.0 reference role: first_frame | last_frame | reference_image */
    role?: string;
  };
}

/**
 * Create-task request. ModelArk expects generation parameters at the TOP LEVEL
 * of the body (not nested under a `parameters` object), alongside `model` and
 * `content`. Known fields: resolution, ratio, duration, frames, seed,
 * camera_fixed, watermark.
 */
export interface CreateTaskRequest {
  model: string;
  content: ContentItem[];
  [key: string]: unknown;
}

export interface TaskUsage {
  completion_tokens?: number;
  prompt_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface TaskError {
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface VideoTask {
  id: string;
  model: string;
  status: TaskStatus;
  created_at?: number;
  updated_at?: number;
  content?: {
    video_url?: string;
    segments?: Array<{ video_url?: string; [k: string]: unknown }>;
    [k: string]: unknown;
  };
  usage?: TaskUsage;
  error?: TaskError;
  [k: string]: unknown;
}

export class ModelArkError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ModelArkError";
    this.status = status;
    this.body = body;
  }
}

export interface ClientConfig {
  apiKey: string;
  baseUrl?: string;
  /** Optional fetch override (useful for tests / proxying). */
  fetchImpl?: typeof fetch;
}

export class ModelArkClient {
  private apiKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(config: ClientConfig) {
    if (!config.apiKey) {
      throw new Error("ModelArk API key is required.");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const errBody = parsed as { error?: TaskError } | undefined;
      const message =
        errBody?.error?.message ||
        (typeof parsed === "string" ? parsed : `HTTP ${res.status}`) ||
        `Request failed with status ${res.status}`;
      throw new ModelArkError(message, res.status, parsed);
    }

    return parsed as T;
  }

  /** POST /contents/generations/tasks — create a video generation task. */
  createVideoTask(req: CreateTaskRequest): Promise<VideoTask> {
    return this.request<VideoTask>(
      "POST",
      "/contents/generations/tasks",
      req as unknown as Record<string, unknown>,
    );
  }

  /** GET /contents/generations/tasks/{id} — retrieve a task's status / result. */
  getVideoTask(taskId: string): Promise<VideoTask> {
    return this.request<VideoTask>(
      "GET",
      `/contents/generations/tasks/${encodeURIComponent(taskId)}`,
    );
  }

  /** GET /contents/generations/tasks — list tasks. */
  listVideoTasks(params?: {
    limit?: number;
    startingAfter?: string;
    type?: string;
  }): Promise<{ data: VideoTask[]; has_more?: boolean }> {
    return this.request<{ data: VideoTask[]; has_more?: boolean }>(
      "GET",
      "/contents/generations/tasks",
      undefined,
      {
        limit: params?.limit,
        starting_after: params?.startingAfter,
        type: params?.type,
      },
    );
  }

  /** DELETE /contents/generations/tasks/{id} — cancel/delete a task. */
  deleteVideoTask(taskId: string): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/contents/generations/tasks/${encodeURIComponent(taskId)}`,
    );
  }

  /**
   * Poll a task until it reaches a terminal state (succeeded/failed/cancelled)
   * or times out. Returns the final task object.
   */
  async pollTask(
    taskId: string,
    opts: {
      intervalMs?: number;
      timeoutMs?: number;
      onUpdate?: (task: VideoTask) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<VideoTask> {
    const interval = opts.intervalMs ?? 3000;
    const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
    const start = Date.now();

    let task: VideoTask;
    do {
      if (opts.signal?.aborted) throw new Error("Polling aborted.");
      if (Date.now() - start > timeout) {
        throw new Error("Timed out waiting for the video to finish.");
      }
      task = await this.getVideoTask(taskId);
      opts.onUpdate?.(task);
      if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled" || task.status === "expired") {
        return task;
      }
      await sleep(interval, opts.signal);
    } while (true);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}

/** Extract the produced video URL from a completed task (handles single + segments). */
export function extractVideoUrl(task: VideoTask): string | undefined {
  const c = task.content;
  if (!c) return undefined;
  if (c.video_url) return c.video_url as string;
  if (Array.isArray(c.segments)) {
    const seg = c.segments.find((s) => s && s.video_url);
    if (seg?.video_url) return seg.video_url as string;
  }
  return undefined;
}
