// admin/assets/admin.js
document.querySelectorAll('button[name="action"]').forEach((b) => {
  b.addEventListener("click", (e) => {
    if ((b.value === "reject" || b.value === "approve") && !confirm("Confirm: " + b.value + "?")) e.preventDefault();
  });
});
