/**
 * BMIR 94.5 live audio for the gateway player.
 * Primary mount is StreamGuys Icecast; iHeart is a seasonal fallback.
 */

const USER_AGENT = "(PhageCampStarlink/1.0; bmir@phagecamp.local)";

export const BMIR_STREAM_PATH = "/bmir/stream";

/** One listen session — client resets to the Listen button; proxy also drops the stream. */
export const BMIR_MAX_LISTEN_MS = 60 * 60 * 1000;

export const BMIR_UPSTREAM_URLS: readonly string[] = [
  "https://bmir-ice.streamguys1.com/live",
  "http://bmir-ice.streamguys.com/live",
  "https://stream.revma.ihrhls.com/zc8378",
];

export const BMIR_DIRECT_STREAM = BMIR_UPSTREAM_URLS[0];

const CONNECT_MS = 8_000;

function isAudioContentType(type: string | null): boolean {
  if (!type) return true;
  return /audio|mpeg|octet-stream|mp3|aac/i.test(type);
}

async function fetchUpstream(url: string, signal: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ctrl.abort(), CONNECT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "audio/mpeg, audio/*;q=0.9, */*;q=0.1",
        "Icy-MetaData": "0",
      },
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    throw err;
  }
}

export async function openBmirLiveStream(signal: AbortSignal): Promise<Response | null> {
  for (const url of BMIR_UPSTREAM_URLS) {
    try {
      const upstream = await fetchUpstream(url, signal);
      if (!upstream.ok || !upstream.body) {
        try {
          await upstream.body?.cancel();
        } catch {
          /* ignore */
        }
        continue;
      }
      if (!isAudioContentType(upstream.headers.get("content-type"))) {
        try {
          await upstream.body.cancel();
        } catch {
          /* ignore */
        }
        continue;
      }
      return upstream;
    } catch {
      if (signal.aborted) return null;
    }
  }
  return null;
}
