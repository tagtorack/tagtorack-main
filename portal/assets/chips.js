// portal/assets/chips.js — minimal tag/chip editor.
// Markup contract (rendered server-side):
//   <div class="chips" data-name="brand_allowlist">
//     <span class="chip">Patagonia<button type="button" aria-label="remove">×</button></span> ...
//     <input class="chip-entry" type="text" placeholder="type and press Enter">
//   </div>
//   <input type="hidden" name="brand_allowlist" value="Patagonia,Levi's">
// chips.js keeps the hidden input's comma-joined value in sync.
(function () {
  function valuesOf(box) {
    return [...box.querySelectorAll(".chip")].map((c) => c.firstChild.textContent.trim()).filter(Boolean);
  }
  function sync(box) {
    const hidden = document.querySelector('input[type=hidden][name="' + box.dataset.name + '"]');
    if (hidden) hidden.value = valuesOf(box).join(",");
  }
  function addChip(box, text) {
    text = (text || "").trim();
    if (!text) return;
    if (valuesOf(box).some((v) => v.toLowerCase() === text.toLowerCase())) return; // dedupe
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.appendChild(document.createTextNode(text));
    const x = document.createElement("button");
    x.type = "button"; x.setAttribute("aria-label", "remove"); x.textContent = "×";
    x.addEventListener("click", function () { chip.remove(); sync(box); });
    chip.appendChild(x);
    const entry = box.querySelector(".chip-entry");
    box.insertBefore(chip, entry);
    sync(box);
  }
  document.querySelectorAll(".chips").forEach(function (box) {
    box.querySelectorAll(".chip button").forEach(function (x) {
      x.addEventListener("click", function () { x.parentElement.remove(); sync(box); });
    });
    const entry = box.querySelector(".chip-entry");
    if (entry) {
      entry.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addChip(box, entry.value); entry.value = ""; }
      });
      entry.addEventListener("blur", function () { addChip(box, entry.value); entry.value = ""; });
    }
    sync(box);
  });
  // category quick-add buttons: <button class="quick" data-target="categories_accepted" data-val="denim">
  document.querySelectorAll("button.quick").forEach(function (b) {
    b.addEventListener("click", function () {
      const box = document.querySelector('.chips[data-name="' + b.dataset.target + '"]');
      if (box) addChip(box, b.dataset.val);
    });
  });
})();
