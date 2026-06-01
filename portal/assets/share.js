// Store Portal — "Share your store" card: copy the seller link + render a
// printable QR. Uses the vendored global `qrcode` (qrcode.js). No innerHTML,
// no inline script (portal CSP is script-src 'self').
(function () {
  function onReady(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }
  onReady(function () {
    var link = document.getElementById("share-link");
    var copyBtn = document.getElementById("copy-link");
    var msg = document.getElementById("copy-msg");

    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        var value = copyBtn.getAttribute("data-link") || (link && link.value) || "";
        var done = function () { if (msg) msg.textContent = "Link copied to clipboard."; };
        var fallback = function () {
          if (link) {
            link.removeAttribute("readonly");
            link.focus(); link.select();
            try { document.execCommand("copy"); } catch (e) {}
            link.setAttribute("readonly", "");
          }
          if (msg) msg.textContent = "Link selected — press Ctrl/⌘-C to copy.";
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value).then(done, fallback);
        } else { fallback(); }
      });
    }

    var box = document.getElementById("qr");
    if (box && typeof qrcode === "function") {
      try {
        var url = box.getAttribute("data-link") || "";
        var qr = qrcode(0, "M");          // type 0 = auto-size, error-correction M
        qr.addData(url);
        qr.make();

        // Preview: raster data-URL into a created <img> (no innerHTML).
        var img = document.createElement("img");
        img.src = qr.createDataURL(6, 1); // cellSize, margin -> gif data URL
        img.alt = "QR code for your store's seller link";
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.imageRendering = "pixelated";
        box.appendChild(img);

        // Download: crisp, scalable SVG (best for printed "scan to sell" signage).
        var dl = document.getElementById("qr-download");
        if (dl) {
          var svg = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
          dl.href = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        }
      } catch (e) { /* QR is optional; the link + copy still work */ }
    }
  });
})();
