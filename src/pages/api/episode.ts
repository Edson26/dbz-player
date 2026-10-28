import type { APIRoute } from "astro";

import {
  resolveEpisode,
  ResolveError,
} from "../../lib/resolve-episode";

export const prerender = false;

function json(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export const GET: APIRoute = async ({ url }) => {
  const raw = url.searchParams.get("number");

  if (!raw || !/^\d{1,3}$/.test(raw)) {
    return json(
      { error: "Ingresa un número de capítulo válido." },
      400,
    );
  }

  const episode = Number(raw);

  if (episode < 1 || episode > 291) {
    return json(
      { error: "El capítulo debe estar entre 1 y 291." },
      400,
    );
  }

  try {
    const result = await resolveEpisode(episode);

    return json(result);
  } catch (error) {
    if (error instanceof ResolveError) {
      return json(
        { error: error.message },
        error.status,
        error.status === 429
          ? { "Retry-After": "5" }
          : {},
      );
    }

    console.error("[episode resolver]", error);

    return json(
      {
        error:
          "No se pudo inspeccionar el episodio. " +
          "Comprueba tu conexión y que Chromium esté instalado.",
      },
      502,
    );
  }
};