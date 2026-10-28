import {
  chromium,
  type Frame,
  type Browser,
} from "playwright";

export interface EpisodeSource {
  episode: number;
  pageUrl: string;
  sourceUrl: string;
  type: "hls" | "video";
}

interface Candidate {
  frame: Frame;
  url: string;
  type: "hls" | "video";
}

export class ResolveError extends Error {
  constructor(
    message: string,
    public status = 422,
  ) {
    super(message);
    this.name = "ResolveError";
  }
}

// Evita ejecutar múltiples navegadores a la vez en esta instancia.
// Esta versión está pensada para uso local.
let busy = false;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" ||
      url.protocol === "http:"
    );
  } catch {
    return false;
  }
}

function detectType(
  url: string,
  contentType = "",
): "hls" | "video" | null {
  const mime = contentType.toLowerCase();

  if (
    /\.m3u8(?:[?#]|$)/i.test(url) ||
    mime.includes("mpegurl")
  ) {
    return "hls";
  }

  if (
    /\.(mp4|webm)(?:[?#]|$)/i.test(url) ||
    mime.includes("video/mp4") ||
    mime.includes("video/webm")
  ) {
    return "video";
  }

  return null;
}

export async function resolveEpisode(
  episode: number,
): Promise<EpisodeSource> {
  if (busy) {
    throw new ResolveError(
      "Ya hay una búsqueda en curso. Espera unos segundos.",
      429,
    );
  }

  busy = true;

  let browser: Browser | undefined;

  const pageUrl =
    `https://animeflv.gr/ver/dragon-ball-z-${episode}`;

  try {
    browser = await chromium.launch({
      headless: true,
    });

    const context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 800,
      },
    });

    const page = await context.newPage();
    const candidates: Candidate[] = [];

    // No necesitamos ventanas emergentes para inspeccionar el video.
    context.on("page", (popup) => {
      if (popup !== page) {
        void popup.close().catch(() => {});
      }
    });

    page.on("response", (response) => {
      try {
        if (
          response.status() < 200 ||
          response.status() >= 400
        ) {
          return;
        }

        const url = response.url();

        if (!isHttpUrl(url)) {
          return;
        }

        const type = detectType(
          url,
          response.headers()["content-type"] ?? "",
        );

        if (!type) {
          return;
        }

        candidates.push({
          frame: response.request().frame(),
          url,
          type,
        });
      } catch {
        // Algunas solicitudes no están asociadas a un frame.
      }
    });

    const response = await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });

    if (response && response.status() >= 400) {
      throw new ResolveError(
        `La página respondió con HTTP ${response.status()}.`,
      );
    }

    // Tiempo adicional para reproductores cargados con JavaScript.
    const deadline = Date.now() + 15_000;
    const attemptedFrames = new Set<Frame>();

    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        try {
          const video = frame.locator("video").first();

          if ((await video.count()) === 0) {
            continue;
          }

          const directSource = await video.evaluate((element) => {
            const player = element as HTMLVideoElement;

            return (
              player.currentSrc ||
              player.src ||
              player.querySelector("source")?.src ||
              ""
            );
          });

          if (isHttpUrl(directSource)) {
            return {
              episode,
              pageUrl,
              sourceUrl: directSource,
              type: detectType(directSource) ?? "video",
            };
          }

          // Intenta activar la carga del video una sola vez por frame.
          // No pulsa anuncios, CAPTCHAs ni selectores de servidor.
          if (!attemptedFrames.has(frame)) {
            attemptedFrames.add(frame);

            await video.evaluate((element) => {
              const player = element as HTMLVideoElement;
              player.muted = true;

              void player.play().catch(() => {});
            });
          }

          // Solo considera solicitudes del frame que contiene el video.
          const matching = candidates.filter(
            (candidate) => candidate.frame === frame,
          );

          // Prioriza HLS frente a MP4 cuando ambos están presentes.
          const candidate =
            matching.find((item) => item.type === "hls") ??
            matching[0];

          if (candidate) {
            return {
              episode,
              pageUrl,
              sourceUrl: candidate.url,
              type: candidate.type,
            };
          }
        } catch {
          // El frame puede navegar o desaparecer durante la inspección.
        }
      }

      await page.waitForTimeout(500);
    }

    throw new ResolveError(
      "No se encontró una fuente HTTP reproducible. " +
      "El sitio puede no tener video disponible, requerir " +
      "seleccionar un servidor o utilizar una carga no compatible.",
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      busy = false;
    }
  }
}