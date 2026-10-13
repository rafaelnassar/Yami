/**
 * Parse Gelbooru-style API Access Credentials pasted from the account page:
 * `&api_key=...&user_id=...` (leading `?` / `&` optional).
 */
export interface ApiKeyUserIdCredentials {
  readonly apiKey: string;
  readonly userId: string;
}

export function parseApiKeyUserIdPaste(raw: string): ApiKeyUserIdCredentials | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let query = trimmed;
  if (query.startsWith('http://') || query.startsWith('https://')) {
    try {
      query = new URL(query).search.replace(/^\?/, '');
    } catch {
      return null;
    }
  } else {
    query = query.replace(/^[?&]+/, '');
  }

  const params = new URLSearchParams(query);
  const apiKey = (params.get('api_key') ?? params.get('api-key') ?? '').trim();
  const userId = (params.get('user_id') ?? params.get('user-id') ?? '').trim();
  if (!apiKey || !userId) return null;
  if (/\s/.test(apiKey) || /\s/.test(userId)) return null;
  if (apiKey.length < 10 || apiKey.length > 4_096) return null;
  if (userId.length > 64) return null;
  return { apiKey, userId };
}
