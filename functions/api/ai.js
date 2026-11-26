const DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const DEFAULT_MODEL = 'agnes-3.0-flash';
const REQUEST_TIMEOUT_MS = 90000;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function buildUpstreamUrl(baseUrl) {
  const normalized = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return normalized.endsWith('/v1')
    ? `${normalized}/chat/completions`
    : `${normalized}/v1/chat/completions`;
}

export async function onRequest(context) {
  const { request, env = {} } = context || {};

  if (!request) {
    return jsonResponse({ error: '无效请求' }, 400);
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: '仅支持 POST 请求' }, 405);
  }

  const apiKey = (env.AGNES_API_KEY || '').trim();
  if (!apiKey) {
    return jsonResponse({ error: 'Cloudflare Pages 环境变量未配置 AGNES_API_KEY' }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: '请求体 JSON 格式错误' }, 400);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return jsonResponse({ error: '缺少有效的 messages 参数' }, 400);
  }

  const upstreamBody = {
    model: (typeof payload.model === 'string' && payload.model.trim()) || env.AGNES_MODEL || DEFAULT_MODEL,
    messages: payload.messages,
  };

  if (payload.response_format && typeof payload.response_format === 'object') {
    upstreamBody.response_format = payload.response_format;
  }
  if (typeof payload.max_tokens === 'number' && Number.isFinite(payload.max_tokens)) {
    upstreamBody.max_tokens = Math.min(Math.max(Math.trunc(payload.max_tokens), 1), 16384);
  }
  if (typeof payload.temperature === 'number' && Number.isFinite(payload.temperature)) {
    upstreamBody.temperature = Math.min(Math.max(payload.temperature, 0), 2);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamRes = await fetch(buildUpstreamUrl(env.AGNES_BASE_URL), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
    });

    const responseText = await upstreamRes.text();

    if (!upstreamRes.ok) {
      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        return jsonResponse({ error: '上游 AI 服务鉴权失败，请检查服务端 AGNES_API_KEY 配置' }, 502);
      }

      let errorMessage = `AI 服务响应异常 (${upstreamRes.status})`;
      try {
        const parsedErr = JSON.parse(responseText);
        const msg = parsedErr?.error?.message || parsedErr?.error || parsedErr?.message;
        if (typeof msg === 'string' && msg.trim()) {
          errorMessage = msg.trim();
        }
      } catch {
        // Ignore non-JSON error body parsing failure
      }
      return jsonResponse({ error: errorMessage }, upstreamRes.status >= 400 ? upstreamRes.status : 502);
    }

    return new Response(responseText, {
      status: upstreamRes.status,
      headers: {
        'Content-Type': upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      return jsonResponse({ error: 'AI 服务响应超时，请稍后重试' }, 504);
    }
    return jsonResponse({ error: '代理请求上游 AI 服务失败，请稍后重试' }, 502);
  } finally {
    clearTimeout(timeoutId);
  }
}
