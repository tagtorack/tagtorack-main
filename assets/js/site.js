/* =========================================================================
   TAG TO RACK — shared interactions
   ========================================================================= */
(function () {
  "use strict";

  /* ---------- Header scroll state ---------- */
  const header = document.querySelector(".site-header");
  if (header) {
    const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---------- Mobile nav ---------- */
  const toggle = document.querySelector(".nav-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      document.body.classList.toggle("nav-open");
      const open = document.body.classList.contains("nav-open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    document.querySelectorAll(".nav-links a").forEach((a) =>
      a.addEventListener("click", () => document.body.classList.remove("nav-open"))
    );
  }

  /* ---------- In-view helper (robust across environments) ---------- */
  const inView = (el, margin) => {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const m = margin == null ? 0.12 : margin;
    return r.top < vh * (1 - m) && r.bottom > 0;
  };

  /* ---------- Scroll reveals ---------- */
  const reveals = [...document.querySelectorAll(".reveal")];
  const checkReveals = () => {
    for (let i = reveals.length - 1; i >= 0; i--) {
      const el = reveals[i];
      if (inView(el)) {
        el.classList.add("in");
        reveals.splice(i, 1);
      }
    }
  };
  checkReveals();
  window.addEventListener("scroll", checkReveals, { passive: true });
  window.addEventListener("resize", checkReveals);
  // also nudge shortly after load in case layout shifts (fonts, etc.)
  setTimeout(checkReveals, 300);
  setTimeout(checkReveals, 1200);

  /* ---------- Animated intake demo ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  class IntakeDemo {
    constructor(root) {
      this.root = root;
      this.photos = [...root.querySelectorAll(".demo-photo")];
      this.fields = [...root.querySelectorAll(".demo-field")];
      this.statusEl = root.querySelector("[data-demo-status]");
      this.scan = root.querySelector(".demo-scan");
      this.suggestion = root.querySelector(".demo-suggestion");
      this.posBlock = root.querySelector(".demo-pos");
      this.approval = root.querySelector(".demo-approval");
      this.confBar = root.querySelector(".demo-conf-fill");
      this.replayBtn = root.querySelector("[data-demo-replay]");
      this.running = false;
      this.done = false;

      if (this.replayBtn) {
        this.replayBtn.addEventListener("click", () => this.run(true));
      }
      // approval interactivity
      const approveBtn = root.querySelector("[data-demo-approve]");
      if (approveBtn) {
        approveBtn.addEventListener("click", () => {
          this.approval && this.approval.classList.add("approved");
          this.setStatus("Approved by manager · queued for export", "ok");
        });
      }
    }

    setStatus(text, kind) {
      if (!this.statusEl) return;
      this.statusEl.textContent = text;
      this.statusEl.className = "demo-status " + (kind || "");
    }

    reset() {
      this.photos.forEach((p) => p.classList.remove("captured"));
      this.fields.forEach((f) => f.classList.remove("revealed"));
      this.scan && this.scan.classList.remove("on");
      this.suggestion && this.suggestion.classList.remove("revealed");
      this.posBlock && this.posBlock.classList.remove("revealed");
      this.approval && this.approval.classList.remove("revealed", "approved", "pulse");
      if (this.confBar) this.confBar.style.width = "0%";
      this.root.classList.remove("analyzing", "complete");
    }

    async run(force) {
      if (this.running) return;
      if (this.done && !force) return;
      this.running = true;
      this.done = false;
      this.reset();

      if (reduce) {
        // Skip animation, show final state
        this.photos.forEach((p) => p.classList.add("captured"));
        this.fields.forEach((f) => f.classList.add("revealed"));
        this.suggestion && this.suggestion.classList.add("revealed");
        this.posBlock && this.posBlock.classList.add("revealed");
        this.approval && this.approval.classList.add("revealed");
        if (this.confBar) this.confBar.style.width = "94%";
        this.setStatus("Draft ready · awaiting manager approval", "warn");
        this.root.classList.add("complete");
        this.running = false;
        this.done = true;
        return;
      }

      // 1 — capture photos
      this.setStatus("Capturing photos…", "");
      await sleep(350);
      for (const p of this.photos) {
        p.classList.add("captured");
        await sleep(420);
      }
      await sleep(250);

      // 2 — analyze
      this.root.classList.add("analyzing");
      this.scan && this.scan.classList.add("on");
      this.setStatus("Analyzing item…", "scanning");
      await sleep(1100);

      // 3 — fill fields with confidence ramp
      let i = 0;
      for (const f of this.fields) {
        f.classList.add("revealed");
        i++;
        if (this.confBar) this.confBar.style.width = Math.min(94, 30 + i * 9) + "%";
        await sleep(reduce ? 0 : 360);
      }
      this.scan && this.scan.classList.remove("on");
      this.root.classList.remove("analyzing");

      // 4 — suggestion + POS text
      await sleep(200);
      this.suggestion && this.suggestion.classList.add("revealed");
      await sleep(450);
      this.posBlock && this.posBlock.classList.add("revealed");
      await sleep(450);

      // 5 — manager approval
      this.approval && this.approval.classList.add("revealed", "pulse");
      this.setStatus("Draft ready · awaiting manager approval", "warn");
      this.root.classList.add("complete");

      this.running = false;
      this.done = true;
    }
  }

  const demos = [...document.querySelectorAll("[data-intake-demo]")];
  if (demos.length) {
    const instances = demos.map((root) => ({ root, demo: new IntakeDemo(root), started: false }));
    const checkDemos = () => {
      instances.forEach((it) => {
        if (!it.started && inView(it.root, 0.25)) {
          it.started = true;
          it.demo.run(false);
        }
      });
    };
    checkDemos();
    window.addEventListener("scroll", checkDemos, { passive: true });
    window.addEventListener("resize", checkDemos);
    setTimeout(checkDemos, 400);
  }

  /* ---------- Pricing toggle (monthly / annual) ---------- */
  document.querySelectorAll("[data-billing-toggle]").forEach((toggle) => {
    toggle.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-period]");
      if (!btn) return;
      const period = btn.dataset.period;
      toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll("[data-price]").forEach((el) => {
        el.textContent = el.dataset[period] || el.dataset.price;
      });
      document.querySelectorAll("[data-period-label]").forEach((el) => {
        el.textContent = period === "annual" ? "/mo · billed yearly" : "/mo";
      });
    });
  });

  /* ---------- Contact form (real submit to /api/contact) ---------- */
  const form = document.querySelector("[data-pilot-form]");
  if (form) {
    const formEl = form.querySelector(".form-body");
    const errEl = form.querySelector("[data-form-error]");
    const okEl = form.querySelector("[data-form-success]");
    const submitBtn = formEl && formEl.querySelector('button[type="submit"]');
    const labelEl = submitBtn && submitBtn.querySelector("[data-btn-label]");
    const originalLabel = labelEl ? labelEl.textContent : "";

    if (formEl) {
      formEl.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (formEl.dataset.busy === "1") return;
        formEl.dataset.busy = "1";

        if (errEl) { errEl.style.display = "none"; errEl.textContent = ""; }
        if (submitBtn) submitBtn.disabled = true;
        if (labelEl) labelEl.textContent = "Sending…";

        const data = Object.fromEntries(new FormData(formEl).entries());

        try {
          const res = await fetch("/api/contact", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok || !payload.ok) throw new Error(payload.error || "HTTP " + res.status);

          formEl.style.display = "none";
          if (okEl) okEl.style.display = "block";
          window.scrollTo({ top: form.getBoundingClientRect().top + window.scrollY - 120, behavior: "smooth" });
        } catch (err) {
          if (errEl) {
            errEl.textContent = "Something went wrong sending that. Please try again in a moment.";
            errEl.style.display = "block";
          }
          if (submitBtn) submitBtn.disabled = false;
          if (labelEl) labelEl.textContent = originalLabel;
          formEl.dataset.busy = "0";
        }
      });
    }
  }

  /* ---------- FAQ accordion ---------- */
  document.querySelectorAll("[data-accordion] .faq-item").forEach((item) => {
    const q = item.querySelector(".faq-q");
    q && q.addEventListener("click", () => item.classList.toggle("open"));
  });
})();
