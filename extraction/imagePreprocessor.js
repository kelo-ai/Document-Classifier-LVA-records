// imagePreprocessor.js
// Image preprocessing techniques applied before OCR to improve Tesseract's
// recognition accuracy. All done via raw pixel manipulation on the rendered
// canvas — no extra native dependencies beyond @napi-rs/canvas, which is
// already required for PDF page rendering.
//
// These are standard, well-established OCR preprocessing steps:
// grayscale -> contrast stretch -> denoise -> binarize (thresholding).

/**
 * Convert an image to grayscale using the standard luminance formula.
 * Removes color as a variable, which Tesseract doesn't need and which can
 * sometimes confuse recognition on tinted/scanned backgrounds.
 */
function toGrayscale(imageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = gray;
  }
  return imageData;
}

/**
 * Contrast stretching: rescales pixel intensities to use the full 0-255
 * range based on the image's actual min/max, making faint text darker
 * and washed-out backgrounds brighter.
 */
function stretchContrast(imageData) {
  const d = imageData.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < min) min = d[i];
    if (d[i] > max) max = d[i];
  }
  const range = max - min || 1;
  for (let i = 0; i < d.length; i += 4) {
    const stretched = ((d[i] - min) / range) * 255;
    d[i] = d[i + 1] = d[i + 2] = stretched;
  }
  return imageData;
}

/**
 * Simple 3x3 median-style denoise (salt-and-pepper noise reduction) —
 * common in scanned documents from low-quality scanners/photos.
 * Operates on the grayscale channel only.
 */
function denoise(imageData, width, height) {
  const d = imageData.data;
  const copy = Uint8ClampedArray.from(d);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const neighbors = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const idx = ((y + dy) * width + (x + dx)) * 4;
          neighbors.push(copy[idx]);
        }
      }
      neighbors.sort((a, b) => a - b);
      const median = neighbors[4]; // middle of 9 values
      const idx = (y * width + x) * 4;
      d[idx] = d[idx + 1] = d[idx + 2] = median;
    }
  }
  return imageData;
}

/**
 * Binarization (thresholding): converts grayscale to pure black/white using
 * Otsu's method to automatically pick the best threshold — this is the
 * single biggest accuracy improvement for scanned/photographed text, since
 * it removes background shading and shadows entirely.
 */
function otsuThreshold(imageData) {
  const d = imageData.data;
  const histogram = new Array(256).fill(0);
  const totalPixels = d.length / 4;

  for (let i = 0; i < d.length; i += 4) {
    histogram[d[i]]++;
  }

  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = 0;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = totalPixels - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;

    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }

  for (let i = 0; i < d.length; i += 4) {
    const value = d[i] >= threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = value;
  }
  return imageData;
}

/**
 * Full preprocessing pipeline for a canvas before running OCR.
 * mode: 'high' runs the full pipeline (grayscale -> contrast -> denoise -> binarize).
 *       'low' only grayscales + stretches contrast — faster, lighter touch.
 * Mutates and returns the canvas in place.
 */
function preprocessCanvas(canvas, mode = 'low') {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  let imageData = ctx.getImageData(0, 0, width, height);

  imageData = toGrayscale(imageData);
  imageData = stretchContrast(imageData);

  if (mode === 'high') {
    imageData = denoise(imageData, width, height);
    imageData = otsuThreshold(imageData);
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

module.exports = { preprocessCanvas, toGrayscale, stretchContrast, denoise, otsuThreshold };
