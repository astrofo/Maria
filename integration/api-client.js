/**
 * Browser ES module for the volunteer portal API.
 * Copy into the frontend's src/ directory and import with your bundler.
 * Cookies are managed by the browser. CSRF tokens stay in this module's memory.
 * See docs/FRONTEND.md for session, proxy and deployment details.
 */

export class ApiError extends Error {
  constructor(
    message,
    {
      status = 0,
      code = "NETWORK_ERROR",
      details = [],
      retryAfter = null,
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

function retryAfterSeconds(data, response) {
  const supplied = data?.retry_after;
  if (
    typeof supplied === "number" &&
    Number.isFinite(supplied) &&
    supplied >= 0
  ) {
    return Math.ceil(supplied);
  }
  const header = response.headers.get("Retry-After");
  if (!header) return null;
  if (/^\d+$/.test(header.trim())) return Number(header.trim());
  const timestamp = Date.parse(header);
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
    : null;
}

function downloadFilename(disposition, fallback) {
  let value = "";
  const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i.exec(
    disposition || "",
  );
  if (extended) {
    try {
      value = decodeURIComponent(extended[1].trim());
    } catch {
      /* Use the ordinary name below. */
    }
  }
  if (!value) {
    const ordinary =
      /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]+))/i.exec(
        disposition || "",
      );
    value =
      ordinary?.[1]?.replace(/\\(.)/g, "$1") || ordinary?.[2]?.trim() || "";
  }
  // Treat response names as plain filenames, never paths or control sequences.
  value = value
    .replace(/[\x00-\x1f\x7f/\\]/g, "_")
    .trim()
    .slice(0, 240);
  return value && value !== "." && value !== ".." ? value : fallback;
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl='/api'] '/api' or an explicitly allowed HTTPS API URL.
 * @param {typeof fetch} [options.fetchImpl] Optional fetch adapter; browser fetch by default.
 */
export function createApiClient({
  baseUrl = "/api",
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  if (typeof fetchImpl !== "function")
    throw new TypeError("A fetch implementation is required");
  if (typeof baseUrl !== "string" || !baseUrl.trim())
    throw new TypeError("baseUrl must be a non-empty string");
  const base = baseUrl.trim().replace(/\/+$/, "");
  const parsedBase = new URL(base, "https://frontend.invalid");
  if (
    !["https:", "http:"].includes(parsedBase.protocol) ||
    parsedBase.username ||
    parsedBase.password ||
    parsedBase.search ||
    parsedBase.hash ||
    base.startsWith("//") ||
    base.includes("\\") ||
    (!base.startsWith("/") && !/^https?:\/\//.test(base))
  )
    throw new TypeError(
      "baseUrl must be an HTTP(S) URL or an origin-relative path without credentials/query/hash",
    );

  let csrfToken = null;
  let csrfRequest = null;

  function urlFor(path, query) {
    if (typeof path !== "string" || !/^\/(?!\/)[^?#\\]*$/.test(path)) {
      throw new TypeError(
        "API paths must start with one slash; pass query parameters through query",
      );
    }
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "")
        search.set(key, String(value));
    }
    return `${base}${path}${search.size ? `?${search}` : ""}`;
  }

  async function send(
    path,
    {
      method = "GET",
      query,
      body,
      signal,
      headers,
      responseType = "json",
      fallbackFilename = "download",
    } = {},
  ) {
    const requestHeaders = new Headers(headers);
    requestHeaders.set(
      "Accept",
      responseType === "blob"
        ? "application/octet-stream, text/csv, application/json"
        : "application/json",
    );
    if (body !== undefined)
      requestHeaders.set("Content-Type", "application/json");
    if (!["GET", "HEAD"].includes(method))
      requestHeaders.set("X-CSRF-Token", csrfToken || "");
    // Invalid caller paths are programming errors, not network failures.
    const url = urlFor(path, query);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        credentials: "include",
        cache: "no-store",
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      throw new ApiError(
        "Нет связи с сервером. Проверьте соединение и повторите действие.",
      );
    }

    if (response.status === 401) csrfToken = null;
    let data = null;
    // Even a download returns JSON on errors (including a CSRF rejection).
    if (
      (!response.ok || responseType === "json") &&
      response.status !== 204 &&
      method !== "HEAD"
    ) {
      try {
        data = await response.json();
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        throw new ApiError("Сервер вернул ответ в неожиданном формате.", {
          status: response.status,
          code: "INVALID_RESPONSE",
          retryAfter: retryAfterSeconds(null, response),
        });
      }
    }
    if (!response.ok) {
      throw new ApiError(data?.error || `Ошибка запроса (${response.status})`, {
        status: response.status,
        code: data?.code || `HTTP_${response.status}`,
        details: Array.isArray(data?.details) ? data.details : [],
        retryAfter: retryAfterSeconds(data, response),
      });
    }
    if (responseType === "blob") {
      let blob;
      try {
        blob = await response.blob();
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        throw new ApiError("Не удалось завершить скачивание файла.", {
          status: response.status,
          code: "DOWNLOAD_FAILED",
        });
      }
      return {
        blob,
        filename: downloadFilename(
          response.headers.get("Content-Disposition"),
          fallbackFilename,
        ),
        contentType:
          response.headers.get("Content-Type") ||
          blob.type ||
          "application/octet-stream",
      };
    }
    // Login, successful email verification and password changes rotate the token.
    // Registration only starts email verification (202); retain its anonymous session.
    if (typeof data?.csrfToken === "string" && data.csrfToken)
      csrfToken = data.csrfToken;
    return data;
  }

  async function refreshCsrf() {
    if (!csrfRequest) {
      csrfRequest = (async () => {
        let data;
        try {
          data = await send("/auth/csrf");
        } catch (error) {
          // An invalidated old session is destroyed by the server on its first request.
          // The second read creates an anonymous session for a fresh login.
          if (error.status !== 401) throw error;
          data = await send("/auth/csrf");
        }
        if (typeof data?.csrfToken !== "string" || !data.csrfToken) {
          throw new ApiError("Сервер не выдал токен сессии.", {
            code: "CSRF_MISSING",
          });
        }
        csrfToken = data.csrfToken;
        return csrfToken;
      })().finally(() => {
        csrfRequest = null;
      });
    }
    return csrfRequest;
  }

  async function request(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    if (!["GET", "HEAD", "POST", "PATCH"].includes(method)) {
      throw new TypeError("This API client supports GET, HEAD, POST and PATCH");
    }
    if (["GET", "HEAD"].includes(method) && options.body !== undefined) {
      throw new TypeError("GET/HEAD requests do not accept a JSON body");
    }
    if (
      options.responseType !== undefined &&
      !["json", "blob"].includes(options.responseType)
    ) {
      throw new TypeError("responseType must be json or blob");
    }
    const write = !["GET", "HEAD"].includes(method);
    if (write && !csrfToken) await refreshCsrf();
    const requestOptions = { ...options, method };
    try {
      return await send(path, requestOptions);
    } catch (error) {
      // Retry only an explicit CSRF rejection, before any route handler has run.
      // Network errors and general HTTP errors are never replayed automatically.
      if (!write || error.status !== 403 || error.code !== "CSRF_INVALID")
        throw error;
      await refreshCsrf();
      return send(path, requestOptions);
    }
  }

  const get = (path, query, options = {}) =>
    request(path, { ...options, method: "GET", query });
  const post = (path, body = {}, options = {}) =>
    request(path, { ...options, method: "POST", body });
  const patch = (path, body, options = {}) =>
    request(path, { ...options, method: "PATCH", body });
  const idPath = (id) => {
    const value = String(id);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new TypeError(
        "Record ID must be a positive safe integer or its decimal string",
      );
    }
    return value;
  };

  async function prepareExport(format, currentPassword, options = {}) {
    if (!["backup", "json", "csv"].includes(format))
      throw new TypeError("Export format must be backup, json or csv");
    const result = await post(
      "/admin/exports/prepare",
      {
        format,
        current_password: currentPassword,
      },
      { ...options, responseType: "json" },
    );
    let apiBase, download;
    try {
      apiBase = new URL(
        base,
        globalThis.location?.href || "https://frontend.invalid",
      );
      if (typeof result?.download_url !== "string" || !result.download_url)
        throw new Error();
      download = new URL(result.download_url, apiBase);
      if (
        download.origin !== apiBase.origin ||
        download.username ||
        download.password ||
        download.search ||
        download.hash ||
        !/^\/api\/admin\/exports\/download\/[A-Za-z0-9_-]+$/.test(
          download.pathname,
        )
      )
        throw new Error();
    } catch {
      throw new ApiError("Сервер вернул некорректную ссылку на скачивание.", {
        code: "INVALID_DOWNLOAD_URL",
      });
    }
    // Normalize relative server URLs to the API's origin for separate frontends.
    // A real browser location is required to resolve an origin-relative base URL.
    return {
      ...result,
      download_url:
        apiBase.origin === "https://frontend.invalid"
          ? download.pathname
          : download.href,
    };
  }

  return {
    request,
    get,
    post,
    patch,
    refreshCsrf,
    clearCsrf() {
      csrfToken = null;
    },
    config: () => get("/config"),
    health: () => get("/health"),
    auth: {
      login: (email, password) => post("/auth/login", { email, password }),
      requestLoginCode: (email) => post("/auth/login-code/request", { email }),
      verifyLoginCode: (email, code) =>
        post("/auth/login-code/verify", { email, code }),
      register: (fields) => post("/auth/register", fields),
      // Keep the four-digit code as text, including any leading zeroes.
      verifyEmail: (email, code) => post("/auth/verify-email", { email, code }),
      resendCode: (email) => post("/auth/resend-code", { email }),
      logout: async () => {
        try {
          return await post("/auth/logout");
        } finally {
          csrfToken = null;
        }
      },
      changePassword: (currentPassword, password) =>
        post("/auth/change-password", {
          current_password: currentPassword,
          password,
        }),
    },
    profile: {
      get: () => get("/me"),
      update: (fields) => patch("/me", fields),
    },
    questionnaire: {
      get: () => get("/questionnaire"),
      update: (fields) => patch("/questionnaire", fields),
    },
    questionnaireImport: {
      preview: (csv) => post("/questionnaire-import/preview", { csv }),
      apply: (previewToken) =>
        post("/questionnaire-import/apply", {
          preview_token: previewToken,
          confirm: true,
        }),
    },
    groups: {
      list: (filters) => get("/groups", filters),
      unreadCount: () => get("/groups/unread-count"),
      forEvent: (eventId) => get(`/groups/events/${idPath(eventId)}`),
      messages: (id, cursor) => get(`/groups/${idPath(id)}/messages`, cursor),
      // Reuse clientId when retrying the same message after a network failure.
      send: (id, body, clientId, kind = "message") =>
        post(`/groups/${idPath(id)}/messages`, {
          body,
          client_id: clientId,
          kind,
        }),
      markRead: (id, messageId) =>
        post(`/groups/${idPath(id)}/read`, { message_id: messageId }),
      members: (id, filters) => get(`/groups/${idPath(id)}/members`, filters),
      direct: (id, userId) =>
        post(`/groups/${idPath(id)}/direct`, { user_id: userId }),
    },
    opportunities: {
      list: (filters) => get("/opportunities", filters),
      filterOptions: (filters) =>
        get("/opportunities/options/filters", filters),
      get: (id) => get(`/opportunities/${idPath(id)}`),
      create: (fields) => post("/opportunities", fields),
      update: (id, fields) => patch(`/opportunities/${idPath(id)}`, fields),
      archive: (id) => post(`/opportunities/${idPath(id)}/archive`),
      restore: (id) => post(`/opportunities/${idPath(id)}/restore`),
      participants: (id, filters) =>
        get(`/opportunities/${idPath(id)}/participants`, filters),
      invitations: (id, filters) =>
        get(`/opportunities/${idPath(id)}/invitations`, filters),
      invite: (id, userIds) =>
        post(`/opportunities/${idPath(id)}/invitations`, { user_ids: userIds }),
      revokeInvitation: (id, userId) =>
        patch(`/opportunities/${idPath(id)}/invitations/${idPath(userId)}`, {
          status: "revoked",
        }),
      apply: (id, note = "") =>
        post(`/opportunities/${idPath(id)}/apply`, { note }),
    },
    publicOpportunities: {
      list: (filters) => get("/public/opportunities", filters),
      get: (id) => get(`/public/opportunities/${idPath(id)}`),
      filterOptions: () => get("/public/opportunities/options/filters"),
    },
    applications: {
      list: (filters) => get("/applications", filters),
      updateStatus: (id, status) =>
        patch(`/applications/${idPath(id)}`, { status }),
    },
    participation: {
      list: (filters) => get("/participation", filters),
      create: (fields) => post("/participation", fields),
      update: (id, fields) => patch(`/participation/${idPath(id)}`, fields),
    },
    training: {
      list: (filters) => get("/training", filters),
      get: (id) => get(`/training/${idPath(id)}`),
      create: (fields) => post("/training", fields),
      update: (id, fields) => patch(`/training/${idPath(id)}`, fields),
      complete: (id) => post(`/training/${idPath(id)}/complete`),
    },
    courses: {
      list: (filters) => get("/courses", filters),
      get: (id) => get(`/courses/${idPath(id)}`),
      archive: (id, expectedVersion) =>
        post(`/courses/${idPath(id)}/archive`, {
          expected_version: expectedVersion,
        }),
      restore: (id, expectedVersion) =>
        post(`/courses/${idPath(id)}/restore`, {
          expected_version: expectedVersion,
        }),
    },
    users: {
      list: (filters) => get("/users", filters),
      get: (id, filters) => get(`/users/${idPath(id)}`, filters),
      questionnaire: (id) => get(`/users/${idPath(id)}/questionnaire`),
      achievements: (id) => get(`/users/${idPath(id)}/achievements`),
      updateStatus: (id, status) =>
        patch(`/users/${idPath(id)}/status`, { status }),
      updateRole: (id, role) => patch(`/users/${idPath(id)}/role`, { role }),
      addNote: (id, body) => post(`/users/${idPath(id)}/notes`, { body }),
      thank: (id, message) => post(`/users/${idPath(id)}/thanks`, { message }),
    },
    notifications: {
      list: (filters) => get("/notifications", filters),
      unreadCount: () => get("/notifications/unread-count"),
      markAllRead: () => post("/notifications/read-all", {}),
      markRead: (id) => patch(`/notifications/${idPath(id)}/read`, {}),
    },
    thanks: { list: (filters) => get("/thanks", filters) },
    analytics: { get: (filters) => get("/analytics", filters) },
    staffTasks: {
      list: (filters) => get("/staff-tasks", filters),
      get: (id) => get(`/staff-tasks/${idPath(id)}`),
      create: (fields) => post("/staff-tasks", fields),
      update: (id, fields) => patch(`/staff-tasks/${idPath(id)}`, fields),
    },
    achievements: { get: () => get("/achievements") },
    audit: {
      list: (filters = {}) =>
        get(
          "/audit",
          typeof filters === "number" ? { page: filters } : filters,
        ),
    },
    admin: {
      automation: () => get("/admin/automation"),
      prepareExport,
      // Compatibility name, now returns a download ticket rather than a Blob.
      // Use its URL with a native browser download; never prefetch the one-use URL.
      exportData: prepareExport,
    },
  };
}
