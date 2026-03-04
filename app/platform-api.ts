export async function platformFetch(
  path: string,
  options: RequestInit = {}
) {
  const base = process.env.NEXT_PUBLIC_PLATFORM_API_URL;

  if (!base) {
    throw new Error("NEXT_PUBLIC_PLATFORM_API_URL is not set");
  }

  const res = await fetch(`${base}${path}`, {
    ...options,
    credentials: "include", // ključ za auth cookie
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }

  if (!res.ok) {
    throw new Error(
      `Platform API error ${res.status}: ${JSON.stringify(json)}`
    );
  }

  return json;
}