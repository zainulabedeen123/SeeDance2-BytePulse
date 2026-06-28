/**
 * fal.ai integration for ByteDance Seedance 2.0 (full + Mini).
 *
 * Each model exposes three endpoints, chosen from the references:
 *   - text-to-video      (no references)
 *   - image-to-video      (1-2 frame images: first/end)
 *   - reference-to-video  (reference images, up to 9)
 *
 * NOTE: Like the BytePlus path, the fal key is used client-side here. For a
 * real deployment you should proxy through a backend so the key stays secret.
 */
import { fal } from "@fal-ai/client";

export type FalProvider = "byteplus" | "fal";

export interface FalRefImage {
  url: string;
  /** first_frame | last_frame | reference_image */
  role: string;
}

export interface FalModelConfig {
  label: string;
  /** URL prefix for the three endpoints, e.g. "bytedance/seedance-2.0" or "bytedance/seedance-2.0/mini" */
  prefix: string;
  /** Mini only supports 480p/720p and has no bitrate_mode */
  supportsBitrate: boolean;
  resolutions: readonly string[];
}

export interface FalParams {
  resolution: string;
  duration: string;
  aspect_ratio: string;
  generate_audio: boolean;
  bitrate_mode: "standard" | "high";
}

export interface FalPlan {
  endpoint: string;
  input: Record<string, unknown>;
}

/**
 * Available fal.ai Seedance 2.0 models. Add new entries here to extend.
 */
export const FAL_MODELS: Record<string, FalModelConfig> = {
  "seedance-2-0": {
    label: "Seedance 2.0",
    prefix: "bytedance/seedance-2.0",
    supportsBitrate: true,
    resolutions: ["480p", "720p", "1080p", "4k"],
  },
  "seedance-2-0-mini": {
    label: "Seedance 2.0 Mini",
    prefix: "bytedance/seedance-2.0/mini",
    supportsBitrate: false,
    resolutions: ["480p", "720p"],
  },
};

function resolveModel(modelId: string): FalModelConfig {
  return FAL_MODELS[modelId] ?? FAL_MODELS["seedance-2-0"];
}

/** Configure the fal client with an API key (call before any request). */
export function configureFal(credentials: string): void {
  fal.config({ credentials });
}

export type FalEndpoint = "text" | "image" | "reference";

function endpointFor(cfg: FalModelConfig, type: FalEndpoint): string {
  return `${cfg.prefix}/${type === "text" ? "text-to-video" : type === "image" ? "image-to-video" : "reference-to-video"}`;
}

/**
 * Pick the correct Seedance 2.0 / Mini endpoint and assemble its input from
 * the prompt, references and shared parameters. Image roles drive the choice:
 *   - no images                              -> text-to-video
 *   - only first/last frames (<=2)           -> image-to-video (start + optional end frame)
 *   - any reference images, or >2 images     -> reference-to-video
 */
export function planFalRequest(
  prompt: string,
  refs: FalRefImage[],
  p: FalParams,
  modelId: string,
): FalPlan {
  const cfg = resolveModel(modelId);
  const base: Record<string, unknown> = {
    prompt,
    resolution: p.resolution,
    duration: p.duration,
    aspect_ratio: p.aspect_ratio,
    generate_audio: p.generate_audio,
  };
  if (cfg.supportsBitrate) {
    base.bitrate_mode = p.bitrate_mode;
  }

  if (refs.length === 0) {
    return { endpoint: endpointFor(cfg, "text"), input: base };
  }

  const first = refs.find((r) => r.role === "first_frame");
  const last = refs.find((r) => r.role === "last_frame");
  const onlyFrames = refs.every(
    (r) => r.role === "first_frame" || r.role === "last_frame",
  );

  if (onlyFrames && refs.length <= 2) {
    const input: Record<string, unknown> = {
      ...base,
      image_url: (first ?? refs[0]).url,
    };
    if (last) input.end_image_url = last.url;
    return { endpoint: endpointFor(cfg, "image"), input };
  }

  return {
    endpoint: endpointFor(cfg, "reference"),
    input: { ...base, image_urls: refs.map((r) => r.url) },
  };
}

export interface FalResult {
  requestId: string;
  videoUrl: string;
  seed?: number;
}

/**
 * Submit + wait for a fal Seedance 2.0 / Mini request via the queue,
 * surfacing status updates. Returns the video URL and fal request id on
 * completion.
 */
export async function runFal(
  plan: FalPlan,
  opts: {
    onStatus?: (status: string, logs: string[]) => void;
  } = {},
): Promise<FalResult> {
  const result = await fal.subscribe(plan.endpoint, {
    input: plan.input,
    logs: true,
    onQueueUpdate: (update) => {
      const logs =
        "logs" in update && Array.isArray(update.logs)
          ? update.logs.map((l: { message?: string }) => l.message ?? "")
          : [];
      opts.onStatus?.(String(update.status ?? ""), logs);
    },
  });

  const data = result.data as { video?: { url?: string }; seed?: number };
  const videoUrl = data.video?.url;
  if (!videoUrl) {
    throw new Error("fal.ai completed but returned no video URL.");
  }
  return { requestId: result.requestId, videoUrl, seed: data.seed };
}

/** Extract the endpoint suffix for display (e.g. "text-to-video"). */
export function falEndpointLabel(endpoint: string): string {
  const parts = endpoint.split("/");
  return parts[parts.length - 1] ?? endpoint;
}
