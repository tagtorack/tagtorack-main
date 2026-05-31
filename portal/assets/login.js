// portal/assets/login.js
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = e.target.email.value.trim();
  const msg = document.getElementById("msg");
  msg.textContent = "Sending…";
  try {
    await fetch("/portal/api/login-request", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
    });
  } catch (_) {}
  msg.textContent = "If that email is registered, a sign-in link is on its way. Check your inbox.";
});
