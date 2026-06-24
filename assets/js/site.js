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

  /* ---------- Sticky mobile CTA (show after hero, hide near footer) ---------- */
  const mobileCta = document.querySelector("[data-mobile-cta]");
  if (mobileCta) {
    const hero = document.querySelector(".hero");
    const footer = document.querySelector(".site-footer");
    const onCtaScroll = () => {
      const past = hero ? window.scrollY > hero.offsetHeight - 80 : window.scrollY > 480;
      let nearFooter = false;
      if (footer) {
        const fr = footer.getBoundingClientRect();
        nearFooter = fr.top < (window.innerHeight || 0) - 40;
      }
      mobileCta.classList.toggle("show", past && !nearFooter);
    };
    onCtaScroll();
    window.addEventListener("scroll", onCtaScroll, { passive: true });
    window.addEventListener("resize", onCtaScroll);
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

  /* ---------- Demo catalog: rotates through items on each run / replay ---------- */
  var TTR_CATALOG = [
    { img:"/assets/img/catalog/reiss",   brand:"REISS",             category:"Women's · Blouse",  size:"S",          color:"Cream",            material:"Silk-blend satin",  condition:"Excellent · gently used", flaw:"No flaws detected — verify at drop-off",  rec:"Recommend · Consign", price:"$45–$60", maxprice:"List at $58", comps:"98% of 132 recent sold comps fell in this band", conf:95, posTitle:"REISS Cream Silk-Blend Blouse — Women's S, EUC",        posDesc:"Elegant cream silk-blend blouse by REISS, size S. Excellent condition; collared V-neck, soft drape, curved hem." },
    { img:"/assets/img/catalog/tedbaker",brand:"Ted Baker",         category:"Women's · Dress",   size:"UK 10",      color:"Blush floral",     material:"Chiffon",           condition:"Very good",               flaw:"Slight pull at hem seam — review",        rec:"Recommend · Consign", price:"$38–$52", maxprice:"List at $49", comps:"98% of 87 recent sold comps fell in this band", conf:91, posTitle:"Ted Baker Floral Ruffle Dress — UK 10, VGUC",           posDesc:"Blush floral dress by Ted Baker, UK 10. Very good condition; ruffled shoulders, gathered neck, tie waist." },
    { img:"/assets/img/catalog/hobbs",   brand:"Hobbs",             category:"Women's · Blazer",  size:"US 6",       color:"Cream",            material:"Wool blend",        condition:"Excellent",               flaw:"No flaws detected — verify at drop-off",  rec:"Recommend · Consign", price:"$42–$58", maxprice:"List at $55", comps:"98% of 64 recent sold comps fell in this band", conf:93, posTitle:"Hobbs Cream Wool-Blend Blazer — US 6, EUC",             posDesc:"Tailored cream blazer by Hobbs London, US 6. Excellent condition; single-button, notch lapel, fully lined." },
    { img:"/assets/img/catalog/sandro",  brand:"Sandro",            category:"Women's · Knit polo",size:"1 (S)",     color:"Ecru stripe",      material:"Cotton knit",       condition:"Excellent",               flaw:"Light wash wear — typical",               rec:"Recommend · Consign", price:"$48–$65", maxprice:"List at $62", comps:"98% of 71 recent sold comps fell in this band", conf:92, posTitle:"Sandro Striped Knit Polo — Size 1, EUC",                posDesc:"Breton-stripe knit polo by Sandro Paris, size 1 (S). Excellent condition; button placket, ribbed trims." },
    { img:"/assets/img/catalog/polo",    brand:"Polo Ralph Lauren", category:"Kids · Sweater",    size:"L (14-16)",  color:"Navy",             material:"Cable cotton",      condition:"Very good",               flaw:"Minor pilling at cuffs — typical wear",   rec:"Recommend · Buy",     price:"$18–$24", maxprice:"List at $23", comps:"98% of 203 recent sold comps fell in this band", conf:94, posTitle:"Polo Ralph Lauren Kids Cable Sweater — L (14-16), VGUC", posDesc:"Classic navy cable-knit sweater by Polo Ralph Lauren, kids L (14-16). Very good condition; crew neck, signature pony." },
    { img:"/assets/img/catalog/tommy",   brand:"Tommy Hilfiger",    category:"Kids · Hoodie",     size:"152 · 12Y",  color:"Navy / red block", material:"Cotton fleece",     condition:"Very good",               flaw:"Faint mark near pocket — review",         rec:"Recommend · Buy",     price:"$14–$18", maxprice:"List at $17", comps:"98% of 154 recent sold comps fell in this band", conf:90, posTitle:"Tommy Hilfiger Kids Colorblock Hoodie — 12Y, VGUC",     posDesc:"Navy-white-red colorblock hoodie by Tommy Hilfiger, size 152 / 12Y. Very good condition; kangaroo pocket, logo chest." },
    { img:"/assets/img/catalog/boss",    brand:"Hugo Boss",         category:"Men's · Polo",      size:"M",          color:"Black",            material:"Cotton piqué",      condition:"Excellent",               flaw:"No flaws detected — verify at drop-off",  rec:"Recommend · Buy",     price:"$20–$26", maxprice:"List at $25", comps:"98% of 118 recent sold comps fell in this band", conf:95, posTitle:"Hugo Boss Black Piqué Polo — Men's M, EUC",             posDesc:"Black piqué polo by Hugo Boss, men's M. Excellent condition; two-button placket, tonal logo." },
    { img:"/assets/img/catalog/gant",    brand:"GANT",              category:"Men's · Oxford shirt",size:"M",        color:"Light blue",       material:"Oxford cotton",     condition:"Excellent",               flaw:"No flaws detected — verify at drop-off",  rec:"Recommend · Consign", price:"$22–$28", maxprice:"List at $27", comps:"98% of 96 recent sold comps fell in this band", conf:94, posTitle:"GANT Oxford Button-Down — Men's M, EUC",                posDesc:"Light-blue oxford button-down by GANT, men's M. Excellent condition; shield crest, classic fit." },
    { img:"/assets/img/catalog/lacoste", brand:"Lacoste",           category:"Men's · Polo",      size:"FR 4 · M",   color:"Green",            material:"Cotton piqué",      condition:"Very good",               flaw:"Slight fade at collar — review",          rec:"Recommend · Buy",     price:"$24–$30", maxprice:"List at $29", comps:"98% of 167 recent sold comps fell in this band", conf:92, posTitle:"Lacoste Green Piqué Polo — FR 4 (M), VGUC",             posDesc:"Classic green L.12.12 piqué polo by Lacoste, FR 4 (M). Very good condition; croc badge, ribbed collar." }
  ];

  class IntakeDemo {
    constructor(root) {
      this.root = root;
      this.photos = [...root.querySelectorAll(".demo-photo")];
      this.photoImgs = [...root.querySelectorAll(".demo-photo-img")];
      this.itemIdx = -1;
      this.conf = 95;
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

    nextItem() {
      if (!TTR_CATALOG.length) return;
      this.itemIdx = (this.itemIdx + 1) % TTR_CATALOG.length;
      const it = TTR_CATALOG[this.itemIdx];
      this.conf = it.conf || 94;
      const set = (k, v) => { const el = this.root.querySelector('[data-f="' + k + '"]'); if (el) el.textContent = v; };
      set("brand", it.brand); set("category", it.category); set("size", it.size);
      set("color", it.color); set("material", it.material); set("condition", it.condition);
      set("flaw", it.flaw); set("rec", it.rec); set("price", it.price);
      set("posTitle", it.posTitle); set("posDesc", it.posDesc); set("conf", this.conf + "%");
      set("maxprice", it.maxprice || ""); set("comps", it.comps || "");
      const views = ["front", "back", "tag"];
      this.photoImgs.forEach((el, i) => {
        el.style.background = "#f7f7f5 url('" + it.img + "-" + views[i] + ".jpg') center/cover no-repeat";
      });
      const nxt = TTR_CATALOG[(this.itemIdx + 1) % TTR_CATALOG.length];
      views.forEach((v) => { const im = new Image(); im.src = nxt.img + "-" + v + ".jpg"; });
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
      this.nextItem();

      if (reduce) {
        // Skip animation, show final state
        this.photos.forEach((p) => p.classList.add("captured"));
        this.fields.forEach((f) => f.classList.add("revealed"));
        this.suggestion && this.suggestion.classList.add("revealed");
        this.posBlock && this.posBlock.classList.add("revealed");
        this.approval && this.approval.classList.add("revealed");
        if (this.confBar) this.confBar.style.width = (this.conf || 94) + "%";
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
        if (this.confBar) this.confBar.style.width = Math.min(this.conf || 94, 30 + i * 9) + "%";
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
