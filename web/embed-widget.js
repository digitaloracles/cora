// Embed agent (NOT-117), floating: a button in the corner of someone else's page that opens the agent's chat.
// Served by /embed/<token>/widget.js with the chat's settings in place of the placeholder below.
(function () {
  var C = /*CONFIG*/{};
  // The same rule as the chat's frame-ancestors: on a site the owner did not list, the chat would open empty, so no button at all.
  function allowedHere(domains) {
    if (!domains.length || location.origin === origin) return true;
    var host = location.host.toLowerCase();
    return domains.some(function (domain) {
      if (domain.indexOf("localhost") !== 0 && location.protocol !== "https:") return false;
      if (domain.slice(0, 2) !== "*.") return host === domain;
      var base = domain.slice(1);
      return host.length > base.length && host.slice(-base.length) === base;
    });
  }
  var script = document.currentScript;
  var origin = script && script.src ? new URL(script.src).origin : "";
  if (!origin || !C.path || !allowedHere(C.domains || [])) return;
  var registry = (window.__coraEmbeds = window.__coraEmbeds || {});
  if (registry[C.path]) return;
  registry[C.path] = true;
  var lang = (navigator.language || "").toLowerCase().slice(0, 2);
  var T = { it: ["Chatta con ", "Chiudi la chat"], es: ["Chatea con ", "Cerrar el chat"], de: ["Chatte mit ", "Chat schließen"] }[lang] || ["Chat with ", "Close the chat"];
  function luminance(hex) {
    return [1, 3, 5].map(function (i) { var c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); })
      .reduce(function (sum, c, i) { return sum + c * [0.2126, 0.7152, 0.0722][i]; }, 0);
  }
  var accent = /^#[0-9a-f]{6}$/i.test(C.accent || "") ? C.accent : "#264cd6";
  var onAccent = luminance(accent) > 0.45 ? "#0f1a3d" : "#ffffff";
  var host = document.createElement("div");
  host.setAttribute("data-cora-embed", "");
  host.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;z-index:2147483000;";
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  root.innerHTML = "<style>" +
    ":host{all:initial}" +
    ".launch{position:fixed;right:20px;bottom:20px;width:60px;height:60px;padding:0;border:0;border-radius:50%;background:" + accent + ";color:" + onAccent + ";cursor:pointer;display:grid;place-items:center;box-shadow:0 6px 20px rgba(15,26,61,.22),0 1px 3px rgba(15,26,61,.18);transition:transform .15s ease}" +
    ".launch:hover{transform:scale(1.05)}" +
    ".launch:focus-visible{outline:3px solid " + accent + ";outline-offset:3px}" +
    ".launch img{width:52px;height:52px;border-radius:50%;display:block}" +
    ".launch svg{width:26px;height:26px;display:none}" +
    ".open .launch img{display:none}.open .launch svg{display:block}" +
    ".launch img[hidden]+svg.chat{display:block}" +
    ".frame{position:fixed;right:20px;bottom:92px;width:380px;height:min(620px,calc(100vh - 116px));border-radius:18px;overflow:hidden;background:#fff;box-shadow:0 12px 40px rgba(15,26,61,.24),0 2px 6px rgba(15,26,61,.12);opacity:0;transform:translateY(12px);pointer-events:none;visibility:hidden;transition:opacity .18s ease,transform .18s ease,visibility 0s .18s}" +
    ".open .frame{opacity:1;transform:none;pointer-events:auto;visibility:visible;transition:opacity .18s ease,transform .18s ease}" +
    ".frame iframe{width:100%;height:100%;border:0;display:block}" +
    "@media (max-width:520px){.frame{right:0;bottom:0;width:100vw;height:100vh;height:100dvh;border-radius:0}.open .launch{display:none}}" +
    "@media (prefers-reduced-motion:reduce){.launch,.frame,.open .frame{transition:none}}" +
    "</style>" +
    "<div class=\"wrap\"><div class=\"frame\" role=\"dialog\"></div>" +
    "<button type=\"button\" class=\"launch\" aria-expanded=\"false\"><img alt=\"\">" +
    "<svg class=\"chat\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z\"/></svg>" +
    "<svg class=\"close\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M6 6l12 12M18 6L6 18\"/></svg></button></div>";
  var wrap = root.querySelector(".wrap"), frame = root.querySelector(".frame"), launch = root.querySelector(".launch"), face = launch.querySelector("img");
  var chatIcon = launch.querySelector(".chat"), closeIcon = launch.querySelector(".close");
  chatIcon.style.display = "none";
  face.addEventListener("error", function () { face.hidden = true; chatIcon.style.display = ""; });
  face.src = origin + C.avatar;
  frame.setAttribute("aria-label", T[0] + C.name);
  launch.setAttribute("aria-label", T[0] + C.name);
  var iframe = null, open = false;
  function set(next) {
    open = next;
    if (open && !iframe) {
      iframe = document.createElement("iframe");
      iframe.title = T[0] + C.name;
      iframe.allow = "clipboard-write";
      iframe.src = origin + C.path + "?floating=1";
      frame.appendChild(iframe);
    }
    wrap.classList.toggle("open", open);
    launch.setAttribute("aria-expanded", String(open));
    launch.setAttribute("aria-label", open ? T[1] : T[0] + C.name);
    closeIcon.style.display = open ? "block" : "none";
    if (!open) chatIcon.style.display = face.hidden ? "" : "none";
    else chatIcon.style.display = "none";
    if (!open) launch.focus({ preventScroll: true });
  }
  closeIcon.style.display = "none";
  launch.addEventListener("click", function () { set(!open); });
  document.addEventListener("keydown", function (event) { if (open && event.key === "Escape") set(false); });
  window.addEventListener("message", function (event) {
    if (event.origin === origin && event.data && event.data.type === "cora-embed-close" && iframe && event.source === iframe.contentWindow) set(false);
  });
  (document.body || document.documentElement).appendChild(host);
})();
