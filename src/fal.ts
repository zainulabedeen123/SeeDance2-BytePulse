/**
 * fal.ai integration for ByteDance Seedance 2.0 / Mini and Alibaba Happy Horse 1.1.
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
  /** URL prefix for the three endpoints, e.g. "bytedance/seedance-2.0" */
  prefix: string;
  resolutions: readonly string[];
  durations: readonly string[];
  aspects: readonly string[];
  supportsBitrate: boolean;
  supportsAudio: boolean;
  supportsSafetyChecker: boolean;
  imageToVideoInferAspect: boolean;
  imageToVideoSupportsEndFrame: boolean;
}

export interface FalParams {
  resolution: string;
  duration: string;
  aspect_ratio: string;
  generate_audio: boolean;
  bitrate_mode: "standard" | "high";
  enable_safety_checker: boolean;
}

export interface FalPlan {
  endpoint: string;
  input: Record<string, unknown>;
}

/**
 * Available fal.ai video models. Add new entries here to extend.
 */
export const FAL_MODELS: Record<string, FalModelConfig> = {
  "seedance-2-0": {
    label: "Seedance 2.0",
    prefix: "bytedance/seedance-2.0",
    resolutions: ["480p", "720p", "1080p", "4k"],
    durations: ["auto", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
    aspects: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    supportsBitrate: true,
    supportsAudio: true,
    supportsSafetyChecker: false,
    imageToVideoInferAspect: false,
    imageToVideoSupportsEndFrame: true,
  },
  "seedance-2-0-mini": {
    label: "Seedance 2.0 Mini",
    prefix: "bytedance/seedance-2.0/mini",
    resolutions: ["480p", "720p"],
    durations: ["auto", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
    aspects: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    supportsBitrate: false,
    supportsAudio: true,
    supportsSafetyChecker: false,
    imageToVideoInferAspect: false,
    imageToVideoSupportsEndFrame: true,
  },
  "happy-horse-v1.1": {
    label: "Alibaba Happy Horse 1.1",
    prefix: "alibaba/happy-horse/v1.1",
    resolutions: ["720p", "1080p"],
    durations: ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21", "5:4", "4:5"],
    supportsBitrate: false,
    supportsAudio: false,
    supportsSafetyChecker: true,
    imageToVideoInferAspect: true,
    imageToVideoSupportsEndFrame: false,
  },
};

export function resolveModel(modelId: string): FalModelConfig {
  return FAL_MODELS[modelId] ?? FAL_MODELS["seedance-2-0"];
}

/** Configure the fal client with an API key (call before any request). */
export function configureFal(credentials: string): void {
  fal.config({ credentials });
}

export type FalEndpoint = "text" | "image" | "reference";

function endpointFor(cfg: FalModelConfig, type: FalEndpoint): string {
  const suffix =
    type === "text"
      ? "text-to-video"
      : type === "image"
        ? "image-to-video"
        : "reference-to-video";
  return `${cfg.prefix}/${suffix}`;
}

/**
 * Pick the correct endpoint and assemble its input from the prompt,
 * references and shared parameters. Image roles drive the endpoint choice:
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
  };

  if (cfg.supportsAudio) base.generate_audio = p.generate_audio;
  if (cfg.supportsBitrate) base.bitrate_mode = p.bitrate_mode;
  if (cfg.supportsSafetyChecker) base.enable_safety_checker = p.enable_safety_checker;

  if (refs.length === 0) {
    base.aspect_ratio = p.aspect_ratio;
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
    if (last && cfg.imageToVideoSupportsEndFrame) input.end_image_url = last.url;
    if (!cfg.imageToVideoInferAspect) input.aspect_ratio = p.aspect_ratio;
    return { endpoint: endpointFor(cfg, "image"), input };
  }

  base.image_urls = refs.map((r) => r.url);
  base.aspect_ratio = p.aspect_ratio;
  return { endpoint: endpointFor(cfg, "reference"), input: base };
}

export interface FalResult {
  requestId: string;
  videoUrl: string;
  seed?: number;
}

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

export function falEndpointLabel(endpoint: string): string {
  const parts = endpoint.split("/");
  return parts[parts.length - 1] ?? endpoint;
}
