/* =========================================================
   fx.js
   Confetti / emoji rain and the hidden easter eggs.
   Everything here is decorative and skipped when the device
   asks for reduced motion.
   ========================================================= */
window.FX = (function () {
  function layer() {
    let l = document.getElementById("fxLayer");
    if (!l) {
      l = document.createElement("div");
      l.id = "fxLayer";
      l.setAttribute("aria-hidden", "true");
      document.body.appendChild(l);
    }
    return l;
  }

  function confetti(n) {
    if (UI.reducedMotion()) return;
    const l = layer();
    for (let i = 0; i < n; i++) {
      const s = document.createElement("span");
      s.className = "fx-confetti";
      s.style.left = Math.random() * 100 + "vw";
      s.style.background = `hsl(${Math.floor(Math.random() * 360)} 90% 60%)`;
      s.style.animationDuration = 1.6 + Math.random() * 1.4 + "s";
      s.style.animationDelay = Math.random() * 0.3 + "s";
      l.appendChild(s);
      setTimeout(() => s.remove(), 3400);
    }
  }

  function emojiRain(emoji) {
    if (UI.reducedMotion()) return;
    const l = layer();
    for (let i = 0; i < 36; i++) {
      const s = document.createElement("span");
      s.className = "fx-emoji";
      s.textContent = emoji;
      s.style.left = Math.random() * 100 + "vw";
      s.style.fontSize = 18 + Math.random() * 22 + "px";
      s.style.animationDuration = 2 + Math.random() * 2 + "s";
      s.style.animationDelay = Math.random() * 0.6 + "s";
      l.appendChild(s);
      setTimeout(() => s.remove(), 4800);
    }
  }

  function initEggs() {
    // 1) Konami code -> confetti
    const konami = [
      "ArrowUp",
      "ArrowUp",
      "ArrowDown",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowLeft",
      "ArrowRight",
      "b",
      "a",
    ];
    let k = 0;
    document.addEventListener("keydown", (e) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === konami[k]) {
        k++;
        if (k === konami.length) {
          k = 0;
          confetti(160);
          UI.toast("Konami!");
        }
      } else {
        k = key === konami[0] ? 1 : 0;
      }
    });

    // 2) Tap the logo five times -> party colours
    let taps = 0;
    let tapTimer = null;
    const brand = document.querySelector(".brand");
    if (brand) {
      brand.addEventListener("click", () => {
        taps++;
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => (taps = 0), 1200);
        if (taps >= 5) {
          taps = 0;
          document.body.classList.toggle("rainbow");
          confetti(60);
        }
      });
    }

    // 3) Certain guesses -> emoji rain
    const magic = { hello: "👋", loved: "❤️", pizza: "🍕", happy: "😄", magic: "✨", party: "🥳" };
    document.addEventListener("wordlex:guess", (e) => {
      const w = String((e.detail && e.detail.word) || "").toLowerCase();
      if (magic[w]) emojiRain(magic[w]);
    });
  }

  return { confetti, emojiRain, initEggs };
})();
