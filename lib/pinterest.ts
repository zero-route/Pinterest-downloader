import { proxyPath } from "@/lib/sign";

const DEFAULT_DOWNLOAD_HOST = "instagram-tiktok-youtube-downloader.p.rapidapi.com";
const DEFAULT_DETAIL_HOST = "pinterest-global-scraper-api.p.rapidapi.com";

type Json = Record<string, unknown>;

export type Target = { id: string | null; url: string };

export type Quality = {
  label: string;
  height: number;
  src: string;
  download: string;
};

export type Item = {
  type: "video" | "photo";
  src: string;
  download: string;
  direct: string | null;
  thumb: string | null;
  thumbDirect: string | null;
  qualities: Quality[];
  width: number | null;
  height: number | null;
};

export type PinData = {
  id: string;
  url: string;
  profileUrl: string | null;
  mediaType: "video" | "photo";
  title: string | null;
  text: string | null;
  timestamp: number | null;
  author: {
    username: string | null;
    name: string | null;
    verified: boolean;
    followers: number | null;
    avatar: string | null;
    avatarDirect: string | null;
  };
  stats: {
    reactions: number | null;
    saves: number | null;
    repins: number | null;
    shares: number | null;
    comments: number | null;
  };
  items: Item[];
  meta: { details: "ok" | "failed" };
};

export class ProviderError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

type CallResult = { json: Json | null; status: number | null };

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function obj(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (
    typeof value === "string" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }

  return null;
}

function httpUrl(value: unknown): string | null {
  const text = str(value);

  return text && /^https?:\/\//i.test(text) ? text : null;
}

function pinId(text: string): string | null {
  const match = text.match(/\/pin\/(?:[^/?#]*--)?(\d{6,25})/);

  return match ? match[1] : null;
}

export function parseTarget(raw: string): Target | null {
  const value = raw.trim();

  if (!value) return null;

  let parsed: URL;

  try {
    parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();

  if (host === "pin.it" || host === "www.pin.it") {
    const code = parsed.pathname.split("/").filter(Boolean)[0] ?? "";

    return /^[\w-]{4,40}$/.test(code)
      ? { id: null, url: `https://pin.it/${code}` }
      : null;
  }

  if (!/(^|\.)pinterest\.[a-z.]{2,}$/.test(host)) return null;

  const id = pinId(parsed.pathname);

  return id ? { id, url: `https://id.pinterest.com/pin/${id}/` } : null;
}

async function resolveShort(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(8000),
    });

    const fromUrl = pinId(decodeURIComponent(response.url));

    if (fromUrl) {
      await response.body?.cancel().catch(() => undefined);

      return fromUrl;
    }

    const html = (await response.text()).slice(0, 400_000);

    return pinId(html);
  } catch {
    return null;
  }
}

function getKey() {
  const key = process.env.RAPIDAPI_KEY;

  if (!key) {
    throw new ProviderError(
      "RAPIDAPI_KEY belum dikonfigurasi di environment Vercel.",
      500
    );
  }

  return key;
}

async function callEndpoint(
  tag: string,
  host: string,
  path: string,
  validate: (body: Json) => boolean,
  deadlineMs: number
): Promise<CallResult> {
  const key = getKey();
  const endpoint = `https://${host}${path}`;
  const startedAt = Date.now();
  let status: number | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const remaining = deadlineMs - (Date.now() - startedAt);

    if (remaining < 4000) break;

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        cache: "no-store",
        headers: {
          "X-Rapidapi-Key": key,
          "X-Rapidapi-Host": host,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(Math.min(22_000, remaining)),
      });

      status = response.status;

      const text = await response.text();

      let body: Json | null = null;

      try {
        body = obj(JSON.parse(text));
      } catch {
        body = null;
      }

      const valid = response.ok && body !== null && validate(body);

      console.log(
        `[pinterest] ${tag} attempt=${attempt} http=${response.status} valid=${valid}${
          valid ? "" : ` body=${text.slice(0, 200).replace(/\s+/g, " ")}`
        }`
      );

      if (valid) return { json: body, status };

      if ([400, 401, 403, 404, 422].includes(response.status)) break;
    } catch (error) {
      status = null;

      console.log(
        `[pinterest] ${tag} attempt=${attempt} error=${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    }

    if (attempt < 3) await sleep(1000 * attempt);
  }

  return { json: null, status };
}

function validMedia(body: Json) {
  return body.ok !== false && httpUrl(body.download_url) !== null;
}

function validDetail(body: Json) {
  const data = obj(body.data);

  return data !== null && (str(data.entityId) !== null || str(data.id) !== null);
}

async function callDownloader(urls: string[], deadlineMs: number) {
  const host = process.env.RAPIDAPI_DOWNLOAD_HOST?.trim() || DEFAULT_DOWNLOAD_HOST;
  const startedAt = Date.now();
  let last: CallResult = { json: null, status: null };

  for (const url of urls) {
    const remaining = deadlineMs - (Date.now() - startedAt);

    if (remaining < 4000) break;

    last = await callEndpoint(
      "fetch",
      host,
      `/fetch?url=${encodeURIComponent(url)}`,
      validMedia,
      remaining
    );

    if (last.json) return last;

    if (last.status === 401 || last.status === 403 || last.status === 429) break;
  }

  return last;
}

function callDetail(id: string, deadlineMs: number) {
  const host = process.env.RAPIDAPI_HOST?.trim() || DEFAULT_DETAIL_HOST;

  return callEndpoint(
    "detail",
    host,
    `/v3/pins/${encodeURIComponent(id)}/`,
    validDetail,
    deadlineMs
  );
}

function displayImage(url: string): string {
  return url.replace(/(\/\/i\.pinimg\.com)\/originals\//, "$1/736x/");
}

function videoVariants(videos: Json | null, baseName: string): Quality[] {
  const found = new Map<string, Quality>();

  function visit(value: unknown, depth: number) {
    if (depth > 3) return;

    const node = obj(value);

    if (!node) return;

    const link = httpUrl(node.url);

    if (link && /\.mp4(\?|$)/i.test(link)) {
      const height = num(node.height) ?? 0;
      const width = num(node.width) ?? 0;
      const size = height && width ? Math.min(height, width) : height;
      const label = size > 0 ? `${size}p` : "Asli";

      if (!found.has(label)) {
        found.set(label, {
          label,
          height: size,
          src: proxyPath(link),
          download: proxyPath(link, {
            name: `${baseName}_${label}`,
            download: true,
          }),
        });
      }

      return;
    }

    for (const child of Object.values(node)) visit(child, depth + 1);
  }

  visit(videos, 0);

  return [...found.values()].sort((a, b) => b.height - a.height);
}

function failFrom(status: number | null): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError(
      "Akses ke penyedia API ditolak. Periksa RAPIDAPI_KEY dan langganan ke API downloader.",
      502
    );
  }

  if (status === 429) {
    return new ProviderError(
      "Kuota API sedang habis atau terlalu banyak permintaan. Coba lagi beberapa saat.",
      429
    );
  }

  if (status === 404 || status === 422 || status === 400) {
    return new ProviderError(
      "Pin tidak ditemukan. Pastikan tautan benar dan pin tidak privat.",
      404
    );
  }

  return new ProviderError(
    "Gagal mengambil data pin. Coba lagi beberapa saat.",
    502
  );
}

function count(value: unknown) {
  const parsed = num(value);

  return parsed !== null && parsed >= 0 ? parsed : null;
}

export async function fetchPin(input: Target): Promise<PinData> {
  let id = input.id;

  if (!id) id = await resolveShort(input.url);

  const urls = id
    ? [
        `https://id.pinterest.com/pin/${id}/`,
        `https://www.pinterest.com/pin/${id}/`,
      ]
    : [input.url];

  const mediaPromise = callDownloader(urls, 50_000);

  let detailPromise: Promise<CallResult> | null = id
    ? callDetail(id, 50_000)
    : null;

  const media = await mediaPromise;

  if (!media.json) {
    if (detailPromise) await detailPromise;

    throw failFrom(media.status);
  }

  const mediaBody = media.json;

  if (!id) {
    id = str(mediaBody.id);

    if (id) detailPromise = callDetail(id, 30_000);
  }

  const details = detailPromise ? await detailPromise : { json: null, status: null };
  const data = obj(details.json?.data);
  const downloadUrl = httpUrl(mediaBody.download_url) as string;
  const finalId = id ?? str(data?.entityId) ?? "pin";

  const pinner = obj(data?.pinner) ?? obj(data?.nativeCreator);
  const creator = obj(data?.nativeCreator);
  const username = str(pinner?.username) ?? str(creator?.username);
  const baseName = `${username ?? "pinterest"}_${finalId}`;

  const isVideo =
    (str(mediaBody.type) ?? "").toLowerCase() === "video" ||
    /\.(mp4|m3u8|mov)(\?|$)/i.test(downloadUrl);

  const width = num(mediaBody.width);
  const height = num(mediaBody.height);
  const thumbnail = httpUrl(mediaBody.thumbnail_url);

  let item: Item;

  if (isVideo) {
    let qualities = videoVariants(obj(data?.videos), baseName);

    if (qualities.length === 0 || !/\.m3u8(\?|$)/i.test(downloadUrl)) {
      const direct: Quality = {
        label: "Asli",
        height: 0,
        src: proxyPath(downloadUrl),
        download: proxyPath(downloadUrl, { name: baseName, download: true }),
      };

      if (!/\.m3u8(\?|$)/i.test(downloadUrl)) {
        qualities = [direct, ...qualities.filter((entry) => entry.height > 0)];
      } else if (qualities.length === 0) {
        qualities = [direct];
      }
    }

    const poster =
      thumbnail && !/\.(mp4|m3u8)(\?|$)/i.test(thumbnail)
        ? displayImage(thumbnail)
        : httpUrl(obj(data?.image736x)?.url);

    const preview =
      qualities.find((entry) => entry.height > 0 && entry.height <= 720) ??
      qualities[0];

    item = {
      type: "video",
      src: preview.src,
      download: qualities[0].download,
      direct: null,
      thumb: poster ? proxyPath(poster) : null,
      thumbDirect: poster,
      qualities,
      width,
      height,
    };
  } else {
    const display =
      httpUrl(obj(data?.image736x)?.url) ??
      httpUrl(obj(data?.imageSpec736x)?.url) ??
      displayImage(downloadUrl);

    item = {
      type: "photo",
      src: proxyPath(display),
      download: proxyPath(downloadUrl, { name: baseName, download: true }),
      direct: display,
      thumb: null,
      thumbDirect: null,
      qualities: [],
      width,
      height,
    };
  }

  const avatar =
    httpUrl(pinner?.imageLargeUrl) ?? httpUrl(pinner?.imageMediumUrl);

  const aggregated = obj(obj(data?.aggregatedPinData)?.aggregatedStats);
  const createdText = str(data?.createdAt);
  const created = createdText ? Date.parse(createdText) : NaN;

  const text =
    str(data?.closeupUnifiedDescription) ??
    str(data?.description) ??
    str(mediaBody.caption);

  const profileUrl =
    httpUrl(creator?.profileUrl) ??
    (username ? `https://www.pinterest.com/${username}/` : null);

  return {
    id: finalId,
    url: `https://www.pinterest.com/pin/${finalId}/`,
    profileUrl,
    mediaType: item.type,
    title: str(data?.title) ?? str(data?.gridTitle),
    text,
    timestamp: Number.isFinite(created) ? Math.floor(created / 1000) : null,
    author: {
      username,
      name: str(pinner?.fullName) ?? str(creator?.fullName),
      verified:
        pinner?.isVerifiedMerchant === true ||
        obj(pinner?.verifiedIdentity)?.verified === true,
      followers: count(pinner?.followerCount),
      avatar: avatar ? proxyPath(avatar) : null,
      avatarDirect: avatar,
    },
    stats: {
      reactions: count(data?.totalReactionCount),
      saves: count(aggregated?.saves),
      repins: count(data?.repinCount),
      shares: count(data?.shareCount),
      comments: count(obj(data?.aggregatedPinData)?.commentCount),
    },
    items: [item],
    meta: { details: data ? "ok" : "failed" },
  };
}
