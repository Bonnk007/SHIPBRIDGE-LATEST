// Shared image handling for the Documentation module.
//
// Big phone screenshots (5–8 MB) are the usual cause of upload failures — the
// base64 payload overflows the server body limit. We cap the longest edge at
// 1600px and re-encode, which keeps diagrams and screenshots perfectly
// readable while shrinking payloads by 5–20×. Also returns the aspect ratio,
// which the docx builder needs to size the embedded image without distorting
// it. Falls back to the raw file if anything goes wrong, so behaviour never
// gets worse than not having this at all.

export async function downscaleImage(file, maxEdge = 1600, quality = 0.85) {
  const rawBase64 = await new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = rej
    r.readAsDataURL(file)
  })
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image()
      im.onload = () => res(im)
      im.onerror = rej
      im.src = rawBase64
    })
    const ratio = img.height / img.width || 0.56
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
    // Small PNGs (screenshots of text/tables) stay PNG to avoid JPEG artifacts;
    // large photos become JPEG. GIFs pass through untouched (may be animated).
    const needsResize = scale < 1
    const isGif = file.type.includes('gif')
    if (isGif || (!needsResize && file.size < 900 * 1024)) {
      return { dataUrl: rawBase64, mime: file.type, base64: rawBase64.split(',')[1], ratio }
    }
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    canvas.getContext('2d').drawImage(img, 0, 0, w, h)
    const outMime = file.type.includes('png') && file.size < 1_500_000 ? 'image/png' : 'image/jpeg'
    const dataUrl = canvas.toDataURL(outMime, quality)
    return { dataUrl, mime: outMime, base64: dataUrl.split(',')[1], ratio }
  } catch {
    return { dataUrl: rawBase64, mime: file.type, base64: rawBase64.split(',')[1], ratio: 0.56 }
  }
}

export function newImageId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}
