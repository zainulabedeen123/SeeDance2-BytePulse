/**
 * fal.ai integration for ByteDance Seedance 2.0.
 *
 * Seedance 2.0 is exposed as three fal endpoints, chosen from the references:
 *   - bytedance/seedance-2.0/text-to-video      (no references)
 *   - bytedance/seedance-2.0/image-to-video      (1-2 frame images: first/end)
 *   - bytedance/seedance-2.0/reference-to-video  (reference images, up to 9)
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

const ENDPOINTS = {
  text: "bytedance/seedance-2.0/text-to-video",
  image: "bytedance/seedance-2.0/image-to-video",
  reference: "bytedance/seedance-2.0/reference-to-video",
} as const;

/** Configure the fal client with an API key (call before any request). */
export function configureFal(credentials: string): void {
  fal.config({ credentials });
}

/**
 * Pick the Seedance 2.0 endpoint and assemble its input from the prompt,
 * references and shared parameters. Image roles drive the choice:
 *   - only first/last frames (<=2) -> image-to-video (start + optional end frame)
 *   - otherwise (any reference, or >2 images) -> reference-to-video
 *   - no images -> text-to-video
 */
export function planFalRequest(
  prompt: string,
  refs: FalRefImage[],
  p: FalParams,
): FalPlan {
  const base: Record<string, unknown> = {
    prompt,
    resolution: p.resolution,
    duration: p.duration,
    aspect_ratio: p.aspect_ratio,
    generate_audio: p.generate_audio,
    bitrate_mode: p.bitrate_mode,
  };

  if (refs.length === 0) {
    return { endpoint: ENDPOINTS.text, input: base };
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
    return { endpoint: ENDPOINTS.image, input };
  }

  return {
    endpoint: ENDPOINTS.reference,
    input: { ...base, image_urls: refs.map((r) => r.url) },
  };
}

export interface FalResult {
  requestId: string;
  videoUrl: string;
  seed?: number;
}

/**
 * Submit + wait for a fal Seedance 2.0 request via the queue, surfacing status
 * updates. Returns the video URL and fal request id on completion.
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

/** Human-friendly endpoint label for display. */
export function falEndpointLabel(endpoint: string): string {
  if (endpoint === ENDPOINTS.text) return "text-to-video";
  if (endpoint === ENDPOINTS.image) return "image-to-video";
  if (endpoint === ENDPOINTS.reference) return "reference-to-video";
  return endpoint;
}
