const { JSDOM, CookieJar, VirtualConsole, ResourceLoader } = require("jsdom");
const { randomUUID } = require("node:crypto");

async function openUI(
  base,
  { route = "", fetchAdapter, viewportWidth = 1440 } = {},
) {
  const origin = new URL(base);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
    throw new Error("DOM tests must use a local application server");
  const jar = new CookieJar();
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  class LocalResources extends ResourceLoader {
    fetch(url, options) {
      if (new URL(url).origin !== origin.origin)
        throw new Error("External resources are forbidden in DOM tests");
      return super.fetch(url, options);
    }
  }
  const html = await (await fetch(base)).text();
  const dom = new JSDOM(html, {
    url: new URL(route, base).href,
    resources: new LocalResources(),
    runScripts: "dangerously",
    pretendToBeVisual: true,
    cookieJar: jar,
    virtualConsole,
    beforeParse(window) {
      window.fetch = async (url, options = {}) => {
        const target = new URL(url, base).href;
        if (new URL(target).origin !== origin.origin)
          throw new Error("External requests are forbidden in DOM tests");
        const headers = new Headers(options.headers);
        const cookie = jar.getCookieStringSync(target);
        if (cookie) headers.set("cookie", cookie);
        const send = () => fetch(target, { ...options, headers });
        const response = fetchAdapter
          ? await fetchAdapter(target, options, send)
          : await send();
        for (const cookie of response.headers.getSetCookie())
          jar.setCookieSync(cookie, target);
        return response;
      };
      window.scrollTo = () => {};
      window.Element.prototype.scrollIntoView = () => {};
      window.Element.prototype.scrollTo = () => {};
      window.innerWidth = viewportWidth;
      window.matchMedia = (query) => {
        const min = /min-width:\s*(\d+)px/.exec(query);
        const max = /max-width:\s*(\d+)px/.exec(query);
        return {
          matches:
            Boolean(min || max) &&
            (!min || viewportWidth >= Number(min[1])) &&
            (!max || viewportWidth <= Number(max[1])),
          addEventListener() {},
          removeEventListener() {},
        };
      };
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      window.crypto.randomUUID = randomUUID;
      window.HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "");
      };
      window.HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open");
        this.dispatchEvent(new window.Event("close"));
      };
    },
  });
  const waitFor = async (predicate, message = "DOM condition timed out") => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const found =
        typeof predicate === "string"
          ? dom.window.document.querySelector(predicate)
          : predicate(dom.window.document);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      message +
        "\n" +
        dom.window.document.body.textContent.slice(-2000) +
        "\n" +
        errors.map((e) => e.message).join("\n"),
    );
  };
  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    waitFor,
    errors,
    async api(route) {
      const response = await dom.window.fetch("/api" + route);
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    },
    close: () => dom.window.close(),
  };
}
function fill(ui, name, value) {
  const input = ui.document.querySelector(
    `input[name="${name}"],textarea[name="${name}"],select[name="${name}"],[data-pc-path="${name}"]`,
  );
  if (!input) throw new Error("Missing input: " + name);
  if (input.type === "checkbox") input.checked = Boolean(value);
  else input.value = String(value);
  input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
  input.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
}
function submit(ui, selector, submitterSelector) {
  const form = ui.document.querySelector(selector);
  if (!form) throw new Error("Missing form: " + selector);
  const submitter = submitterSelector
    ? form.querySelector(submitterSelector)
    : form.querySelector('[type="submit"]');
  form.dispatchEvent(
    new ui.window.SubmitEvent("submit", {
      bubbles: true,
      cancelable: true,
      submitter,
    }),
  );
}
function clickText(ui, text) {
  const element = [...ui.document.querySelectorAll("button,a")].find(
    (el) => el.textContent.trim() === text,
  );
  if (!element) throw new Error("Missing button: " + text);
  element.click();
}
module.exports = { openUI, fill, submit, clickText };
