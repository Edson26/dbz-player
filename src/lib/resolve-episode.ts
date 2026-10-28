import {
  chromium as playwrightChromium,
  type Frame,
  type Browser,
} from "playwright-core";

import serverlessChromium from "@sparticuz/chromium";

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

// Solo limita las búsquedas dentro de esta instancia del servidor.
// No es un límite global entre todas las funciones de Vercel.
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

async function launchBrowser(): Promise<Browser> {
  const isVercel = process.env.VERCEL === "1";

  if (isVercel) {
    console.info(
      "[episode resolver] Preparando Chromium serverless",
    );

    const executablePath =
      await serverlessChromium.executablePath();

    console.info(
      "[episode resolver] Iniciando Chromium serverless",
    );

    return playwrightChromium.launch({
      args: serverlessChromium.args,
      executablePath,
      headless: true,
      timeout: 30_000,
    });
  }

  console.info(
    "[episode resolver] Iniciando Chromium local",
  );

  return playwrightChromium.launch({
    headless: true,
    timeout: 30_000,
  });
}

export async function resolveEpisode(
  episode: number,
): Promise<EpisodeSource> {
  if (
    !Number.isInteger(episode) ||
    episode < 1 ||
    episode > 291
  ) {
    throw new ResolveError(
      "El capítulo debe ser un número entero entre 1 y 291.",
      400,
    );
  }

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
    browser = await launchBrowser();

    const context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 800,
      },
    });

    const page = await context.newPage();
    const candidates: Candidate[] = [];

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

        const frame = response.request().frame();

        const alreadyRegistered = candidates.some(
          (candidate) =>
            candidate.frame === frame &&
            candidate.url === url,
        );

        if (!alreadyRegistered) {
          candidates.push({
            frame,
            url,
            type,
          });
        }
      } catch {
        // Algunas solicitudes no están asociadas a un frame.
      }
    });

    console.info(
      "[episode resolver] Abriendo episodio",
      { episode },
    );

    const response = await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });

    if (response && response.status() >= 400) {
      throw new ResolveError(
        `La página respondió con HTTP ${response.status()}.`,
      );
    }

    const deadline = Date.now() + 15_000;
    const attemptedFrames = new Set<Frame>();

    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        try {
          const video = frame.locator("video").first();

          if ((await video.count()) === 0) {
            continue;
          }

          const directSource = await video.evaluate(
            (element) => {
              const player = element as HTMLVideoElement;

              return (
                player.currentSrc ||
                player.src ||
                player.querySelector("source")?.src ||
                ""
              );
            },
            undefined,
            {
              timeout: 2_000,
            },
          );

          if (isHttpUrl(directSource)) {
            const type =
              detectType(directSource) ?? "video";

            console.info(
              "[episode resolver] Fuente directa detectada",
              {
                episode,
                type,
              },
            );

            return {
              episode,
              pageUrl,
              sourceUrl: directSource,
              type,
            };
          }

          // Intenta activar la carga una sola vez por frame.
          // No pulsa anuncios, CAPTCHAs ni selectores de servidor.
          if (!attemptedFrames.has(frame)) {
            attemptedFrames.add(frame);

            await video.evaluate(
              (element) => {
                const player = element as HTMLVideoElement;

                player.muted = true;

                void player.play().catch(() => {});
              },
              undefined,
              {
                timeout: 2_000,
              },
            );
          }

          const matching = candidates.filter(
            (candidate) => candidate.frame === frame,
          );

          const candidate =
            matching.find((item) => item.type === "hls") ??
            matching[0];

          if (candidate) {
            console.info(
              "[episode resolver] Fuente de red detectada",
              {
                episode,
                type: candidate.type,
              },
            );

            return {
              episode,
              pageUrl,
              sourceUrl: candidate.url,
              type: candidate.type,
            };
          }
        } catch {
          // El frame puede navegar o desaparecer
          // durante la inspección.
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
      if (browser) {
        await browser.close();
      }
    } catch (error) {
      // Un fallo al cerrar no debe ocultar el resultado
      // o el error original de la inspección.
      console.warn(
        "[episode resolver] No se pudo cerrar Chromium",
        error,
      );
    } finally {
      busy = false;
    }
  }
}