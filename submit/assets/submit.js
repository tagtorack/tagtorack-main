/* ============================================================
   TAG TO RACK SUBMIT — consumer upload portal controller
   Pure vanilla. No frameworks.
   ============================================================ */
(function () {
  "use strict";

  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ============================================================
  // State
  // ============================================================
  const body = document.body;
  const merchantSlug = body.dataset.merchantSlug || "";
  const draftKey = `ttSubmitDraft:${merchantSlug}`;

  // In-memory photo blobs (NOT in localStorage — too big)
  const photoBlobs = {
    front: null, back: null, tag: null,
    flaw_1: null, flaw_2: null, flaw_3: null,
  };
  const photoMeta = {
    front: null, back: null, tag: null,
    flaw_1: null, flaw_2: null, flaw_3: null,
  };

  const SCREENS = ["landing", "item-details", "photos", "contact", "review", "confirmation"];
  const REQUIRED_PHOTOS = ["front", "back", "tag"];
  const MAX_LONG_EDGE = 2000;
  const JPEG_QUALITY = 0.85;

  // ============================================================
  // Merchant-data hydrate (populate categories + brand datalist)
  // ============================================================
  async function hydrateMerchant() {
    if (!merchantSlug || merchantSlug === "{{merchant.slug}}") return;
    try {
      const r = await fetch(`/submit/api/merchant?slug=${encodeURIComponent(merchantSlug)}`);
      if (!r.ok) return;
      const m = await r.json();
      const sel = $("#item_type");
      if (sel && Array.isArray(m.accepted_categories)) {
        for (const cat of m.accepted_categories) {
          const opt = document.createElement("option");
          opt.value = cat;
          opt.textContent = humanizeCategory(cat);
          sel.appendChild(opt);
        }
      }
      const dl = $("#brand-suggestions");
      if (dl && Array.isArray(m.brand_allowlist)) {
        for (const b of m.brand_allowlist) {
          const opt = document.createElement("option");
          opt.value = b;
          dl.appendChild(opt);
        }
      }
    } catch (e) {
      console.warn("merchant hydrate failed", e);
    }
  }
  function humanizeCategory(slug) {
    return String(slug || "")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  // ============================================================
  // Screen navigation
  // ============================================================
  function setScreen(name) {
    if (!SCREENS.includes(name)) return;
    body.dataset.screen = name;
    $$(".submit-screen").forEach(s => {
      const isTarget = s.dataset.screenName === name;
      s.hidden = !isTarget;
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ============================================================
  // Form state <-> localStorage
  // ============================================================
  function readDraft() {
    try { return JSON.parse(localStorage.getItem(draftKey) || "{}"); }
    catch { return {}; }
  }
  function writeDraft(patch) {
    const cur = readDraft();
    localStorage.setItem(draftKey, JSON.stringify({ ...cur, ...patch }));
  }
  function clearDraft() { localStorage.removeItem(draftKey); }

  // After a successful submission: keep contact for "submit another", drop item+photos.
  function resetForNextItem() {
    const d = readDraft();
    localStorage.setItem(draftKey, JSON.stringify({ contact: d.contact || {} })); // keep contact, drop item
    for (const k of Object.keys(photoBlobs)) photoBlobs[k] = null;
    for (const k of Object.keys(photoMeta)) photoMeta[k] = null;
  }

  function rehydrateForms() {
    const d = readDraft();
    if (d.item) {
      const itemForm = $("#item-form");
      if (itemForm) {
        for (const [k, v] of Object.entries(d.item)) {
          const el = itemForm.elements[k];
          if (!el) continue;
          if (el.type === "radio") {
            const radios = itemForm.querySelectorAll(`[name="${k}"]`);
            radios.forEach(r => { if (r.value === v) r.checked = true; });
          } else {
            el.value = v;
          }
        }
      }
    }
    if (d.contact) {
      const cf = $("#contact-form");
      if (cf) {
        for (const [k, v] of Object.entries(d.contact)) {
          const el = cf.elements[k];
          if (!el) continue;
          if (el.type === "checkbox") el.checked = !!v;
          else el.value = v;
        }
      }
    }
  }

  function snapshotForm(form) {
    if (!form) return {};
    const data = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === "checkbox") data[el.name] = el.checked;
      else if (el.type === "radio") { if (el.checked) data[el.name] = el.value; }
      else data[el.name] = el.value;
    }
    return data;
  }

  // ============================================================
  // Photo capture + canvas resize (strips EXIF as a side effect)
  // ============================================================
  // HEIC support: iPhones save .heic, which browsers can't decode into an <img>.
  // Lazy-load a converter (only when a HEIC is actually picked) and turn it into a
  // JPEG blob before the canvas step. heic2any is vendored at /submit/assets.
  let _heicLoader = null;
  function ensureHeic2any() {
    if (window.heic2any) return Promise.resolve(window.heic2any);
    if (_heicLoader) return _heicLoader;
    _heicLoader = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/submit/assets/heic2any.min.js";
      s.onload = () => (window.heic2any ? resolve(window.heic2any) : reject(new Error("heic_lib_missing")));
      s.onerror = () => reject(new Error("heic_lib_load_failed"));
      document.head.appendChild(s);
    });
    return _heicLoader;
  }
  function isHeic(file) {
    const t = (file.type || "").toLowerCase();
    if (t === "image/heic" || t === "image/heif") return true;
    return /\.hei[cf]$/i.test(file.name || ""); // iOS often reports an empty MIME type
  }
  async function maybeConvertHeic(file) {
    if (!isHeic(file)) return file;
    const heic2any = await ensureHeic2any();
    const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
    const jpeg = Array.isArray(out) ? out[0] : out;
    const base = (file.name || "photo").replace(/\.hei[cf]$/i, "");
    return new File([jpeg], base + ".jpg", { type: "image/jpeg" });
  }

  async function resizeToBlob(file) {
    file = await maybeConvertHeic(file);
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const longEdge = Math.max(img.width, img.height);
        const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error("encode_failed"));
            resolve({ blob, width: w, height: h });
          },
          "image/jpeg", JPEG_QUALITY
        );
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode_failed")); };
      img.src = url;
    });
  }

  function bindPhotoSlots() {
    $$(".photo-slot").forEach(slot => {
      const input = slot.querySelector('input[type="file"]');
      if (!input) return;
      input.addEventListener("change", async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const role = slot.dataset.role;
        const ord  = slot.dataset.flawOrd ? Number(slot.dataset.flawOrd) : 1;
        const key  = (role === "flaw") ? `flaw_${ord}` : role;
        try {
          const { blob, width, height } = await resizeToBlob(file);
          photoBlobs[key] = blob;
          photoMeta[key] = {
            role,
            ord,
            content_type: blob.type || "image/jpeg",
            byte_size: blob.size,
            width, height,
            client_stripped_exif: true,
          };
          renderPhotoSlot(slot, blob);
          updatePhotosNext();
          maybeShowAddFlaw();
        } catch (err) {
          console.error("resize failed", err);
          const msg = String((err && err.message) || err);
          if (msg.indexOf("heic") !== -1) {
            alert("We couldn't convert that iPhone (HEIC) photo. Please try again — or in iPhone Settings → Camera → Formats, choose “Most Compatible” and re-take it.");
          } else {
            alert("Couldn't read that photo. Please use a JPG or PNG (a screenshot of the photo also works).");
          }
        } finally {
          input.value = "";
        }
      });
    });

    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".photo-remove");
      if (!btn) return;
      e.preventDefault();
      const slot = btn.closest(".photo-slot");
      if (!slot) return;
      const role = slot.dataset.role;
      const ord  = slot.dataset.flawOrd ? Number(slot.dataset.flawOrd) : 1;
      const key  = (role === "flaw") ? `flaw_${ord}` : role;
      photoBlobs[key] = null;
      photoMeta[key] = null;
      resetPhotoSlot(slot);
      updatePhotosNext();
    });

    const addBtn = $("#add-flaw");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        const existing = $$(".photo-slot[data-role='flaw']");
        const nextOrd = existing.length + 1;
        if (nextOrd > 3) return;
        const grid = $(".photo-grid");
        const tpl = existing[0].cloneNode(true);
        tpl.dataset.flawOrd = String(nextOrd);
        const input = tpl.querySelector('input[type="file"]');
        if (input) { input.name = `photo_flaw_${nextOrd}`; input.value = ""; }
        resetPhotoSlot(tpl);
        grid.appendChild(tpl);
        if (nextOrd >= 3) addBtn.hidden = true;
        const newInput = tpl.querySelector('input[type="file"]');
        if (newInput) {
          newInput.addEventListener("change", async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const key = `flaw_${nextOrd}`;
            try {
              const { blob, width, height } = await resizeToBlob(file);
              photoBlobs[key] = blob;
              photoMeta[key] = {
                role: "flaw", ord: nextOrd,
                content_type: blob.type || "image/jpeg",
                byte_size: blob.size, width, height, client_stripped_exif: true,
              };
              renderPhotoSlot(tpl, blob);
              updatePhotosNext();
            } catch (err) {
              console.error("resize failed", err);
              const msg = String((err && err.message) || err);
              if (msg.indexOf("heic") !== -1) {
                alert("We couldn't convert that iPhone (HEIC) photo. Please try again — or in iPhone Settings → Camera → Formats, choose “Most Compatible” and re-take it.");
              } else {
                alert("Couldn't read that photo. Please use a JPG or PNG (a screenshot of the photo also works).");
              }
            }
          });
        }
      });
    }
  }

  function renderPhotoSlot(slot, blob) {
    const empty = slot.querySelector(".photo-slot-empty");
    const filled = slot.querySelector(".photo-slot-filled");
    const img = filled.querySelector(".photo-thumb");
    img.src = URL.createObjectURL(blob);
    empty.hidden = true;
    filled.hidden = false;
  }
  function resetPhotoSlot(slot) {
    const empty = slot.querySelector(".photo-slot-empty");
    const filled = slot.querySelector(".photo-slot-filled");
    const img = filled && filled.querySelector(".photo-thumb");
    if (img && img.src) { try { URL.revokeObjectURL(img.src); } catch (_) {} img.removeAttribute("src"); }
    if (empty) empty.hidden = false;
    if (filled) filled.hidden = true;
  }
  function maybeShowAddFlaw() {
    const flaws = Object.keys(photoBlobs).filter(k => k.startsWith("flaw_") && photoBlobs[k]).length;
    const allRequired = REQUIRED_PHOTOS.every(r => photoBlobs[r]);
    const addBtn = $("#add-flaw");
    if (!addBtn) return;
    if (allRequired && flaws >= 1 && flaws < 3) addBtn.hidden = false;
    else if (flaws >= 3) addBtn.hidden = true;
  }
  function updatePhotosNext() {
    const ok = REQUIRED_PHOTOS.every(r => photoBlobs[r]);
    const btn = $("#photos-next");
    if (btn) btn.disabled = !ok;
  }

  // ============================================================
  // Validation
  // ============================================================
  function validateForm(formId) {
    const form = $("#" + formId);
    if (!form) return true;
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === "radio") {
        const group = form.querySelectorAll(`[name="${el.name}"]`);
        const any = Array.from(group).some(r => r.checked);
        if (!any && el.required) {
          el.focus();
          alert("Pick the closest condition.");
          return false;
        }
      } else if (typeof el.checkValidity === "function" && !el.checkValidity()) {
        el.focus();
        el.reportValidity();
        return false;
      }
    }
    return true;
  }

  // ============================================================
  // Review screen population (no innerHTML; safe DOM only)
  // ============================================================
  function clearChildren(node) { if (node) node.replaceChildren(); }
  function addRow(dl, label, value) {
    if (value == null || value === "") return;
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value;
    dl.appendChild(dt); dl.appendChild(dd);
  }

  function populateReview() {
    const item = snapshotForm($("#item-form"));
    const contact = snapshotForm($("#contact-form"));

    const itemDl = $("#review-item");
    clearChildren(itemDl);
    addRow(itemDl, "Type",      item.item_type ? humanizeCategory(item.item_type) : "");
    addRow(itemDl, "Brand",     item.brand);
    addRow(itemDl, "Size",      item.size);
    addRow(itemDl, "Asking",    item.asking_price ? `$${item.asking_price}` : "");
    addRow(itemDl, "Condition", item.condition ? humanizeCategory(item.condition) : "");
    if (item.notes) addRow(itemDl, "Notes", item.notes);

    const photoDiv = $("#review-photos");
    clearChildren(photoDiv);
    Object.entries(photoBlobs).forEach(([key, blob]) => {
      if (!blob) return;
      const img = document.createElement("img");
      img.src = URL.createObjectURL(blob);
      img.alt = key;
      photoDiv.appendChild(img);
    });

    const contactDl = $("#review-contact");
    clearChildren(contactDl);
    addRow(contactDl, "Name",  contact.name);
    addRow(contactDl, "Email", contact.email);
    addRow(contactDl, "Phone", contact.phone);
    addRow(contactDl, "Zip",   contact.zip);
  }

  // ============================================================
  // Submit flow
  // ============================================================
  function setUploadProgress(pct, msg) {
    const status = $("#upload-status");
    const bar = $("#upload-progress-bar");
    const m = $("#upload-message");
    if (!status || !bar || !m) return;
    status.hidden = false;
    bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
    if (msg) m.textContent = msg;
  }
  function showSubmitError(msg) {
    const err = $("[data-form-error]");
    if (err) { err.textContent = msg; err.hidden = false; }
    const status = $("#upload-status");
    if (status) status.hidden = true;
    const btn = $("#submit-btn");
    if (btn) { btn.disabled = false; }
  }

  async function doSubmit() {
    const btn = $("#submit-btn");
    if (btn) btn.disabled = true;
    const err = $("[data-form-error]");
    if (err) err.hidden = true;

    const item = snapshotForm($("#item-form"));
    const contact = snapshotForm($("#contact-form"));

    // Honeypot check (also enforced server-side)
    if (contact.website) {
      const cid = $("#confirmation-id"); if (cid) cid.textContent = "—";
      setScreen("confirmation");
      return;
    }

    // Turnstile is optional (server skips verification when TURNSTILE_SECRET is
    // unset). Only require a token when a real sitekey was injected, so local /
    // unconfigured environments can still submit.
    const tsWidget = document.querySelector(".cf-turnstile");
    const tsConfigured =
      tsWidget &&
      tsWidget.dataset.sitekey &&
      tsWidget.dataset.sitekey !== "{{TURNSTILE_SITE_KEY}}";
    const turnstile = document.querySelector('[name="cf-turnstile-response"]');
    const turnstileToken = turnstile ? turnstile.value : "";
    if (tsConfigured && !turnstileToken.trim()) {
      showSubmitError("Please complete the security check, then tap Submit again.");
      return;
    }

    const declaredPhotos = Object.entries(photoMeta)
      .filter((entry) => entry[1])
      .map((entry) => {
        const m = entry[1];
        return {
          role: m.role, ord: m.ord,
          content_type: m.content_type,
          byte_size: m.byte_size,
          width: m.width, height: m.height,
        };
      });

    setUploadProgress(5, "Reserving slot");

    let startResp;
    try {
      const r = await fetch("/submit/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant_slug: merchantSlug,
          item: {
            item_type: item.item_type, brand: item.brand, size: item.size,
            asking_price_usd: item.asking_price ? Number(item.asking_price) : null,
            declared_condition: item.condition,
            notes: item.notes,
          },
          contact: {
            name: contact.name, email: contact.email,
            phone: contact.phone || null, zip: contact.zip || null,
            consent_marketing: !!contact.consent_marketing,
          },
          photo_declarations: declaredPhotos,
          turnstile_token: turnstileToken,
          honeypot: contact.website || "",
        }),
      });
      if (r.status === 409) { showSubmitError("Looks like you've already submitted this item. Check your email for the confirmation."); return; }
      if (r.status === 429) { showSubmitError("Too many submissions today. Try again tomorrow."); return; }
      if (!r.ok) throw new Error(`start_failed_${r.status}`);
      startResp = await r.json();
    } catch (e) {
      console.error(e);
      showSubmitError("We couldn't start your submission. Check your connection and try again.");
      return;
    }

    const submission_id = startResp.submission_id;
    const short_id = startResp.short_id;
    const upload_urls = startResp.upload_urls;
    if (!submission_id || !Array.isArray(upload_urls) || upload_urls.length === 0) {
      showSubmitError("Server replied with an unexpected response. Try again.");
      return;
    }

    const total = upload_urls.length;
    let done = 0;
    for (const u of upload_urls) {
      const key = (u.role === "flaw") ? `flaw_${u.ord || 1}` : u.role;
      const blob = photoBlobs[key];
      if (!blob) {
        showSubmitError(`Missing photo for ${u.role}. Go back and re-take it.`);
        return;
      }
      try {
        setUploadProgress(10 + (done / total) * 70, `Uploading ${u.role}`);
        const putRes = await fetch(u.put_url, {
          method: "PUT",
          headers: { "Content-Type": blob.type || "image/jpeg" },
          body: blob,
        });
        if (!putRes.ok) throw new Error(`put_failed_${putRes.status}`);
        await fetch("/submit/api/photo-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            submission_id,
            r2_key: u.r2_key,
            content_type: blob.type || "image/jpeg",
            byte_size: blob.size,
            width: photoMeta[key].width,
            height: photoMeta[key].height,
            client_stripped_exif: true,
          }),
        });
        done++;
      } catch (e) {
        console.error("photo upload failed", e);
        showSubmitError(`Photo upload failed (${u.role}). Tap Submit to retry.`);
        return;
      }
    }

    setUploadProgress(85, "Finalizing");
    try {
      const r = await fetch("/submit/api/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submission_id }),
      });
      if (!r.ok) throw new Error(`finalize_failed_${r.status}`);
      const fin = await r.json();
      setUploadProgress(100, "Done");
      const cid = $("#confirmation-id");
      if (cid) cid.textContent = fin.short_id || short_id || submission_id.slice(0, 8);
      if (fin.status_token) {
        const link = $("#status-link");
        const wrap = $("#status-link-wrap");
        if (link && wrap) { link.href = "/submit/status?s=" + encodeURIComponent(fin.status_token); wrap.hidden = false; }
      }
      resetForNextItem(); // keep contact for "submit another", drop item+photos
      setScreen("confirmation");
    } catch (e) {
      console.error(e);
      showSubmitError("Submission almost made it but finalize failed. Tap Submit to retry.");
    }
  }

  // ============================================================
  // Event wiring
  // ============================================================
  function bindNav() {
    document.addEventListener("click", (e) => {
      const another = e.target.closest("#submit-another");
      if (another) {
        // In-place "submit another item": contact already preserved by resetForNextItem();
        // clear the item form in the DOM, re-hydrate contact from the draft, jump to step 1.
        e.preventDefault();
        const itf = $("#item-form"); if (itf && typeof itf.reset === "function") itf.reset();
        rehydrateForms();
        window.scrollTo(0, 0);
        setScreen("item-details");
        return;
      }
      const next = e.target.closest("[data-next]");
      const back = e.target.closest("[data-back]");
      if (next) {
        const validateId = next.dataset.validate;
        if (validateId && !validateForm(validateId)) return;
        if (body.dataset.screen === "item-details") {
          writeDraft({ item: snapshotForm($("#item-form")) });
        }
        if (body.dataset.screen === "contact") {
          const c = snapshotForm($("#contact-form"));
          delete c.website;
          writeDraft({ contact: c });
        }
        if (next.dataset.next === "review") populateReview();
        setScreen(next.dataset.next);
        return;
      }
      if (back) {
        setScreen(back.dataset.back);
        return;
      }
    });

    const submitBtn = $("#submit-btn");
    if (submitBtn) submitBtn.addEventListener("click", doSubmit);

    document.addEventListener("change", (e) => {
      const t = e.target;
      if (!t || !t.form) return;
      if (t.form.id === "item-form") {
        writeDraft({ item: snapshotForm(t.form) });
      } else if (t.form.id === "contact-form") {
        const c = snapshotForm(t.form);
        delete c.website;
        writeDraft({ contact: c });
      }
    });
  }

  // ============================================================
  // Boot
  // ============================================================
  document.addEventListener("DOMContentLoaded", () => {
    hydrateMerchant();
    bindPhotoSlots();
    bindNav();
    rehydrateForms();
    updatePhotosNext();
    // Inline-handler refactor (lets the portal ship a strict script-src CSP — no inline JS):
    const mlogo = $(".merchant-logo");
    if (mlogo) mlogo.addEventListener("error", () => { mlogo.style.display = "none"; });
    const again = $("#submit-another");
    if (again) again.addEventListener("click", clearDraft);
    const hash = (location.hash || "").match(/^#screen=([\w-]+)$/);
    if (hash && SCREENS.includes(hash[1])) setScreen(hash[1]);
  });
})();
