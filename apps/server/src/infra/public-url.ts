/**
 * @module server/infra/public-url
 * @description 服务端公开访问根地址动态推导与本机回环边界判定工具。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 显式生产域名优先：若 `PUBLIC_BASE_URL` 已显式配置为非回环公网地址（如 `https://huddle.example.com`），始终以其为唯一权威来源，抵御恶意 `Host` 头投毒。
 * 2. 云端默认零配置自愈：当容器/云主机保留了默认回环 `PUBLIC_BASE_URL`（如 `http://localhost` 或 `http://localhost:3000`），而用户实际通过公网域名、反向代理或云主机 IP 访问时，从经过严格语法白名单校验的 `X-Forwarded-Proto` / `X-Forwarded-Host` / `Host` 自动还原真实可达地址，杜绝向云端 Agent 下发不可达的 `localhost` 安装链接。
 * 3. 零注入面：所有从请求头提取的 `host` 必须通过严格 RFC 主机名/端口正则校验，绝不允许空白符、引号、反引号或路径字符进入生成的 Shell/PowerShell 脚本。
 */

const SAFE_HOST_HEADER_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/;

/**
 * 判定给定 URL 是否指向本机回环接口（`localhost`、`127.0.0.1` 或 `::1`）。
 *
 * @param candidateUrl - 待检测的完整 URL 字符串
 * @returns 若域名属于本机回环地址则返回 `true`
 */
export function isLoopbackUrl(candidateUrl: string): boolean {
  try {
    const parsed = new URL(candidateUrl);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * 提取逗号分隔转发头（如 `X-Forwarded-Host`）中的首个非空值。
 */
function firstHeaderToken(raw: string | null | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const first = raw.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

/**
 * 根据服务端静态配置与当前入站 HTTP 请求头，安全解析外部 Agent 可直接访问的根 URL（无尾斜杠）。
 *
 * @param configuredBaseUrl - `env.PUBLIC_BASE_URL` 配置值
 * @param request - 可选的当前 HTTP `Request`
 * @returns 规范化无尾斜杠的公开根地址
 */
export function resolveEffectivePublicBaseUrl(
  configuredBaseUrl: string,
  request?: Request,
): string {
  const normalizedConfigured = configuredBaseUrl.trim().replace(/\/+$/, "");
  if (!isLoopbackUrl(normalizedConfigured) || request === undefined) {
    return normalizedConfigured;
  }

  const forwardedHost = firstHeaderToken(request.headers.get("x-forwarded-host"));
  const hostHeader = firstHeaderToken(request.headers.get("host"));
  let fallbackUrlHost: string | undefined;
  let fallbackProtocol = "http";
  try {
    const parsedReqUrl = new URL(request.url);
    fallbackUrlHost = parsedReqUrl.host;
    if (parsedReqUrl.protocol === "https:") {
      fallbackProtocol = "https";
    }
  } catch {
    // 忽略相对路径测试构造器异常
  }

  const candidateHost = forwardedHost ?? hostHeader ?? fallbackUrlHost;
  if (candidateHost === undefined || !SAFE_HOST_HEADER_PATTERN.test(candidateHost)) {
    return normalizedConfigured;
  }

  const forwardedProto = firstHeaderToken(request.headers.get("x-forwarded-proto"))?.toLowerCase();
  const effectiveProto =
    forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : fallbackProtocol;
  const derivedOrigin = `${effectiveProto}://${candidateHost}`;

  // 若请求本身也来自本机回环（如本地开发 Vite :5173 转发或 localhost 浏览器直访），保留服务端直连端口配置（如 http://localhost:3000）
  if (isLoopbackUrl(derivedOrigin)) {
    return normalizedConfigured;
  }

  return derivedOrigin;
}
