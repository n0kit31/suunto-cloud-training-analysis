import { Readable } from 'node:stream';
import type { FileHandle } from 'node:fs/promises';

const head = '<head>';
const embedAssets = `<style>main > .help { display: none; }</style><script>
(() => {
  if (window.parent === window) return;
  document.documentElement.style.overflowY = 'hidden';
  document.addEventListener('DOMContentLoaded', () => {
    let previousHeight = 0;
    const sendHeight = () => {
      // The body follows the chart content. The document height also includes the viewport.
      const height = Math.ceil(document.body.getBoundingClientRect().height);
      if (height === previousHeight) return;
      previousHeight = height;
      window.parent.postMessage({ type: 'suunto-chart-height', height }, '*');
    };
    new ResizeObserver(sendHeight).observe(document.body);
    sendHeight();

    // Observe the inspector shared by stored and newly generated charts.
    const slider = document.getElementById('cursor-slider');
    const overlay = document.querySelector('[data-cursor-overlay]');
    if (!slider || !overlay) return;
    let previousTime = null;
    const sendCursor = () => {
      const time = overlay.getAttribute('visibility') === 'visible' ? Number(slider.value) : null;
      if (time === previousTime) return;
      previousTime = time;
      window.parent.postMessage({ type: 'suunto-chart-cursor', time }, '*');
    };
    const cursor = new MutationObserver(sendCursor);
    cursor.observe(slider, { attributes: true, attributeFilter: ['aria-valuetext'] });
    cursor.observe(overlay, { attributes: true, attributeFilter: ['visibility'] });
    sendCursor();
  });
})();
</script>`;

export function embedChart(html: string) {
  return html.replace(head, head + embedAssets);
}

export function streamEmbeddedChart(file: FileHandle) {
  async function* chunks() {
    let first = true;
    for await (const chunk of file.createReadStream()) {
      if (first) {
        first = false;
        // The generated chart opens its head before the styles and chart data.
        const index = chunk.indexOf(head);
        if (index !== -1) {
          const end = index + head.length;
          yield chunk.subarray(0, end);
          yield Buffer.from(embedAssets);
          yield chunk.subarray(end);
          continue;
        }
      }
      yield chunk;
    }
  }
  return Readable.from(chunks(), { objectMode: false });
}
