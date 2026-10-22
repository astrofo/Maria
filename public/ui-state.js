"use strict";
window.PortalUI = (() => {
  let guard = null,
    previousHash = location.hash,
    checking = false,
    homeCleanup = null,
    shellCleanup = null,
    toggleShell = () => {},
    closeShell = () => {};
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function scrollToElement(element, duration = 180) {
    if (!element) return;
    const header = document.querySelector(".public-header,.topbar");
    const from = window.scrollY,
      to = Math.max(
        0,
        from +
          element.getBoundingClientRect().top -
          (header?.getBoundingClientRect().height || 0) -
          24,
      );
    if (reduced()) {
      window.scrollTo(0, to);
      return;
    }
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      window.scrollTo(0, from + (to - from) * (1 - Math.pow(1 - progress, 3)));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  function confirmDiscard() {
    return new Promise((resolve) => {
      const modal = document.createElement("dialog");
      modal.className = "discard-dialog account-dialog";
      modal.setAttribute("aria-labelledby", "discard-title");
      modal.innerHTML =
        '<h2 id="discard-title">Выйти без сохранения?</h2><p class="muted">Несохранённые изменения будут потеряны. Можно вернуться и сохранить ответы.</p><div class="form-actions"><button class="button" type="button" data-stay>Продолжить редактирование</button><button class="button secondary" type="button" data-leave>Выйти без сохранения</button></div>';
      document.body.append(modal);
      const done = (value) => {
        modal.close();
        modal.remove();
        resolve(value);
      };
      modal.querySelector("[data-stay]").onclick = () => done(false);
      modal.querySelector("[data-leave]").onclick = () => done(true);
      modal.addEventListener("cancel", (e) => {
        e.preventDefault();
        done(false);
      });
      modal.showModal();
    });
  }
  async function allowLeave() {
    if (guard?.() && !(await confirmDiscard())) return false;
    guard = null;
    return true;
  }
  async function beforeRoute() {
    if (checking) return false;
    if (guard?.()) {
      checking = true;
      const allowed = await confirmDiscard();
      checking = false;
      if (!allowed) {
        history.replaceState(null, "", previousHash || "#home");
        return false;
      }
    }
    guard = null;
    previousHash = location.hash;
    homeCleanup?.();
    homeCleanup = null;
    shellCleanup?.();
    shellCleanup = null;
    return true;
  }
  addEventListener("beforeunload", (event) => {
    if (guard?.()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  function bindShell() {
    shellCleanup?.();
    const layout = document.querySelector(".layout"),
      sidebar = layout?.querySelector(".sidebar"),
      main = layout?.querySelector(".main-column"),
      backdrop = layout?.querySelector(".shell-backdrop"),
      trigger = layout?.querySelector(".shell-menu-button");
    if (!layout || !sidebar) return;
    const media = matchMedia("(max-width:1023px)");
    let open = false;
    const update = () => {
      if (!media.matches) open = false;
      layout.classList.toggle("shell-menu-open", open);
      sidebar.inert = media.matches && !open;
      if (main) main.inert = media.matches && open;
      if (backdrop) backdrop.hidden = !open;
      trigger?.setAttribute("aria-expanded", String(open));
      if (open) {
        sidebar.setAttribute("role", "dialog");
        sidebar.setAttribute("aria-modal", "true");
        sidebar.setAttribute("aria-label", "Меню кабинета");
      } else {
        sidebar.removeAttribute("role");
        sidebar.removeAttribute("aria-modal");
      }
    };
    toggleShell = () => {
      open = !open;
      update();
      if (open) sidebar.querySelector("a,button")?.focus();
      else trigger?.focus();
    };
    closeShell = () => {
      if (!open) return;
      open = false;
      update();
      trigger?.focus();
    };
    const closeAfterNavigation = (event) => {
      if (event.target.closest("a[href], [data-action='open-chat']"))
        closeShell();
    };
    const keys = (event) => {
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        toggleShell();
        return;
      }
      if (event.key === "Tab") {
        const nodes = [
          ...sidebar.querySelectorAll('a,button,input,select,[tabindex="0"]'),
        ].filter((el) => !el.disabled && el.getClientRects().length);
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    media.addEventListener("change", update);
    document.addEventListener("keydown", keys);
    sidebar.addEventListener("click", closeAfterNavigation);
    update();
    shellCleanup = () => {
      media.removeEventListener("change", update);
      document.removeEventListener("keydown", keys);
      sidebar.removeEventListener("click", closeAfterNavigation);
      sidebar.inert = false;
      if (main) main.inert = false;
      toggleShell = () => {};
      closeShell = () => {};
    };
  }
  function closePublicMenu(restoreFocus = false) {
    const header = document.querySelector(".public-header.menu-open");
    if (!header) return;
    header.classList.remove("menu-open");
    const button = header.querySelector(".public-menu");
    button?.setAttribute("aria-expanded", "false");
    button?.setAttribute("aria-label", "Открыть меню");
    if (restoreFocus) button?.focus();
  }
  function togglePublicMenu() {
    const header = document.querySelector(".public-header");
    const button = header?.querySelector(".public-menu");
    if (!header || !button) return;
    if (header.classList.contains("menu-open")) return closePublicMenu(true);
    header.classList.add("menu-open");
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-label", "Закрыть меню");
  }
  document.addEventListener("click", (event) => {
    if (event.target.closest('.skip-link[href="#content"]')) {
      // This is a focus target, not a route in the hash-based application.
      const content = document.querySelector("#content");
      if (content) {
        event.preventDefault();
        content.tabIndex = -1;
        content.focus({ preventScroll: true });
        content.scrollIntoView({ block: "start" });
      }
      return;
    }
    const header = document.querySelector(".public-header.menu-open");
    if (!header || event.target.closest(".public-menu")) return;
    if (!header.contains(event.target) || event.target.closest("a,button"))
      closePublicMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePublicMenu(true);
  });
  matchMedia("(min-width:768px)").addEventListener("change", () =>
    closePublicMenu(),
  );
  function bindHero() {
    homeCleanup?.();
    const hero = document.querySelector(".hero-cta"),
      target = document.querySelector(".header-join"),
      header = document.querySelector(".public-header");
    if (!hero || !target || !header) return;
    let active = false,
      frame = null,
      clone = null,
      animation = null;
    function sync() {
      frame = null;
      // The compact phone header keeps its login action; the join CTA stays on the photo.
      if (matchMedia("(max-width:767px)").matches) {
        animation?.cancel();
        clone?.remove();
        clone = null;
        active = false;
        hero.classList.remove("cta-hidden", "cta-arriving");
        hero.removeAttribute("tabindex");
        hero.removeAttribute("aria-hidden");
        target.classList.add("cta-hidden");
        target.tabIndex = -1;
        target.setAttribute("aria-hidden", "true");
        header.classList.remove("has-join");
        return;
      }
      const on =
        hero.getBoundingClientRect().bottom <=
        header.getBoundingClientRect().bottom;
      if (on === active) return;
      const from =
        clone?.getBoundingClientRect() ||
        (active ? target : hero).getBoundingClientRect();
      animation?.cancel();
      clone?.remove();
      active = on;
      const source = on ? hero : target,
        destination = on ? target : hero;
      source.classList.add("cta-hidden");
      source.tabIndex = -1;
      source.setAttribute("aria-hidden", "true");
      destination.classList.remove("cta-hidden");
      destination.removeAttribute("tabindex");
      destination.removeAttribute("aria-hidden");
      header.classList.toggle("has-join", on);
      if (reduced()) return;
      const to = destination.getBoundingClientRect();
      if (!from.width || !to.width) return;
      clone = destination.cloneNode(true);
      clone.removeAttribute("id");
      clone.removeAttribute("href");
      clone.className = "hero-cta cta-flight";
      clone.tabIndex = -1;
      clone.setAttribute("aria-hidden", "true");
      Object.assign(clone.style, {
        position: "fixed",
        left: `${to.left}px`,
        top: `${to.top}px`,
        width: `${to.width}px`,
        height: `${to.height}px`,
        margin: "0",
        zIndex: "70",
        pointerEvents: "none",
        transformOrigin: "top left",
      });
      document.body.append(clone);
      destination.classList.add("cta-arriving");
      animation = clone.animate(
        [
          {
            transform: `translate(${from.left - to.left}px,${from.top - to.top}px) scale(${from.width / to.width},${from.height / to.height})`,
          },
          { transform: "translate(0,0) scale(1)" },
        ],
        { duration: 220, easing: "cubic-bezier(0.4,0,0.2,1)" },
      );
      animation.onfinish = () => {
        clone?.remove();
        clone = null;
        destination.classList.remove("cta-arriving");
      };
      animation.oncancel = () => destination.classList.remove("cta-arriving");
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    sync();
    homeCleanup = () => {
      removeEventListener("scroll", schedule);
      removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      animation?.cancel();
      clone?.remove();
    };
  }
  return {
    bindShell,
    toggleShell: () => toggleShell(),
    closeShell: () => closeShell(),
    togglePublicMenu,
    closePublicMenu,
    scrollToElement,
    confirmDiscard,
    allowLeave,
    beforeRoute,
    bindHero,
    setGuard: (fn) => {
      guard = fn;
    },
    clearGuard: () => {
      guard = null;
    },
    syncHash: () => {
      previousHash = location.hash;
    },
  };
})();
