// app/platform-api.ts
export type PlatformApiResult<T> = { status: number; body: T }

function getEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export async function platformFetch<T>(
  path: string,
  input: {
    actorUserId: string
    method?: string
    body?: any
  },
): Promise<PlatformApiResult<T>> {
  const baseUrl = getEnv('PLATFORM_API_BASE_URL').replace(/\/+$/, '')
  const key = getEnv('PLATFORM_INTERNAL_API_KEY')

  const res = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      'x-gnr8-internal-key': key,
      'x-actor-user-id': input.actorUserId,
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
    // server-to-server fetch, brez credentials
  })

  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }

  return { status: res.status, body: json as T }
}

export async function listPages(orgId: string, actorUserId: string) {
  return platformFetch<{ pages: any[] }>(`/api/builder/orgs/${orgId}/pages`, {
    actorUserId,
  })
}

export async function upsertPage(
  orgId: string,
  actorUserId: string,
  input: { slug: string; title?: string | null; data: any },
) {
  return platformFetch<{ page: any }>(`/api/builder/orgs/${orgId}/pages`, {
    actorUserId,
    method: 'POST',
    body: input,
  })
}