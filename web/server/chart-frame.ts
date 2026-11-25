import { Readable } from 'node:stream';
import type { FileHandle } from 'node:fs/promises';

const head = '<head>';
const resizeScript = `<script>
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
  });
})();
</script>`;

export function embedChart(html: string) {
  return html.replace(head, head + resizeScript);
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
          yield Buffer.from(resizeScript);
          yield chunk.subarray(end);
          continue;
        }
      }
      yield chunk;
    }
  }
  return Readable.from(chunks(), { objectMode: false });
}
