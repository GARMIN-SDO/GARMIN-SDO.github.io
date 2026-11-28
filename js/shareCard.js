const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1920;
const SAFE_PADDING = 32;
const renders = new WeakMap();
const imageData = new Map();

function waitForFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForImage(image) {
  if (image.hidden || !(image.currentSrc || image.src)) return;
  if (image.loading === "lazy") image.loading = "eager";
  if (!image.complete) {
    await new Promise((resolve, reject) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", () => reject(new Error(`Unable to load result image: ${image.currentSrc || image.src}`)), { once: true });
    });
  }
  if (!image.naturalWidth) throw new Error(`Result image is unavailable: ${image.currentSrc || image.src}`);
  if (typeof image.decode === "function") await image.decode();
}

async function imageDataUrl(url) {
  if (url.startsWith("data:")) return url;
  if (imageData.has(url)) return imageData.get(url);
  const pending = (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Unable to fetch share image: ${response.status}`);
        const blob = await response.blob();
        if (!blob.size) throw new Error("The share image is empty.");
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("Unable to embed the share image."));
          reader.readAsDataURL(blob);
        });
      } catch (error) {
        if (attempt === 1) throw error;
      } finally { clearTimeout(timeout); }
    }
  })();
  imageData.set(url, pending);
  try { return await pending; }
  catch (error) { imageData.delete(url); throw error; }
}

// Embed before html-to-image: its failed resource fetch can otherwise become an
// empty cached image while still returning a valid, incomplete PNG.
export async function inlineShareImages(card) {
  const runner = card.querySelector("[data-runner-image]");
  if (!runner || runner.hidden || !runner.getAttribute("src")) throw new Error("The runner illustration is missing.");
  await Promise.all([...card.querySelectorAll("img")].map(async image => {
    const url = image.currentSrc || image.src;
    image.removeAttribute("srcset");
    image.loading = "eager";
    image.src = await imageDataUrl(url);
    await waitForImage(image);
  }));
}

function sourceWidth(card) {
  // A restored allocation or language switch can export while #result is hidden.
  // Measure synchronously and restore visibility before the browser can paint.
  const hidden = [];
  for (let parent = card; parent; parent = parent.parentElement) {
    if (parent.hidden) { hidden.push(parent); parent.hidden = false; }
  }
  try { return card.getBoundingClientRect().width; }
  finally { hidden.forEach(element => { element.hidden = true; }); }
}

function removeDuplicateIds(card) {
  card.removeAttribute("id");
  card.removeAttribute("aria-labelledby");
  card.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
  card.querySelectorAll("[aria-labelledby]").forEach((element) => element.removeAttribute("aria-labelledby"));
}

async function waitForAssets(card) {
  if (document.fonts?.ready) await document.fonts.ready;
  await Promise.all([...card.querySelectorAll("img")].map(waitForImage));

  // 等待結果卡使用的台北 SVG 遮罩可讀，DOM-to-image 才能內嵌背景資源。
  const map = new Image();
  map.src = new URL("../taipei.svg", import.meta.url).href;
  await waitForImage(map);
  await waitForFrame();
  await waitForFrame();
}

export async function renderResultSharePng({ card, stage, context, root }) {
  if (!card || !stage || !context || !root) throw new Error("The shared result-card elements are missing.");
  // Freeze the requested card now, before another renderResult changes its images.
  const snapshot = card.cloneNode(true);
  const width = sourceWidth(card);
  const previous = renders.get(root) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => renderSnapshot({ snapshot, width, stage, context, root }));
  renders.set(root, pending);
  return pending;
}

async function renderSnapshot({ snapshot, width: sourceWidth, stage, context, root }) {
  const domToImage = globalThis.htmlToImage;
  if (!domToImage?.toBlob) throw new Error("The local DOM-to-image renderer is unavailable.");

  // 複製的是網站正在顯示的共用結果卡，內容和文案不另行組裝。
  root.replaceChildren(snapshot);
  root.querySelectorAll("img").forEach(image => { if (image.closest("[hidden]")) image.remove(); });
  removeDuplicateIds(root.firstElementChild);
  if (!sourceWidth) throw new Error("The visible result card has no measurable width.");
  context.style.width = `${sourceWidth}px`;
  context.style.height = "auto";
  context.style.transform = "none";
  root.style.width = "100%";
  await inlineShareImages(root);
  await waitForAssets(root);

  const cardHeight = root.firstElementChild.getBoundingClientRect().height;
  if (!cardHeight) throw new Error("The shared result card has no measurable height.");
  const scale = Math.min(
    (CARD_WIDTH - SAFE_PADDING * 2) / sourceWidth,
    (CARD_HEIGHT - SAFE_PADDING * 2) / cardHeight
  );
  context.style.height = `${cardHeight}px`;
  context.style.transform = `translate(-50%, -50%) scale(${scale})`;
  context.style.transformOrigin = "center center";
  await waitForFrame();
  await waitForFrame();

  const blob = await domToImage.toBlob(stage, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    pixelRatio: 1,
    // Static local assets can reuse the browser cache during PNG export.
    cacheBust: false,
    backgroundColor: "#080b0d",
    // 舞台在頁面上位於螢幕外；只覆寫匯出複製品，避免內容也被畫到 PNG 邊界外。
    style: {
      position: "relative",
      inset: "auto",
      left: "0px",
      top: "0px",
      right: "auto",
      bottom: "auto",
      zIndex: "auto",
      transform: "none"
    },
    skipAutoScale: true
  });
  if (!blob || blob.type !== "image/png") throw new Error("PNG generation failed.");
  return blob;
}
