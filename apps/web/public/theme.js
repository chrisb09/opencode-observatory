// Runs before the stylesheet/app so theme selection does not flash on reload.
try {
  var choice = localStorage.getItem("observatory.theme");
  document.documentElement.dataset.theme = choice === "light" || choice === "dark" ? choice : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
} catch {
  document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
